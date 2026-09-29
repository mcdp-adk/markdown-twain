import type { Connection } from "./connection.ts";
import { BATCH_SEPARATOR, translateSystemPrompt, translateUserPrefix } from "./prompt.ts";
import type { ReasoningEffort } from "./providers.ts";
import { resolveTargetLanguage } from "./target-language.ts";

/** A snapshot of the extension's settings plus `vscode.env.language`. */
export interface Settings {
  targetLanguage: string;
  provider: string;
  customBaseUrl: string;
  customApiKeyEnv: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  displayLanguage: string;
}

/**
 * Everything a translation request carries besides the Block. `key` covers all
 * of it, so a cache key built from it can't drift from what is sent.
 */
export interface TranslationContext {
  key: string;
  /** The connection's URL and model, for the log. */
  url: string;
  model: string;
  /** The Target language's English name. */
  targetLanguage: string;
  system: string;
  userPrefix: string;
}

/**
 * The context for these settings, their connection, and a document's `brief`,
 * or nothing when the Target language doesn't resolve. Without a brief, it is
 * the context a Document brief is requested and kept under.
 */
export function translationContext(
  settings: Settings,
  connection: Pick<Connection, "url" | "model" | "identity">,
  brief?: string,
): TranslationContext | undefined {
  const language = resolveTargetLanguage(settings.targetLanguage, settings.displayLanguage);
  if (!language.ok) return undefined;
  const { tag, englishName } = language.language;
  const system = translateSystemPrompt(englishName, brief);
  const userPrefix = translateUserPrefix(englishName);
  return {
    key: JSON.stringify({ targetLanguage: tag, connection: connection.identity, system, userPrefix }),
    url: connection.url,
    model: connection.model,
    targetLanguage: englishName,
    system,
    userPrefix,
  };
}

/** Raw inline Markdown with soft line breaks joined into one space; hard breaks are kept. */
export function requestInput(content: string): string {
  return content
    .split("\n")
    .map((line, i, lines) => {
      if (i === lines.length - 1) return line;
      return / {2,}$|\\$/.test(line) ? `${line}\n` : `${line.trimEnd()} `;
    })
    .map((line, i) => (i === 0 ? line : line.trimStart()))
    .join("");
}

/** A line holding only the batch separator. */
const SEPARATOR_LINE = new RegExp(`^[ \\t]*${BATCH_SEPARATOR}[ \\t]*\\r?$`, "m");

/** One request input for a batch of Block inputs, joined with the batch separator. */
export function batchInput(inputs: string[]): string {
  return inputs.join(`\n\n${BATCH_SEPARATOR}\n\n`);
}

/**
 * The answer to a batch of `blockCount` Blocks, split on separator lines into
 * trimmed response parts. A single Block's answer is its one response part, so its
 * per-Block fallback can't mismatch again.
 */
export function splitBatchResponse(answer: string, blockCount: number): string[] {
  return blockCount === 1
    ? [answer]
    : answer.split(SEPARATOR_LINE).map((responsePart) => responsePart.trim());
}
