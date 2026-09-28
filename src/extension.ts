// The adapter: the only code that imports `vscode`. It wires VS Code into the
// core and holds no decisions of its own.

import type { MarkdownIt } from "markdown-it";
import * as vscode from "vscode";
import type { ReasoningEffort } from "./core/providers.ts";
import type { Settings } from "./core/request.ts";
import { createTwain, type DisplayMode, type Status } from "./core/twain.ts";

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

  const statusItem = vscode.window.createStatusBarItem(
    "markdownTwain.status",
    vscode.StatusBarAlignment.Right,
    100.05,
  );
  statusItem.name = "markdown-twain";
  const showStatus = (status: Status) => {
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

  twain.onRunEnd(async (event) => {
    const selected = await vscode.window.showWarningMessage(
      `${event.count} of ${blocks(event.total)} couldn't be translated.`,
      "Retry",
      "Show Log",
    );
    if (selected === "Retry") twain.retry();
    if (selected === "Show Log") log.show();
  });
  const statusActions = async () => {
    const selected = await vscode.window.showQuickPick(["Retry", "Show Log"], {
      placeHolder: "markdown-twain",
    });
    if (selected === "Retry") twain.retry();
    if (selected === "Show Log") log.show();
  };

  context.subscriptions.push(
    log,
    statusItem,
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
