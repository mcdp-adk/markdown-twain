// The adapter: the only code that imports `vscode`. It wires VS Code into the
// core and holds no decisions of its own.

import type { MarkdownIt } from "markdown-it";
import * as vscode from "vscode";
import type { ReasoningEffort } from "./core/providers.ts";
import type { Settings } from "./core/request.ts";
import { createTwain, type DisplayMode } from "./core/twain.ts";

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
