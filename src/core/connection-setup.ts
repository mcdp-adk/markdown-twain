// The Connection setup: the guided steps that replace the LLM connection. It
// decides every step and applies what the steps change; the adapter shows the
// prompts through a Prompter and provides storage and feedback.

import {
  type ConnectionDeps,
  ConnectionFailure,
  type ConnectionSettings,
  keySource,
  openConnection,
} from "./connection.ts";
import {
  CUSTOM_PROVIDER_ID,
  PROVIDER_PRESETS,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "./providers.ts";

/** A key picked during setup, in place of the saved key or the environment. */
export type KeyChoice =
  | { kind: "saved" }
  | { kind: "new"; value: string }
  | { kind: "env"; name: string }
  | { kind: "none" };

export type StepResult<T> = { kind: "selected"; value: T } | { kind: "back" } | { kind: "cancel" };

export interface Choice<T> {
  label: string;
  detail?: string;
  value: T;
  /** The item holding the current setting. */
  current?: boolean;
  /** The item standing for a saved key, which is never shown. */
  masked?: boolean;
}

export interface StepOptions {
  title: string;
  step?: number;
  totalSteps?: number;
  canBack?: boolean;
  placeHolder?: string;
}

export interface InputOptions extends StepOptions {
  value?: string;
  password?: boolean;
  /** An empty value can't be accepted. */
  required?: boolean;
}

/** Shows one prompt and answers with the user's choice, Back, or cancel. Input values come trimmed. */
export interface Prompter {
  pick<T>(items: Choice<T>[], options: StepOptions, active?: Choice<T>): Promise<StepResult<T>>;
  input(options: InputOptions): Promise<StepResult<string>>;
}

/** The changes produced by a finished prompt; completion applies the key first. */
interface SetupResult {
  settings: Partial<ConnectionSettings>;
  secret?: { kind: "store"; name: string; value: string } | { kind: "delete"; name: string };
}

export interface ConnectionSetupDeps extends ConnectionDeps {
  settings: () => ConnectionSettings;
  updateSetting: <K extends keyof ConnectionSettings>(
    field: K,
    value: ConnectionSettings[K],
  ) => Promise<void>;
  storeSecret: (name: string, value: string) => Promise<void>;
  deleteSecret: (name: string) => Promise<void>;
  retryTranslation: () => void;
  showInformation: (message: string) => Promise<void>;
  showFailure: (failure: ConnectionFailure) => Promise<void>;
}

export interface ConnectionSetup {
  setUp(): Promise<void>;
  selectModel(): Promise<void>;
  setReasoningEffort(): Promise<void>;
  setApiKey(): Promise<void>;
  clearApiKey(): Promise<void>;
  testConnection(): Promise<void>;
}

type DraftCommand = (
  deps: ConnectionDeps,
  prompter: Prompter,
  settings: ConnectionSettings,
) => Promise<SetupResult | undefined>;

function providerLabel(provider: string): string {
  return PROVIDER_PRESETS.find((preset) => preset.id === provider)?.label ?? "Custom";
}

/** Runs every setup command against the current stored connection. */
export function createConnectionSetup(deps: ConnectionSetupDeps, prompter: Prompter): ConnectionSetup {
  async function showTestResult(): Promise<void> {
    const settings = deps.settings();
    try {
      const elapsed = await openConnection(deps, settings).ping();
      deps.retryTranslation();
      const effort = settings.reasoningEffort === "default" ? "" : ` · effort ${settings.reasoningEffort}`;
      await deps.showInformation(
        `Connected to ${providerLabel(settings.provider)} · ${settings.model}${effort}. First token after ${elapsed} ms`,
      );
    } catch (error) {
      if (!(error instanceof ConnectionFailure)) throw error;
      await deps.showFailure(error);
    }
  }

  const run = (command: DraftCommand) => async (): Promise<void> => {
    const result = await command(deps, prompter, deps.settings());
    if (!result) return;
    const { secret } = result;
    if (secret?.kind === "store") await deps.storeSecret(secret.name, secret.value);
    if (secret?.kind === "delete") await deps.deleteSecret(secret.name);
    for (const [field, value] of Object.entries(result.settings)) {
      await deps.updateSetting(field as keyof ConnectionSettings, value);
    }
    await showTestResult();
  };

  async function clearApiKey(): Promise<void> {
    const settings = deps.settings();
    const { secretName } = keySource(settings);
    if (!(await deps.secret(secretName))) {
      await deps.showInformation(`No saved API key for ${providerLabel(settings.provider)}.`);
      return;
    }
    await deps.deleteSecret(secretName);
    await showTestResult();
  }

  return {
    setUp: run(setUpConnection),
    selectModel: run(selectModel),
    setReasoningEffort: run(setReasoningEffort),
    setApiKey: run(setApiKey),
    clearApiKey,
    testConnection: showTestResult,
  };
}

type SetupStep = "provider" | "baseUrl" | "apiKey" | "model" | "reasoningEffort";

const SETTING_FIELDS = ["provider", "customBaseUrl", "customApiKeyEnv", "model", "reasoningEffort"] as const;

/** Set Up LLM Connection: every step, with Back; undefined when cancelled. */
async function setUpConnection(
  deps: ConnectionDeps,
  prompter: Prompter,
  original: ConnectionSettings,
): Promise<SetupResult | undefined> {
  let draft: ConnectionSettings = { ...original };
  let key: KeyChoice | undefined;
  const snapshots: { settings: ConnectionSettings; key: KeyChoice | undefined }[] = [];
  let index = 0;
  while (true) {
    const steps = setupSteps(draft.provider, draft.reasoningEffort);
    if (index >= steps.length) break;
    const step = steps[index];
    const options: StepOptions = {
      title: "Set Up LLM Connection",
      step: index + 1,
      totalSteps: steps.length,
      canBack: index > 0,
    };
    let result: StepResult<string | KeyChoice>;
    if (step === "provider") result = await chooseProvider(prompter, draft, options);
    else if (step === "baseUrl") {
      result = await prompter.input({
        ...options,
        placeHolder: "Base URL, for example http://localhost:11434/v1",
        value: draft.customBaseUrl,
        required: true,
      });
    } else if (step === "apiKey") result = await chooseKey(deps, prompter, draft, options);
    else if (step === "model")
      result = await chooseModel(deps, prompter, draft, key, original.model, options);
    else result = await chooseEffort(prompter, draft, options);

    if (result.kind === "cancel") return undefined;
    if (result.kind === "back") {
      const previous = snapshots.pop();
      if (previous) {
        draft = previous.settings;
        key = previous.key;
        index--;
      }
      continue;
    }
    snapshots.push({ settings: { ...draft }, key });
    if (step === "provider") {
      if (draft.provider !== result.value) {
        draft.provider = result.value as string;
        draft.model = "";
        key = undefined;
      }
    } else if (step === "baseUrl") draft.customBaseUrl = result.value as string;
    else if (step === "apiKey") {
      key = result.value as KeyChoice;
      if (draft.provider === CUSTOM_PROVIDER_ID) {
        draft.customApiKeyEnv = key.kind === "env" ? key.name : "";
      }
    } else if (step === "model") draft.model = result.value as string;
    else draft.reasoningEffort = result.value as ReasoningEffort;
    index++;
  }
  const settings: Partial<ConnectionSettings> = {};
  for (const field of SETTING_FIELDS) {
    if (draft[field] !== original[field]) Object.assign(settings, { [field]: draft[field] });
  }
  return { settings, secret: key && secretAction(draft, key) };
}

/** Select Model: the model step alone, which always writes the model. */
async function selectModel(
  deps: ConnectionDeps,
  prompter: Prompter,
  settings: ConnectionSettings,
): Promise<SetupResult | undefined> {
  const result = await chooseModel(deps, prompter, settings, undefined, settings.model, {
    title: "Select Model",
  });
  return result.kind === "selected" ? { settings: { model: result.value } } : undefined;
}

/** Set Reasoning Effort: the effort step alone, which always writes the effort. */
async function setReasoningEffort(
  _deps: ConnectionDeps,
  prompter: Prompter,
  settings: ConnectionSettings,
): Promise<SetupResult | undefined> {
  const result = await chooseEffort(prompter, settings, { title: "Set Reasoning Effort" });
  return result.kind === "selected" ? { settings: { reasoningEffort: result.value } } : undefined;
}

/** Set API Key: the key step alone; for a Custom provider it always writes the environment variable read. */
async function setApiKey(
  deps: ConnectionDeps,
  prompter: Prompter,
  settings: ConnectionSettings,
): Promise<SetupResult | undefined> {
  const result = await chooseKey(deps, prompter, settings, { title: "Set API Key" });
  if (result.kind !== "selected") return undefined;
  const key = result.value;
  return {
    settings:
      settings.provider === CUSTOM_PROVIDER_ID ? { customApiKeyEnv: key.kind === "env" ? key.name : "" } : {},
    secret: secretAction(settings, key),
  };
}

function setupSteps(provider: string, effort: ReasoningEffort): SetupStep[] {
  return [
    "provider",
    ...(provider === CUSTOM_PROVIDER_ID ? ["baseUrl" as const] : []),
    "apiKey",
    "model",
    ...(effort === "default" ? [] : ["reasoningEffort" as const]),
  ];
}

/** Stores a new key; any other choice but the saved key deletes it. */
function secretAction(settings: ConnectionSettings, key: KeyChoice): SetupResult["secret"] {
  const { secretName: name } = keySource(settings);
  if (key.kind === "new") return { kind: "store", name, value: key.value };
  if (key.kind !== "saved") return { kind: "delete", name };
  return undefined;
}

function chooseProvider(prompter: Prompter, settings: ConnectionSettings, options: StepOptions) {
  const items: Choice<string>[] = [
    ...PROVIDER_PRESETS.map((preset) => ({
      label: preset.label,
      current: preset.id === settings.provider,
      value: preset.id,
    })),
    { label: "Custom…", current: settings.provider === CUSTOM_PROVIDER_ID, value: CUSTOM_PROVIDER_ID },
  ];
  return prompter.pick(
    items,
    options,
    items.find((item) => item.value === settings.provider),
  );
}

async function chooseKey(
  deps: ConnectionDeps,
  prompter: Prompter,
  settings: ConnectionSettings,
  options: StepOptions,
): Promise<StepResult<KeyChoice>> {
  const source = keySource(settings);
  const saved = await deps.secret(source.secretName);
  const preset = PROVIDER_PRESETS.find((item) => item.id === settings.provider);
  const envName = source.envVar;
  const hasEnv = Boolean(envName && deps.env[envName]);
  const items: Choice<"saved" | "new" | "env" | "none">[] = [];
  if (saved) items.push({ label: "Keep the saved key", masked: true, value: "saved" });
  items.push({ label: saved ? "Replace it with a new key…" : "Enter an API key…", value: "new" });
  if (preset) {
    if (hasEnv) items.push({ label: `Use $${envName}`, value: "env" });
  } else {
    items.push({ label: "Read it from an environment variable…", value: "env" });
    items.push({ label: "No key", value: "none" });
  }
  const placeHolder =
    preset && !hasEnv
      ? `You can export $${envName} in the extension host environment instead.`
      : options.placeHolder;
  while (true) {
    const result = await prompter.pick(items, { ...options, placeHolder });
    if (result.kind !== "selected") return result;
    if (result.value === "saved") return { kind: "selected", value: { kind: "saved" } };
    if (result.value === "none") return { kind: "selected", value: { kind: "none" } };
    if (result.value === "env" && preset) {
      return { kind: "selected", value: { kind: "env", name: preset.apiKeyEnv } };
    }
    const entered = await prompter.input({
      ...options,
      canBack: true,
      title: result.value === "new" ? "Enter API Key" : "Environment Variable Name",
      placeHolder: result.value === "new" ? "API key" : "MY_API_KEY",
      password: result.value === "new",
      value: result.value === "env" ? settings.customApiKeyEnv : "",
      required: true,
    });
    if (entered.kind === "cancel") return entered;
    if (entered.kind === "back") continue;
    return {
      kind: "selected",
      value:
        result.value === "new" ? { kind: "new", value: entered.value } : { kind: "env", name: entered.value },
    };
  }
}

async function chooseModel(
  deps: ConnectionDeps,
  prompter: Prompter,
  settings: ConnectionSettings,
  key: KeyChoice | undefined,
  previousModel: string,
  options: StepOptions,
): Promise<StepResult<string>> {
  let models: string[] = [];
  let message: string | undefined;
  try {
    models = await openConnection(deps, settings, key).listModels();
    if (previousModel && !models.includes(previousModel)) {
      message = `Current model ${previousModel} is not in this provider's model list.`;
    }
  } catch (error) {
    if (!(error instanceof ConnectionFailure)) throw error;
    message = `Could not load models: ${error.message}`;
  }
  const items: Choice<string>[] = [
    { label: "Enter a model ID…", detail: message, value: "" },
    ...models.map((model) => ({
      label: model,
      current: model === (settings.model || previousModel),
      value: model,
    })),
  ];
  while (true) {
    const result = await prompter.pick(items, { ...options, placeHolder: message ?? options.placeHolder });
    if (result.kind !== "selected") return result;
    if (result.value) return result;
    const entered = await prompter.input({
      ...options,
      canBack: true,
      title: "Enter Model ID",
      placeHolder: "Provider model ID",
      value: settings.model || previousModel,
      required: true,
    });
    if (entered.kind === "cancel") return entered;
    if (entered.kind === "back") continue;
    return entered;
  }
}

function chooseEffort(prompter: Prompter, settings: ConnectionSettings, options: StepOptions) {
  const values = [
    settings.reasoningEffort,
    ...REASONING_EFFORTS.filter((v) => v !== settings.reasoningEffort),
  ];
  const items: Choice<ReasoningEffort>[] = values.map((effort) => ({
    label: effort,
    current: effort === settings.reasoningEffort,
    value: effort,
  }));
  return prompter.pick(
    items,
    { ...options, placeHolder: "Reasoning effort applies to every provider." },
    items[0],
  );
}
