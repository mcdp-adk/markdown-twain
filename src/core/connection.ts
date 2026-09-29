// The LLM connection: the only code that talks to a provider. It is built from a
// settings snapshot; the adapter injects `fetch`, secrets, the environment, and
// the clock.

import { CUSTOM_PROVIDER_ID, type EffortStyle, PROVIDER_PRESETS, type ReasoningEffort } from "./providers.ts";
import type { Settings } from "./request.ts";

export type ConnectionSettings = Pick<
  Settings,
  "provider" | "customBaseUrl" | "customApiKeyEnv" | "model" | "reasoningEffort"
>;

export interface Clock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface ConnectionDeps {
  fetch: typeof globalThis.fetch;
  /** Reads SecretStorage, for example `apiKey.openai`. */
  secret: (name: string) => Promise<string | undefined>;
  env: Readonly<Record<string, string | undefined>>;
  clock: Clock;
}

/** A key picked during setup, in place of the saved key or the environment. */
export type KeyChoice =
  | { kind: "saved" }
  | { kind: "new"; value: string }
  | { kind: "env"; name: string }
  | { kind: "none" };

export type ConnectionFix = "setUpConnection" | "setApiKey" | "selectModel" | "setReasoningEffort";

/**
 * How every connection call fails, except cancellation, which rejects with an
 * `AbortError`. `message` is for the user; `status` and `detail` (the provider's
 * redacted message) are for the log.
 */
export class ConnectionFailure extends Error {
  constructor(
    message: string,
    readonly fix?: ConnectionFix,
    readonly status?: number,
    readonly detail: string = message,
  ) {
    super(message);
  }
}

/** Where the API key comes from: SecretStorage first, then the environment. */
export interface KeySource {
  secretName: string;
  envVar: string;
}

export function keySource(settings: Pick<Settings, "provider" | "customApiKeyEnv">): KeySource {
  const preset = PROVIDER_PRESETS.find((item) => item.id === settings.provider);
  const custom = settings.provider === CUSTOM_PROVIDER_ID;
  return {
    secretName: `apiKey.${settings.provider}`,
    envVar: preset?.apiKeyEnv ?? (custom ? settings.customApiKeyEnv : ""),
  };
}

export interface Connection {
  /** The chat completions URL, for the log. */
  readonly url: string;
  readonly model: string;
  /** Everything that changes a model's answer: the URL, the model, and the Reasoning effort field. Not the key source. */
  readonly identity: string;
  /** Rejects unless a request could be sent. The key it reads is kept for the calls that follow. */
  check(): Promise<void>;
  /** The model's answer, with transient failures retried and a leading think block removed. */
  complete(system: string, user: string, signal: AbortSignal): Promise<string>;
  /** Every model ID the provider lists, unfiltered. Needs no model set. */
  listModels(): Promise<string[]>;
  /** Milliseconds until the first streamed token. */
  ping(): Promise<number>;
}

const ATTEMPT_TIMEOUT_MS = 120_000;
const RETRY_DELAYS_MS = [1_000, 4_000] as const;
const MAX_RETRY_AFTER_MS = 30_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const PROXY_HINT = "Check VS Code's `http.proxy` setting.";
// Some providers return 400 for an unknown model. The recovery action is still Select Model.
const MODEL_REJECTED =
  /\b(?:not a valid|invalid|unknown|unsupported) model(?: id)?\b|\bmodel(?: id)?\b.{0,40}\b(?:invalid|unknown|not found|does not exist)\b/i;

/** A failed attempt before it is classified. `status` is undefined for network failures and timeouts. */
class AttemptError extends Error {
  constructor(
    readonly status: number | undefined,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/**
 * The connection for a settings snapshot and, during setup, a key choice. It
 * never throws: an unresolved provider or base URL surfaces from its calls.
 */
export function openConnection(
  deps: ConnectionDeps,
  settings: ConnectionSettings,
  keyChoice?: KeyChoice,
): Connection {
  const target = endpoint(settings);
  const url = `${target?.baseUrl ?? ""}/chat/completions`;
  const effort = target ? effortField(target.effortStyle, settings.reasoningEffort) : {};
  const hadEffort = Object.keys(effort).length > 0;
  let apiKey: Promise<string | undefined> | undefined;

  /** Resolves the key once, and rejects unless a request could be sent. */
  async function ready(needsModel: boolean): Promise<string | undefined> {
    if (!target) throw new ConnectionFailure("Select a provider.", "setUpConnection");
    if (!target.baseUrl.trim()) {
      throw new ConnectionFailure("Set a Custom provider base URL.", "setUpConnection");
    }
    if (needsModel && !settings.model.trim()) throw new ConnectionFailure("Select a model.", "selectModel");
    apiKey ??= resolveKey(deps, keySource(settings), keyChoice);
    const key = await apiKey;
    if (!key && settings.provider !== CUSTOM_PROVIDER_ID) {
      throw new ConnectionFailure(`No API key for ${target.label}.`, "setApiKey");
    }
    return key;
  }

  /** One try within the per-attempt timeout: sends, then reads a successful response with `read`. */
  async function attempt<T>(
    requestUrl: string,
    init: RequestInit,
    key: string | undefined,
    signal: AbortSignal | undefined,
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) throw abortError();
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
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = deps.clock.setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectInterruption(timeoutError());
    }, ATTEMPT_TIMEOUT_MS);
    try {
      return await Promise.race([
        (async () => {
          const response = await deps.fetch(requestUrl, { ...init, signal: controller.signal });
          if (!response.ok) {
            const text = await response.text();
            throw new AttemptError(
              response.status,
              redact(providerMessage(text), key),
              retryAfterMs(response, deps.clock.now()),
            );
          }
          return read(response);
        })(),
        interruption,
      ]);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (timedOut) throw timeoutError();
      if (error instanceof AttemptError) throw error;
      if ((error as Error)?.name === "AbortError") throw abortError();
      throw new AttemptError(undefined, networkMessage(error, key));
    } finally {
      deps.clock.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // Ends a stream read only up to its first token.
      controller.abort();
    }
  }

  /** Classifies an attempt's failure; cancellation passes through. */
  function classified(error: unknown, requestHadEffort: boolean): unknown {
    if (!(error instanceof AttemptError)) return error;
    const { status, message } = error;
    const fail = (text: string, fix?: ConnectionFix) => new ConnectionFailure(text, fix, status, message);
    if (status === 401) return fail(message, "setApiKey");
    if (status === 404) {
      return fail(
        settings.provider === CUSTOM_PROVIDER_ID
          ? `${message}. Try adding \`/v1\` to the Custom provider base URL.`
          : message,
        "selectModel",
      );
    }
    if (status === 400 && MODEL_REJECTED.test(message)) return fail(message, "selectModel");
    if (status === 400 && requestHadEffort) {
      return fail(
        `${message}. Reasoning effort is set to \`${settings.reasoningEffort}\`; try \`default\`.`,
        "setReasoningEffort",
      );
    }
    if (status === 407) return fail(`${message}. ${PROXY_HINT}`);
    if (status !== undefined) return fail(message);
    return fail(`${message.replace(/\.$/, "")}. ${PROXY_HINT}`);
  }

  return {
    url,
    model: settings.model,
    identity: JSON.stringify({ url, model: settings.model, effort }),

    async check() {
      await ready(true);
    },

    async complete(system, user, signal) {
      const key = await ready(true);
      const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json", ...credentials(key) },
        body: JSON.stringify({
          model: settings.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          stream: false,
          ...effort,
        }),
      };
      for (let retry = 0; ; retry++) {
        let response: { status: number; text: string };
        try {
          response = await attempt(url, init, key, signal, async (r) => ({
            status: r.status,
            text: await r.text(),
          }));
        } catch (error) {
          if (!(error instanceof AttemptError)) throw error;
          const retryable = error.status === undefined || RETRYABLE_STATUSES.has(error.status);
          const tooLong = error.retryAfterMs !== undefined && error.retryAfterMs > MAX_RETRY_AFTER_MS;
          if (!retryable || tooLong || retry >= RETRY_DELAYS_MS.length) throw classified(error, hadEffort);
          await wait(deps.clock, error.retryAfterMs ?? RETRY_DELAYS_MS[retry], signal);
          continue;
        }
        let content: unknown;
        try {
          content = JSON.parse(response.text)?.choices?.[0]?.message?.content;
        } catch {
          throw new ConnectionFailure(
            `Unreadable response: ${redact(response.text.slice(0, 200), key)}`,
            undefined,
            response.status,
          );
        }
        if (typeof content !== "string") {
          throw new ConnectionFailure("No content in response", undefined, response.status);
        }
        return content.replace(/^\s*<think>[\s\S]*?<\/think>/, "").trim();
      }
    },

    async listModels() {
      const key = await ready(false);
      try {
        return await attempt(
          `${target?.baseUrl}/models`,
          { method: "GET", headers: credentials(key) },
          key,
          undefined,
          async (response) => {
            let json: unknown;
            try {
              json = await response.json();
            } catch {
              throw new AttemptError(response.status, "Unreadable model list response.");
            }
            const data = (json as { data?: unknown })?.data;
            if (!Array.isArray(data)) throw new AttemptError(response.status, "No model list in response.");
            return data.flatMap((item: unknown) => {
              const id = (item as { id?: unknown })?.id;
              return typeof id === "string" ? [id] : [];
            });
          },
        );
      } catch (error) {
        throw classified(error, false);
      }
    },

    async ping() {
      const key = await ready(true);
      const start = deps.clock.now();
      const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json", ...credentials(key) },
        body: JSON.stringify({
          model: settings.model,
          messages: [{ role: "user", content: "ping" }],
          stream: true,
          ...effort,
        }),
      };
      try {
        return await attempt(url, init, key, undefined, async (response) => {
          if (!/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get("Content-Type")?.trim() ?? "")) {
            throw new AttemptError(response.status, "Expected an SSE response.");
          }
          if (!response.body) throw new AttemptError(response.status, "No streaming response.");
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let text = "";
          while (true) {
            const next = await reader.read();
            if (next.done) throw new AttemptError(response.status, "No SSE data in response.");
            text += decoder.decode(next.value, { stream: true });
            if (/(?:^|\r?\n)data:[ \t]*\S/.test(text)) {
              const elapsed = deps.clock.now() - start;
              void reader.cancel().catch(() => undefined);
              return elapsed;
            }
          }
        });
      } catch (error) {
        throw classified(error, hadEffort);
      }
    },
  };
}

function endpoint(settings: ConnectionSettings) {
  if (settings.provider === CUSTOM_PROVIDER_ID) {
    return {
      label: "Custom",
      baseUrl: normalizeCustomBaseUrl(settings.customBaseUrl),
      effortStyle: "reasoning_effort" as EffortStyle,
    };
  }
  const preset = PROVIDER_PRESETS.find((item) => item.id === settings.provider);
  return preset && { label: preset.label, baseUrl: preset.baseUrl, effortStyle: preset.effortStyle };
}

/**
 * A Custom base URL is used as entered, except for a trailing `/` and a pasted
 * `/chat/completions`. `/v1` is never appended.
 */
function normalizeCustomBaseUrl(baseUrl: string): string {
  return baseUrl
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/, "")
    .replace(/\/+$/, "");
}

/** The Reasoning effort field for a request body; `default` sends nothing. */
function effortField(style: EffortStyle, effort: ReasoningEffort): Record<string, unknown> {
  if (effort === "default") return {};
  return style === "openrouter" ? { reasoning: { effort } } : { reasoning_effort: effort };
}

async function resolveKey(
  deps: ConnectionDeps,
  source: KeySource,
  choice: KeyChoice | undefined,
): Promise<string | undefined> {
  if (choice?.kind === "new") return choice.value || undefined;
  if (choice?.kind === "none") return undefined;
  if (choice?.kind === "env") return deps.env[choice.name] || undefined;
  if (choice) return (await deps.secret(source.secretName)) || undefined;
  return (await deps.secret(source.secretName)) || (source.envVar && deps.env[source.envVar]) || undefined;
}

function credentials(key: string | undefined): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** `error.message`, then `error` as a string, then `message`, then the raw body. */
function providerMessage(text: string): string {
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

/** Removes the key before an error can reach the UI or log. */
function redact(message: string, key: string | undefined): string {
  return key ? message.replaceAll(key, "[redacted]") : message;
}

/** A network failure's cause code and message, redacted, falling back to the error's own message. */
function networkMessage(error: unknown, key: string | undefined): string {
  const source = error as { message?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
  const cause = source?.cause;
  const details = [cause?.code, cause?.message].filter((part) => typeof part === "string" && part).join(" ");
  return redact(details || (typeof source?.message === "string" ? source.message : String(error)), key);
}

function retryAfterMs(response: Response, now: number): number | undefined {
  const value = response.headers.get("Retry-After");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function abortError(): DOMException {
  return new DOMException("The request was aborted.", "AbortError");
}

function timeoutError(): AttemptError {
  return new AttemptError(undefined, `Request timed out after ${ATTEMPT_TIMEOUT_MS / 1_000} seconds.`);
}

function wait(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clock.clearTimeout(timer);
      reject(abortError());
    };
    const timer = clock.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type SetupStep = "provider" | "baseUrl" | "apiKey" | "model" | "reasoningEffort";

export function setupSteps(provider: string, effort: ReasoningEffort): SetupStep[] {
  return [
    "provider",
    ...(provider === CUSTOM_PROVIDER_ID ? ["baseUrl" as const] : []),
    "apiKey",
    "model",
    ...(effort === "default" ? [] : ["reasoningEffort" as const]),
  ];
}
