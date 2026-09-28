// The adapter: the only code that imports `vscode`. It wires VS Code into the
// core and holds no decisions of its own.

import type { MarkdownIt } from "markdown-it";
import * as vscode from "vscode";
import type { ConnectionSettings, KeyChoice } from "./core/connection.ts";
import {
  CUSTOM_PROVIDER_ID,
  PROVIDER_PRESETS,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "./core/providers.ts";
import type { Settings } from "./core/request.ts";
import { createTwain, type DisplayMode, type Twain } from "./core/twain.ts";

export function activate(context: vscode.ExtensionContext): { extendMarkdownIt(md: MarkdownIt): MarkdownIt } {
  const log = vscode.window.createOutputChannel("markdown-twain", { log: true });

  const twain = createTwain({
    fetch: globalThis.fetch,
    refresh: () => void vscode.commands.executeCommand("markdown.preview.refresh"),
    clock: {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
      now: () => Date.now(),
    },
    settings: readSettings,
    secret: async (name) => context.secrets.get(name),
    env: process.env,
    readDocument: (uri) =>
      vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri)?.getText(),
    log,
  });

  const mirrorDisplayMode = () =>
    void vscode.commands.executeCommand("setContext", "markdownTwain.displayMode", twain.displayMode);
  const setDisplayMode = (mode: DisplayMode) => {
    twain.setDisplayMode(mode);
    mirrorDisplayMode();
  };
  const pickDisplayMode = async () => {
    const modes: { label: string; mode: DisplayMode }[] = [
      { label: "Original Only", mode: "originalOnly" },
      { label: "Bilingual", mode: "bilingual" },
      { label: "Translation Only", mode: "translationOnly" },
    ];
    const selected = await vscode.window.showQuickPick(
      modes.map(({ label, mode }) => ({
        label,
        description: mode === twain.displayMode ? "$(check) Current" : undefined,
        mode,
      })),
      { placeHolder: "Pick Display Mode" },
    );
    if (selected) setDisplayMode(selected.mode);
  };
  const connection = connectionCommands(context, twain);

  context.subscriptions.push(
    log,
    vscode.commands.registerCommand("markdownTwain.pickDisplayMode", pickDisplayMode),
    vscode.commands.registerCommand("markdownTwain.pickDisplayMode.originalOnly", pickDisplayMode),
    vscode.commands.registerCommand("markdownTwain.pickDisplayMode.bilingual", pickDisplayMode),
    vscode.commands.registerCommand("markdownTwain.pickDisplayMode.translationOnly", pickDisplayMode),
    vscode.commands.registerCommand("markdownTwain.showBilingual", () => setDisplayMode("bilingual")),
    vscode.commands.registerCommand("markdownTwain.showOriginalOnly", () => setDisplayMode("originalOnly")),
    vscode.commands.registerCommand("markdownTwain.showTranslationOnly", () =>
      setDisplayMode("translationOnly"),
    ),
    vscode.commands.registerCommand("markdownTwain.showLog", () => log.show()),
    vscode.commands.registerCommand("markdownTwain.setUpConnection", connection.setUp),
    vscode.commands.registerCommand("markdownTwain.selectModel", connection.selectModel),
    vscode.commands.registerCommand("markdownTwain.setReasoningEffort", connection.setReasoningEffort),
    vscode.commands.registerCommand("markdownTwain.setApiKey", connection.setApiKey),
    vscode.commands.registerCommand("markdownTwain.clearApiKey", connection.clearApiKey),
    vscode.commands.registerCommand("markdownTwain.testConnection", connection.testConnection),
    vscode.commands.registerCommand("markdownTwain.openTargetLanguageSetting", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "markdownTwain.targetLanguage"),
    ),
  );
  mirrorDisplayMode();

  return {
    extendMarkdownIt: (md: MarkdownIt) => twain.markdownItPlugin(md),
  };
}

export function deactivate(): void {}

function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration("markdownTwain");
  return {
    targetLanguage: config.get<string>("targetLanguage", "auto"),
    provider: config.get<string>("provider", "openai"),
    customBaseUrl: config.get<string>("customBaseUrl", ""),
    customApiKeyEnv: config.get<string>("customApiKeyEnv", ""),
    model: config.get<string>("model", ""),
    reasoningEffort: config.get<ReasoningEffort>("reasoningEffort", "default"),
    displayLanguage: vscode.env.language,
  };
}

type StepResult<T> = { kind: "selected"; value: T } | { kind: "back" } | { kind: "cancel" };

interface Choice<T> extends vscode.QuickPickItem {
  value: T;
}

interface StepOptions {
  title: string;
  step?: number;
  totalSteps?: number;
  canBack?: boolean;
  placeHolder?: string;
}

function pick<T>(items: Choice<T>[], options: StepOptions, current?: Choice<T>): Promise<StepResult<T>> {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<Choice<T>>();
    quickPick.title = options.title;
    quickPick.step = options.step;
    quickPick.totalSteps = options.totalSteps;
    quickPick.placeholder = options.placeHolder;
    quickPick.buttons = options.canBack ? [vscode.QuickInputButtons.Back] : [];
    quickPick.items = items;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    if (current) quickPick.activeItems = [current];
    let done = false;
    const finish = (result: StepResult<T>) => {
      if (done) return;
      done = true;
      resolve(result);
      quickPick.hide();
      quickPick.dispose();
    };
    quickPick.onDidAccept(() => {
      const item = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
      if (item) finish({ kind: "selected", value: item.value });
    });
    quickPick.onDidTriggerButton(() => finish({ kind: "back" }));
    quickPick.onDidHide(() => finish({ kind: "cancel" }));
    quickPick.show();
  });
}

function input(
  options: StepOptions & { value?: string; password?: boolean; required?: boolean },
): Promise<StepResult<string>> {
  return new Promise((resolve) => {
    const box = vscode.window.createInputBox();
    box.title = options.title;
    box.step = options.step;
    box.totalSteps = options.totalSteps;
    box.placeholder = options.placeHolder;
    box.value = options.value ?? "";
    box.password = options.password ?? false;
    box.buttons = options.canBack ? [vscode.QuickInputButtons.Back] : [];
    let done = false;
    const finish = (result: StepResult<string>) => {
      if (done) return;
      done = true;
      resolve(result);
      box.hide();
      box.dispose();
    };
    box.onDidAccept(() => {
      const value = box.value.trim();
      if (options.required && !value) {
        box.validationMessage = "Enter a value to continue.";
        return;
      }
      finish({ kind: "selected", value });
    });
    box.onDidTriggerButton(() => finish({ kind: "back" }));
    box.onDidHide(() => finish({ kind: "cancel" }));
    box.show();
  });
}

function providerLabel(provider: string): string {
  return PROVIDER_PRESETS.find((preset) => preset.id === provider)?.label ?? "Custom";
}

function connectionCommands(context: vscode.ExtensionContext, twain: Twain) {
  const config = () => vscode.workspace.getConfiguration("markdownTwain");
  const secretName = (provider: string) => `apiKey.${provider}`;

  async function showTestResult(): Promise<void> {
    const settings = readSettings();
    try {
      const elapsed = await twain.testConnection(settings);
      const effort = settings.reasoningEffort === "default" ? "" : ` · effort ${settings.reasoningEffort}`;
      await vscode.window.showInformationMessage(
        `Connected to ${providerLabel(settings.provider)} · ${settings.model}${effort}. First token after ${elapsed} ms`,
      );
    } catch (error) {
      const failure = twain.classifyConnectionError(error, settings);
      const fix = failure.fix
        ? {
            setUpConnection: ["Set Up LLM Connection", "markdownTwain.setUpConnection"],
            setApiKey: ["Set API Key", "markdownTwain.setApiKey"],
            selectModel: ["Select Model", "markdownTwain.selectModel"],
            setReasoningEffort: ["Set Reasoning Effort", "markdownTwain.setReasoningEffort"],
            openTargetLanguageSetting: ["Open Setting", "markdownTwain.openTargetLanguageSetting"],
          }[failure.fix]
        : undefined;
      const selected = fix
        ? await vscode.window.showErrorMessage(failure.message, fix[0])
        : await vscode.window.showErrorMessage(failure.message);
      if (fix && selected === fix[0]) await vscode.commands.executeCommand(fix[1]);
    }
  }

  async function chooseProvider(settings: ConnectionSettings, options: StepOptions) {
    const items: Choice<string>[] = [
      ...PROVIDER_PRESETS.map((preset) => ({
        label: preset.label,
        description: preset.id === settings.provider ? "$(check) Current" : undefined,
        value: preset.id,
      })),
      {
        label: "Custom…",
        description: settings.provider === CUSTOM_PROVIDER_ID ? "$(check) Current" : undefined,
        value: CUSTOM_PROVIDER_ID,
      },
    ];
    return pick(
      items,
      options,
      items.find((item) => item.value === settings.provider),
    );
  }

  async function chooseKey(
    settings: ConnectionSettings,
    options: StepOptions,
  ): Promise<StepResult<KeyChoice>> {
    const saved = await context.secrets.get(secretName(settings.provider));
    const preset = PROVIDER_PRESETS.find((item) => item.id === settings.provider);
    const envName = preset?.apiKeyEnv ?? settings.customApiKeyEnv;
    const hasEnv = Boolean(envName && process.env[envName]);
    const items: Choice<"saved" | "new" | "env" | "none">[] = [];
    if (saved) items.push({ label: "Keep the saved key", description: "••••••••", value: "saved" });
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
      const result = await pick(items, { ...options, placeHolder });
      if (result.kind !== "selected") return result;
      if (result.value === "saved") return { kind: "selected", value: { kind: "saved" } };
      if (result.value === "none") return { kind: "selected", value: { kind: "none" } };
      if (result.value === "env" && preset) {
        return { kind: "selected", value: { kind: "env", name: preset.apiKeyEnv } };
      }
      const entered = await input({
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
          result.value === "new"
            ? { kind: "new", value: entered.value }
            : { kind: "env", name: entered.value },
      };
    }
  }

  async function chooseModel(
    settings: ConnectionSettings,
    key: KeyChoice | undefined,
    previousModel: string,
    options: StepOptions,
  ): Promise<StepResult<string>> {
    let models: string[] = [];
    let message: string | undefined;
    try {
      models = await twain.listModels(settings, key);
      if (previousModel && !models.includes(previousModel)) {
        message = `Current model ${previousModel} is not in this provider's model list.`;
      }
    } catch (error) {
      message = `Could not load models: ${twain.classifyConnectionError(error, settings).message}`;
    }
    const items: Choice<string>[] = [
      { label: "Enter a model ID…", detail: message, value: "" },
      ...models.map((model) => ({
        label: model,
        description: model === (settings.model || previousModel) ? "$(check) Current" : undefined,
        value: model,
      })),
    ];
    while (true) {
      const result = await pick(items, { ...options, placeHolder: message ?? options.placeHolder });
      if (result.kind !== "selected") return result;
      if (result.value) return result;
      const entered = await input({
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

  async function chooseEffort(settings: ConnectionSettings, options: StepOptions) {
    const values = [
      settings.reasoningEffort,
      ...REASONING_EFFORTS.filter((v) => v !== settings.reasoningEffort),
    ];
    const items: Choice<ReasoningEffort>[] = values.map((effort) => ({
      label: effort,
      description: effort === settings.reasoningEffort ? "$(check) Current" : undefined,
      value: effort,
    }));
    return pick(items, { ...options, placeHolder: "Reasoning effort applies to every provider." }, items[0]);
  }

  async function saveKey(provider: string, key: KeyChoice): Promise<void> {
    if (key.kind === "new") await context.secrets.store(secretName(provider), key.value);
    else if (key.kind !== "saved") await context.secrets.delete(secretName(provider));
  }

  async function setUp(): Promise<void> {
    const original = readSettings();
    let draft: ConnectionSettings = { ...original };
    let key: KeyChoice | undefined;
    const snapshots: { settings: ConnectionSettings; key: KeyChoice | undefined }[] = [];
    let index = 0;
    while (true) {
      const steps = twain.setupSteps(draft.provider, draft.reasoningEffort);
      if (index >= steps.length) break;
      const step = steps[index];
      const options: StepOptions = {
        title: "Set Up LLM Connection",
        step: index + 1,
        totalSteps: steps.length,
        canBack: index > 0,
      };
      let result: StepResult<string | KeyChoice>;
      if (step === "provider") result = await chooseProvider(draft, options);
      else if (step === "baseUrl") {
        result = await input({
          ...options,
          placeHolder: "Base URL, for example http://localhost:11434/v1",
          value: draft.customBaseUrl,
          required: true,
        });
      } else if (step === "apiKey") result = await chooseKey(draft, options);
      else if (step === "model") result = await chooseModel(draft, key, original.model, options);
      else result = await chooseEffort(draft, options);

      if (result.kind === "cancel") return;
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
    if (key) await saveKey(draft.provider, key);
    for (const field of [
      "provider",
      "customBaseUrl",
      "customApiKeyEnv",
      "model",
      "reasoningEffort",
    ] as const) {
      if (draft[field] !== original[field]) {
        await config().update(field, draft[field], vscode.ConfigurationTarget.Global);
      }
    }
    await showTestResult();
  }

  async function selectModel(): Promise<void> {
    const settings = readSettings();
    const result = await chooseModel(settings, undefined, settings.model, {
      title: "Select Model",
    });
    if (result.kind !== "selected") return;
    await config().update("model", result.value, vscode.ConfigurationTarget.Global);
    await showTestResult();
  }

  async function setReasoningEffort(): Promise<void> {
    const result = await chooseEffort(readSettings(), { title: "Set Reasoning Effort" });
    if (result.kind !== "selected") return;
    await config().update("reasoningEffort", result.value, vscode.ConfigurationTarget.Global);
    await showTestResult();
  }

  async function setApiKey(): Promise<void> {
    const settings = readSettings();
    const result = await chooseKey(settings, { title: "Set API Key" });
    if (result.kind !== "selected") return;
    await saveKey(settings.provider, result.value);
    if (settings.provider === CUSTOM_PROVIDER_ID) {
      const env = result.value.kind === "env" ? result.value.name : "";
      await config().update("customApiKeyEnv", env, vscode.ConfigurationTarget.Global);
    }
    await showTestResult();
  }

  async function clearApiKey(): Promise<void> {
    const settings = readSettings();
    if (!(await context.secrets.get(secretName(settings.provider)))) {
      await vscode.window.showInformationMessage(`No saved API key for ${providerLabel(settings.provider)}.`);
      return;
    }
    await context.secrets.delete(secretName(settings.provider));
    await showTestResult();
  }

  return { setUp, selectModel, setReasoningEffort, setApiKey, clearApiKey, testConnection: showTestResult };
}
