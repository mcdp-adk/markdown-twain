import { networkFailure, redact } from "./error-message.ts";
import { CUSTOM_PROVIDER_ID, effortField, providerConnection, type ReasoningEffort } from "./providers.ts";
import { providerMessage, RequestError, resolveApiKey, type Settings } from "./request.ts";

export type ConnectionSettings = Pick<
  Settings,
  "provider" | "customBaseUrl" | "customApiKeyEnv" | "model" | "reasoningEffort"
>;

export interface ConnectionDeps {
  fetch: typeof fetch;
  secret: (name: string) => Promise<string | undefined>;
  env: Readonly<Record<string, string | undefined>>;
  now: () => number;
}

export type KeyChoice =
  | { kind: "saved" }
  | { kind: "new"; value: string }
  | { kind: "env"; name: string }
  | { kind: "none" };

type Fix =
  | "setApiKey"
  | "selectModel"
  | "setReasoningEffort"
  | "setUpConnection"
  | "openTargetLanguageSetting";
type ClassifiedError = { message: string; fix?: Fix };
type SetupStep = "provider" | "baseUrl" | "apiKey" | "model" | "reasoningEffort";

class ConnectionRequestError extends RequestError {
  constructor(
    status: number,
    message: string,
    readonly hadEffort: boolean,
  ) {
    super(status, message);
  }
}

class SetupError extends Error {
  constructor(
    message: string,
    readonly fix?: Fix,
  ) {
    super(message);
  }
}

export function setupSteps(provider: string, effort: ReasoningEffort): SetupStep[] {
  return [
    "provider",
    ...(provider === CUSTOM_PROVIDER_ID ? ["baseUrl" as const] : []),
    "apiKey",
    "model",
    ...(effort === "default" ? [] : ["reasoningEffort" as const]),
  ];
}

function endpoint(settings: ConnectionSettings, suffix: "models" | "chat/completions") {
  const connection = providerConnection(settings);
  if (!connection) throw new SetupError("Select a provider.", "setUpConnection");
  if (!connection.baseUrl) throw new SetupError("Set a Custom provider base URL.", "setUpConnection");
  return {
    url: `${connection.baseUrl}/${suffix}`,
    keySource: { secretName: connection.secretName, envVar: connection.envVar },
    style: connection.effortStyle,
  };
}

async function resolveKey(
  deps: ConnectionDeps,
  source: { secretName: string; envVar: string },
  choice?: KeyChoice,
): Promise<string | undefined> {
  if (choice?.kind === "new") return choice.value || undefined;
  if (choice?.kind === "none") return undefined;
  if (choice?.kind === "env") return deps.env[choice.name] || undefined;
  if (choice) return (await deps.secret(source.secretName)) || undefined;
  return resolveApiKey(deps.secret, deps.env, source);
}

function credentials(key: string | undefined): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function requireKey(settings: ConnectionSettings, key: string | undefined): void {
  if (!key && settings.provider !== CUSTOM_PROVIDER_ID) {
    throw new SetupError("Set an API key for this provider.", "setApiKey");
  }
}

async function fetchResponse(
  deps: ConnectionDeps,
  url: string,
  init: RequestInit,
  key: string | undefined,
  hadEffort = false,
) {
  let response: Response;
  try {
    response = await deps.fetch(url, init);
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    throw networkFailure(error, key);
  }
  if (!response.ok) {
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if ((error as Error)?.name === "AbortError") throw error;
      throw networkFailure(error, key);
    }
    throw new ConnectionRequestError(response.status, redact(providerMessage(text), key), hadEffort);
  }
  return response;
}

export async function listModels(
  deps: ConnectionDeps,
  settings: ConnectionSettings,
  keyChoice?: KeyChoice,
): Promise<string[]> {
  const target = endpoint(settings, "models");
  const key = await resolveKey(deps, target.keySource, keyChoice);
  requireKey(settings, key);
  const response = await fetchResponse(deps, target.url, { method: "GET", headers: credentials(key) }, key);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new RequestError(response.status, "Unreadable model list response.");
  }
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new RequestError(response.status, "No model list in response.");
  return data.flatMap((item: unknown) => {
    const id = (item as { id?: unknown })?.id;
    return typeof id === "string" ? [id] : [];
  });
}

export async function testConnection(
  deps: ConnectionDeps,
  settings: ConnectionSettings,
  keyChoice?: KeyChoice,
): Promise<number> {
  const target = endpoint(settings, "chat/completions");
  if (!settings.model) throw new SetupError("Select a model.", "selectModel");
  const key = await resolveKey(deps, target.keySource, keyChoice);
  requireKey(settings, key);
  const controller = new AbortController();
  const start = deps.now();
  const response = await fetchResponse(
    deps,
    target.url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...credentials(key) },
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: "user", content: "ping" }],
        stream: true,
        ...effortField(target.style, settings.reasoningEffort),
      }),
      signal: controller.signal,
    },
    key,
    settings.reasoningEffort !== "default",
  );
  if (!/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get("Content-Type")?.trim() ?? "")) {
    controller.abort();
    throw new RequestError(response.status, "Expected an SSE response.");
  }
  if (!response.body) {
    controller.abort();
    throw new RequestError(response.status, "No streaming response.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) throw new RequestError(response.status, "No SSE data in response.");
      text += decoder.decode(next.value, { stream: true });
      if (/(?:^|\r?\n)data:[ \t]*\S/.test(text)) {
        const elapsed = deps.now() - start;
        controller.abort();
        void reader.cancel().catch(() => undefined);
        return elapsed;
      }
    }
  } catch (error) {
    if (error instanceof RequestError || (error as Error)?.name === "AbortError") throw error;
    throw networkFailure(error, key);
  } finally {
    controller.abort();
  }
}

const PROXY_HINT = "Check VS Code's `http.proxy` setting.";

export function classifyConnectionError(
  error: unknown,
  settings: ConnectionSettings,
  requestHadEffort = false,
): ClassifiedError {
  const issue = error as {
    status?: number;
    message?: string;
    cause?: { code?: string; message?: string };
    fix?: Fix;
  };
  const status = issue?.status;
  const message = issue?.message || String(error);
  if (status === 401) return { message, fix: "setApiKey" };
  if (status === 404)
    return {
      message:
        settings.provider === CUSTOM_PROVIDER_ID
          ? `${message}. Try adding \`/v1\` to the Custom provider base URL.`
          : message,
      fix: "selectModel",
    };
  // Some providers return 400 for an unknown model. The recovery action is still Select Model.
  if (
    status === 400 &&
    /\b(?:not a valid|invalid|unknown|unsupported) model(?: id)?\b|\bmodel(?: id)?\b.{0,40}\b(?:invalid|unknown|not found|does not exist)\b/i.test(
      message,
    )
  )
    return { message, fix: "selectModel" };
  if (status === 400 && (error instanceof ConnectionRequestError ? error.hadEffort : requestHadEffort))
    return {
      message: `${message}. Reasoning effort is set to \`${settings.reasoningEffort}\`; try \`default\`.`,
      fix: "setReasoningEffort",
    };
  if (status === 407) return { message: `${message}. ${PROXY_HINT}` };
  if (status !== undefined) return { message };
  if (error instanceof SetupError) return { message, ...(issue.fix ? { fix: issue.fix } : {}) };
  const cause = issue?.cause;
  const causeText = [cause?.code, cause?.message].filter(Boolean).join(" ");
  return { message: `${causeText || message}. ${PROXY_HINT}` };
}
