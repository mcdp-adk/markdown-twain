import { BATCH_SEPARATOR, translateSystemPrompt, translateUserPrefix } from "./prompt.ts";
import {
  CUSTOM_PROVIDER_ID,
  PROVIDER_PRESETS,
  effortField,
  normalizeCustomBaseUrl,
  type ReasoningEffort,
} from "./providers.ts";
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

/** Where the API key comes from: SecretStorage first, then the environment. */
export interface KeySource {
  secretName: string;
  envVar: string;
}

/**
 * Everything a translation request carries besides the Block. `key` covers all
 * of it, so a cache key built from it can't drift from what is sent.
 */
export interface TranslationContext {
  key: string;
  url: string;
  model: string;
  /** The request body without the user message. */
  body: { messages: { role: string; content: string }[] } & Record<string, unknown>;
  userPrefix: string;
  keySource: KeySource;
}

/** The context for these settings, or nothing when the Target language or provider doesn't resolve. */
export function translationContext(settings: Settings): TranslationContext | undefined {
  const language = resolveTargetLanguage(settings.targetLanguage, settings.displayLanguage);
  if (!language.ok) return undefined;
  const { tag, englishName } = language.language;

  let baseUrl: string;
  let keySource: KeySource;
  let effort: Record<string, unknown>;
  if (settings.provider === CUSTOM_PROVIDER_ID) {
    baseUrl = normalizeCustomBaseUrl(settings.customBaseUrl);
    keySource = { secretName: `apiKey.${CUSTOM_PROVIDER_ID}`, envVar: settings.customApiKeyEnv };
    effort = effortField("reasoning_effort", settings.reasoningEffort);
  } else {
    const preset = PROVIDER_PRESETS.find((p) => p.id === settings.provider);
    if (!preset) return undefined;
    baseUrl = preset.baseUrl;
    keySource = { secretName: `apiKey.${preset.id}`, envVar: preset.apiKeyEnv };
    effort = effortField(preset.effortStyle, settings.reasoningEffort);
  }

  const url = `${baseUrl}/chat/completions`;
  const body = {
    model: settings.model,
    messages: [{ role: "system", content: translateSystemPrompt(englishName) }],
    stream: false,
    ...effort,
  };
  const userPrefix = translateUserPrefix(englishName);
  return {
    key: JSON.stringify({ targetLanguage: tag, url, body, userPrefix }),
    url,
    model: settings.model,
    body,
    userPrefix,
    keySource,
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
 * trimmed segments. A single Block's answer is its one segment, so its
 * per-Block fallback can't mismatch again.
 */
export function answerSegments(answer: string, blockCount: number): string[] {
  return blockCount === 1 ? [answer] : answer.split(SEPARATOR_LINE).map((segment) => segment.trim());
}

export function buildRequest(
  context: TranslationContext,
  input: string,
  apiKey: string | undefined,
  signal: AbortSignal,
): [string, RequestInit] {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body = {
    ...context.body,
    messages: [...context.body.messages, { role: "user", content: context.userPrefix + input }],
  };
  return [context.url, { method: "POST", headers, body: JSON.stringify(body), signal }];
}

export class RequestError extends Error {
  readonly status: number | undefined;

  constructor(status: number | undefined, message: string) {
    super(message);
    this.status = status;
  }
}

/** Sends one request and returns the model's text, with a leading `<think>…</think>` stripped and trimmed. */
export async function send(
  fetch: typeof globalThis.fetch,
  request: [string, RequestInit],
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(...request);
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    throw new RequestError(
      undefined,
      cause ? [cause.code, cause.message].filter(Boolean).join(" ") : String(error),
    );
  }
  const text = await response.text();
  if (!response.ok) throw new RequestError(response.status, providerMessage(text));
  let content: unknown;
  try {
    content = JSON.parse(text)?.choices?.[0]?.message?.content;
  } catch {
    throw new RequestError(response.status, `Unreadable response: ${text.slice(0, 200)}`);
  }
  if (typeof content !== "string") throw new RequestError(response.status, "No content in response");
  return content.replace(/^\s*<think>[\s\S]*?<\/think>/, "").trim();
}

/** `error.message`, then `error` as a string, then `message`, then the raw body. */
function providerMessage(text: string): string {
  try {
    const json = JSON.parse(text);
    const message = json?.error?.message ?? json?.error ?? json?.message;
    if (typeof message === "string") return message;
  } catch {
    // Not JSON; fall through to the raw body.
  }
  return text;
}
