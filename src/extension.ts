// The adapter: the only code that imports `vscode`. It wires VS Code into the
// core and holds no decisions of its own.

import type { MarkdownIt } from "markdown-it";
import * as vscode from "vscode";
import { type ConnectionDeps, ConnectionFailure, keySource, openConnection } from "./core/connection.ts";
import {
  type Choice,
  type InputOptions,
  type Prompter,
  type StepOptions,
  type StepResult,
  selectModel,
  setApiKey,
  setReasoningEffort,
  setUpConnection,
} from "./core/connection-setup.ts";
import { PROVIDER_PRESETS, type ReasoningEffort } from "./core/providers.ts";
import type { Settings } from "./core/request.ts";
import { createTwain, type DisplayMode, type Failure, type Status, type Twain } from "./core/twain.ts";

const FIX_ACTIONS = {
  setUpConnection: ["Set Up LLM Connection", "markdownTwain.setUpConnection"],
  setApiKey: ["Set API Key", "markdownTwain.setApiKey"],
  selectModel: ["Select Model", "markdownTwain.selectModel"],
  setReasoningEffort: ["Set Reasoning Effort", "markdownTwain.setReasoningEffort"],
  openTargetLanguageSetting: ["Open Setting", "markdownTwain.openTargetLanguageSetting"],
} as const;

export function activate(context: vscode.ExtensionContext): { extendMarkdownIt(md: MarkdownIt): MarkdownIt } {
  const log = vscode.window.createOutputChannel("markdown-twain", { log: true });

  const deps: ConnectionDeps = {
    fetch: globalThis.fetch,
    clock: {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
      now: () => Date.now(),
    },
    secret: async (name) => context.secrets.get(name),
    env: process.env,
  };
  const twain = createTwain({
    ...deps,
    refresh: () => void vscode.commands.executeCommand("markdown.preview.refresh"),
    settings: readSettings,
    readDocument: (uri) =>
      vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri)?.getText(),
    log,
  });

  const mirrorDisplayMode = () =>
    void vscode.commands.executeCommand("setContext", "markdownTwain.displayMode", twain.displayMode);
  const runFailureAction = (
    selected: string | undefined,
    fix?: (typeof FIX_ACTIONS)[keyof typeof FIX_ACTIONS],
  ) => {
    if (selected === "Retry") twain.retry();
    if (selected === "Show Log") log.show();
    if (fix && selected === fix[0]) void vscode.commands.executeCommand(fix[1]);
  };
  const showFailure = async (error: Failure, retry = false) => {
    const fix = error.fix ? FIX_ACTIONS[error.fix] : undefined;
    const actions = [...(fix ? [fix[0]] : []), ...(retry ? ["Retry"] : [])];
    runFailureAction(await vscode.window.showErrorMessage(error.message, ...actions), fix);
  };
  const setDisplayMode = async (mode: DisplayMode) => {
    const failure = await twain.setDisplayMode(mode);
    mirrorDisplayMode();
    if (failure) await showFailure(failure);
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
    if (selected) await setDisplayMode(selected.mode);
  };
  const connection = connectionCommands(context, twain, deps);

  // Between the language mode item (100.1) and `status.editor.info` (100).
  const statusItem = vscode.window.createStatusBarItem(
    "markdownTwain.status",
    vscode.StatusBarAlignment.Right,
    100.05,
  );
  statusItem.name = "markdown-twain";
  const showStatus = (status: Status) => {
    statusItem.backgroundColor = undefined;
    switch (status.kind) {
      case "idle":
        statusItem.hide();
        return;
      case "preparing":
        statusItem.text = "$(sync~spin) Preparing…";
        statusItem.tooltip = undefined;
        statusItem.command = "markdownTwain.showLog";
        break;
      case "translating":
        statusItem.text = `$(sync~spin) ${status.landed}/${status.total}`;
        statusItem.tooltip = `Translating… ${status.landed} of ${blocks(status.total)}`;
        statusItem.command = "markdownTwain.showLog";
        break;
      case "halted":
        statusItem.text = "$(error) Translation stopped";
        statusItem.tooltip = status.error.message;
        statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
        statusItem.command = "markdownTwain.statusActions";
        break;
      case "someFailed":
        statusItem.text = `$(warning) ${status.count}`;
        statusItem.tooltip = `${blocks(status.count)} couldn't be translated since the last retry`;
        statusItem.command = "markdownTwain.statusActions";
        break;
    }
    statusItem.show();
  };
  twain.onStatusChange(showStatus);
  showStatus(twain.status);

  const failureActions = ["Retry", "Show Log"] as const;
  twain.onRunEnd(async (event) => {
    if (event.kind === "halted") {
      await showFailure(event.error, true);
      return;
    }
    runFailureAction(
      await vscode.window.showWarningMessage(
        `${event.count} of ${blocks(event.total)} couldn't be translated.`,
        ...failureActions,
      ),
    );
  });
  const statusActions = async () => {
    const status = twain.status;
    const fix = status.kind === "halted" && status.error.fix ? FIX_ACTIONS[status.error.fix] : undefined;
    const actions = fix ? ["Retry", fix[0], "Show Log"] : failureActions;
    runFailureAction(await vscode.window.showQuickPick(actions, { placeHolder: "markdown-twain" }), fix);
  };

  context.subscriptions.push(
    log,
    statusItem,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("markdownTwain")) twain.settingsChanged();
    }),
    vscode.commands.registerCommand("markdownTwain.statusActions", statusActions),
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

function blocks(count: number): string {
  return count === 1 ? "1 Block" : `${count} Blocks`;
}

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

/** The Connection setup's prompts, as a QuickPick or an InputBox. */
const prompter: Prompter = { pick, input };

function pick<T>(choices: Choice<T>[], options: StepOptions, active?: Choice<T>): Promise<StepResult<T>> {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { value: T }>();
    const items = choices.map(({ label, detail, value, current, masked }) => ({
      label,
      description: current ? "$(check) Current" : masked ? "••••••••" : undefined,
      detail,
      value,
    }));
    quickPick.title = options.title;
    quickPick.step = options.step;
    quickPick.totalSteps = options.totalSteps;
    quickPick.placeholder = options.placeHolder;
    quickPick.buttons = options.canBack ? [vscode.QuickInputButtons.Back] : [];
    quickPick.items = items;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    if (active) quickPick.activeItems = [items[choices.indexOf(active)]];
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

function input(options: InputOptions): Promise<StepResult<string>> {
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

function connectionCommands(context: vscode.ExtensionContext, twain: Twain, deps: ConnectionDeps) {
  const config = () => vscode.workspace.getConfiguration("markdownTwain");

  async function showTestResult(): Promise<void> {
    const settings = readSettings();
    try {
      const elapsed = await openConnection(deps, settings).ping();
      twain.retry();
      const effort = settings.reasoningEffort === "default" ? "" : ` · effort ${settings.reasoningEffort}`;
      await vscode.window.showInformationMessage(
        `Connected to ${providerLabel(settings.provider)} · ${settings.model}${effort}. First token after ${elapsed} ms`,
      );
    } catch (error) {
      if (!(error instanceof ConnectionFailure)) throw error;
      const failure = error;
      const fix = failure.fix ? FIX_ACTIONS[failure.fix] : undefined;
      const selected = fix
        ? await vscode.window.showErrorMessage(failure.message, fix[0])
        : await vscode.window.showErrorMessage(failure.message);
      if (fix && selected === fix[0]) await vscode.commands.executeCommand(fix[1]);
    }
  }

  /** Runs a Connection setup command, applies what it changes, and tests the connection unless cancelled. */
  const run = (command: typeof setUpConnection) => async (): Promise<void> => {
    const result = await command(deps, prompter, readSettings());
    if (!result) return;
    const { secret } = result;
    if (secret?.kind === "store") await context.secrets.store(secret.name, secret.value);
    if (secret?.kind === "delete") await context.secrets.delete(secret.name);
    for (const [field, value] of Object.entries(result.settings)) {
      await config().update(field, value, vscode.ConfigurationTarget.Global);
    }
    await showTestResult();
  };

  async function clearApiKey(): Promise<void> {
    const settings = readSettings();
    const { secretName } = keySource(settings);
    if (!(await context.secrets.get(secretName))) {
      await vscode.window.showInformationMessage(`No saved API key for ${providerLabel(settings.provider)}.`);
      return;
    }
    await context.secrets.delete(secretName);
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
