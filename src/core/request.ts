import { briefSystemPrompt, briefUserMessage } from "./brief-prompt.ts";
import { BATCH_SEPARATOR, translateSystemPrompt, translateUserPrefix } from "./prompt.ts";
import { effortField, providerConnection, type ReasoningEffort } from "./providers.ts";
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
  /** The Target language's English name. */
  targetLanguage: string;
  /** The request body without the user message. */
  body: { messages: { role: string; content: string }[] } & Record<string, unknown>;
  userPrefix: string;
  keySource: KeySource;
}

/**
 * The context for these settings and a document's `brief`, or nothing when the
 * Target language or provider doesn't resolve. Without a brief, it is the
 * context a Document brief is requested and kept under.
 */
export function translationContext(settings: Settings, brief?: string): TranslationContext | undefined {
  const language = resolveTargetLanguage(settings.targetLanguage, settings.displayLanguage);
  if (!language.ok) return undefined;
  const { tag, englishName } = language.language;

  const connection = providerConnection(settings);
  if (!connection) return undefined;
  const keySource: KeySource = {
    secretName: connection.secretName,
    envVar: connection.envVar,
  };
  const effort = effortField(connection.effortStyle, settings.reasoningEffort);

  const url = `${connection.baseUrl}/chat/completions`;
  const body = {
    model: settings.model,
    messages: [{ role: "system", content: translateSystemPrompt(englishName, brief) }],
    stream: false,
    ...effort,
  };
  const userPrefix = translateUserPrefix(englishName);
  return {
    key: JSON.stringify({ targetLanguage: tag, url, body, userPrefix }),
    url,
    model: settings.model,
    targetLanguage: englishName,
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

/** A Document brief request for `text`, with the same parameters as translation. */
export function buildBriefRequest(
  context: TranslationContext,
  text: string,
  apiKey: string | undefined,
  signal: AbortSignal,
): [string, RequestInit] {
  const briefContext = {
    ...context,
    body: {
      ...context.body,
      messages: [{ role: "system", content: briefSystemPrompt(context.targetLanguage) }],
    },
    userPrefix: "",
  };
  return buildRequest(briefContext, briefUserMessage(text), apiKey, signal);
}

export class RequestError extends Error {
  readonly status: number | undefined;

  constructor(
    status: number | undefined,
    message: string,
    readonly timedOut = false,
  ) {
    super(message);
    this.status = status;
  }
}

const ATTEMPT_TIMEOUT_MS = 120_000;
const RETRY_DELAYS_MS = [1_000, 4_000] as const;
const MAX_RETRY_AFTER_MS = 30_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function abortError(): DOMException {
  return new DOMException("The request was aborted.", "AbortError");
}

function apiKeyFrom(request: [string, RequestInit]): string | undefined {
  const authorization = new Headers(request[1].headers).get("Authorization");
  return authorization?.match(/^Bearer (.+)$/i)?.[1];
}

function redact(message: string, apiKey: string | undefined): string {
  return apiKey ? message.replaceAll(apiKey, "[redacted]") : message;
}

function networkError(error: unknown, apiKey: string | undefined): RequestError {
  const source = error as { message?: string; cause?: { code?: string; message?: string } };
  const cause = source?.cause;
  const details = [cause?.code, cause?.message].filter(Boolean).join(" ");
  return new RequestError(undefined, redact(details || source?.message || String(error), apiKey));
}

function timeoutError(): RequestError {
  return new RequestError(undefined, `Request timed out after ${ATTEMPT_TIMEOUT_MS / 1_000} seconds.`, true);
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("Retry-After");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function wait(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function attempt(
  fetch: typeof globalThis.fetch,
  request: [string, RequestInit],
  apiKey: string | undefined,
): Promise<{ response: Response; text: string }> {
  const parentSignal = request[1].signal;
  if (parentSignal?.aborted) throw abortError();
  const controller = new AbortController();
  let timedOut = false;
  let rejectInterruption: (reason: unknown) => void = () => {};
  const interruption = new Promise<never>((_, reject) => {
    rejectInterruption = reject;
  });
  const onAbort = () => {
    controller.abort();
    rejectInterruption(abortError());
  };
  parentSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectInterruption(timeoutError());
  }, ATTEMPT_TIMEOUT_MS);
  try {
    const response = await Promise.race([
      (async () => {
        const response = await fetch(request[0], { ...request[1], signal: controller.signal });
        return { response, text: await response.text() };
      })(),
      interruption,
    ]);
    return response;
  } catch (error) {
    if (parentSignal?.aborted) throw abortError();
    if (timedOut) throw timeoutError();
    if (error instanceof RequestError) throw error;
    if ((error as Error)?.name === "AbortError") throw abortError();
    throw networkError(error, apiKey);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onAbort);
  }
}

/** Sends a request with transient-failure retries and returns the model's text. */
export async function send(fetch: typeof globalThis.fetch, request: [string, RequestInit]): Promise<string> {
  const signal = request[1].signal;
  const apiKey = apiKeyFrom(request);
  for (let retry = 0; ; retry++) {
    let response: Response;
    let text: string;
    try {
      ({ response, text } = await attempt(fetch, request, apiKey));
    } catch (error) {
      if (signal?.aborted || (error as Error)?.name === "AbortError") throw error;
      if (retry >= RETRY_DELAYS_MS.length) throw error;
      await wait(RETRY_DELAYS_MS[retry], signal);
      continue;
    }
    if (!response.ok) {
      const error = new RequestError(response.status, redact(providerMessage(text), apiKey));
      if (!RETRYABLE_STATUSES.has(response.status) || retry >= RETRY_DELAYS_MS.length) throw error;
      const retryAfter = retryAfterMs(response);
      if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS) throw error;
      await wait(retryAfter ?? RETRY_DELAYS_MS[retry], signal);
      continue;
    }
    let content: unknown;
    try {
      content = JSON.parse(text)?.choices?.[0]?.message?.content;
    } catch {
      throw new RequestError(response.status, `Unreadable response: ${redact(text.slice(0, 200), apiKey)}`);
    }
    if (typeof content !== "string") throw new RequestError(response.status, "No content in response");
    return content.replace(/^\s*<think>[\s\S]*?<\/think>/, "").trim();
  }
}

/** `error.message`, then `error` as a string, then `message`, then the raw body. */
export function providerMessage(text: string): string {
  try {
    const json = JSON.parse(text);
    for (const message of [json?.error?.message, json?.error, json?.message]) {
      if (typeof message === "string") return message;
    }
  } catch {
    // Not JSON; fall through to the raw body.
  }
  return text;
}

export async function resolveApiKey(
  secret: (name: string) => Promise<string | undefined>,
  env: Readonly<Record<string, string | undefined>>,
  source: KeySource,
): Promise<string | undefined> {
  return (await secret(source.secretName)) || (source.envVar && env[source.envVar]) || undefined;
}
