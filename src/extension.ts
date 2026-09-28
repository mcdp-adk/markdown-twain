// The adapter: the only code that imports `vscode`. It wires VS Code into the
// core and holds no decisions of its own.

import * as vscode from "vscode";
import type { MarkdownIt } from "markdown-it";
import type { ReasoningEffort } from "./core/providers.ts";
import type { Settings } from "./core/request.ts";
import { createTwain, type DisplayMode } from "./core/twain.ts";

export function activate(context: vscode.ExtensionContext) {
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

  const setDisplayMode = (mode: DisplayMode) => {
    twain.setDisplayMode(mode);
    void vscode.commands.executeCommand("setContext", "markdownTwain.displayMode", twain.displayMode);
  };

  context.subscriptions.push(
    log,
    vscode.commands.registerCommand("markdownTwain.showBilingual", () => setDisplayMode("bilingual")),
    vscode.commands.registerCommand("markdownTwain.showOriginalOnly", () =>
      setDisplayMode("originalOnly"),
    ),
    vscode.commands.registerCommand("markdownTwain.showLog", () => log.show()),
  );
  void vscode.commands.executeCommand("setContext", "markdownTwain.displayMode", twain.displayMode);

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
