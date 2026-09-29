import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Connection, ConnectionFailure, type ConnectionSettings, openConnection } from "./connection.ts";
import type { KeyChoice } from "./connection-setup.ts";

const SETTINGS: ConnectionSettings = {
  provider: "openrouter",
  customBaseUrl: "",
  customApiKeyEnv: "",
  model: "openai/example",
  reasoningEffort: "low",
};

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

interface ConnectOptions {
  settings?: Partial<ConnectionSettings>;
  secrets?: Record<string, string>;
  env?: Record<string, string | undefined>;
  keyChoice?: KeyChoice;
  now?: () => number;
}

/** A connection whose provider answers with `respond`, and every request it sent. */
function connect(respond: (init: RequestInit) => Response | Promise<Response>, options: ConnectOptions = {}) {
  const sent: Sent[] = [];
  const secretReads: string[] = [];
  const connection = openConnection(
    {
      fetch: (async (url: string, init: RequestInit) => {
        sent.push({
          url,
          method: init.method,
          headers: init.headers as Record<string, string>,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return respond(init);
      }) as typeof fetch,
      secret: async (name) => {
        secretReads.push(name);
        return options.secrets?.[name];
      },
      env: options.env ?? { OPENROUTER_API_KEY: "sk-env" },
      clock: {
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        now: options.now ?? (() => Date.now()),
      },
    },
    { ...SETTINGS, ...options.settings },
    options.keyChoice,
  );
  return { connection, sent, secretReads };
}

const answer = (content: string) => Response.json({ choices: [{ message: { role: "assistant", content } }] });
const sse = (text = "data: {}\n\n") =>
  new Response(text, { headers: { "Content-Type": "text/event-stream" } });
/** A provider that never answers until the request is aborted. */
const hang = (init: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
const complete = (connection: Connection) =>
  connection.complete("System.", "User.", new AbortController().signal);

/** What a call's ConnectionFailure shows the user. */
async function failure(call: Promise<unknown>): Promise<{ message: string; fix?: string }> {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof ConnectionFailure)) throw error;
    return error.fix ? { message: error.message, fix: error.fix } : { message: error.message };
  }
  throw new Error("The call didn't fail.");
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("readiness", () => {
  it.each([
    ["an unknown provider", { settings: { provider: "nope" } }, "Select a provider.", "setUpConnection"],
    [
      "a Custom provider without a base URL",
      { settings: { provider: "custom", customBaseUrl: " " } },
      "Set a Custom provider base URL.",
      "setUpConnection",
    ],
    ["an empty model", { settings: { model: " " } }, "Select a model.", "selectModel"],
    [
      "a Provider preset without a saved or environment key",
      { settings: { provider: "openai" }, env: {} },
      "No API key for OpenAI.",
      "setApiKey",
    ],
  ] as const)(
    "rejects %s the same way before translating and during setup",
    async (_, options, message, fix) => {
      const { connection, sent } = connect(() => sse(), options);
      expect(await failure(connection.check())).toEqual({ message, fix });
      expect(await failure(connection.ping())).toEqual({ message, fix });
      expect(sent).toHaveLength(0);
    },
  );

  it("lets a Custom provider go without a key, and sends no Authorization", async () => {
    const { connection, sent } = connect(() => answer("Hi."), {
      settings: { provider: "custom", customBaseUrl: "http://localhost:1234/api/chat/completions/" },
      env: {},
    });
    await connection.check();
    await complete(connection);
    expect(sent[0].url).toBe("http://localhost:1234/api/chat/completions");
    expect(sent[0].headers).toEqual({ "Content-Type": "application/json" });
    expect(sent[0].body?.reasoning_effort).toBe("low");
  });

  it.each([
    ["SecretStorage before the environment", { secrets: { "apiKey.openrouter": "sk-secret" } }, "sk-secret"],
    [
      "a Custom key from customApiKeyEnv",
      {
        settings: { provider: "custom", customBaseUrl: "http://localhost:1234", customApiKeyEnv: "MY_KEY" },
        env: { MY_KEY: "sk-mine" },
      },
      "sk-mine",
    ],
  ] as const)("reads %s", async (_, options, key) => {
    const { connection, sent } = connect(() => answer("Hi."), options);
    await complete(connection);
    expect(sent[0].headers.Authorization).toBe(`Bearer ${key}`);
  });

  it("reads the key once for a check and the requests that follow it", async () => {
    const { connection, secretReads } = connect(() => answer("Hi."));
    await connection.check();
    await complete(connection);
    await complete(connection);
    expect(secretReads).toEqual(["apiKey.openrouter"]);
  });

  it("uses explicit key choices during setup and omits effort at default", async () => {
    const custom = {
      provider: "custom",
      customBaseUrl: "http://localhost:11434/v1/chat/completions/",
      reasoningEffort: "default" as const,
    };
    const listing = connect(() => Response.json({ data: [{ id: "local" }] }), {
      settings: custom,
      env: { LOCAL_KEY: "environment-secret" },
      keyChoice: { kind: "env", name: "LOCAL_KEY" },
    });
    await listing.connection.listModels();
    expect(listing.sent[0].url).toBe("http://localhost:11434/v1/models");
    expect(listing.sent[0].headers.Authorization).toBe("Bearer environment-secret");

    const pinging = connect(() => sse(), { settings: custom, keyChoice: { kind: "none" } });
    await pinging.connection.ping();
    expect(pinging.sent[0].url).toBe("http://localhost:11434/v1/chat/completions");
    expect(pinging.sent[0].headers.Authorization).toBeUndefined();
    expect(pinging.sent[0].body).toEqual({
      model: "openai/example",
      messages: [{ role: "user", content: "ping" }],
      stream: true,
    });
  });
});

describe("identity", () => {
  const identity = (settings: Partial<ConnectionSettings>) =>
    connect(() => answer(""), { settings }).connection.identity;

  it("covers the URL, model and Reasoning effort field, but not the key source", () => {
    const custom = { provider: "custom", customBaseUrl: "http://localhost:1234/v1" };
    expect(identity({ ...custom, customApiKeyEnv: "OTHER_KEY" })).toBe(identity(custom));
    expect(identity({ ...custom, customBaseUrl: "http://localhost:1234/v1/" })).toBe(identity(custom));
    expect(identity({ ...custom, customBaseUrl: "http://localhost:5678/v1" })).not.toBe(identity(custom));
    expect(identity({ model: "other" })).not.toBe(identity({}));
    expect(identity({ reasoningEffort: "high" })).not.toBe(identity({}));
    expect(identity({ reasoningEffort: "default" })).not.toBe(identity({}));
  });
});

describe("completions", () => {
  it.each([
    ["openrouter", "low", { reasoning: { effort: "low" } }],
    ["openai", "high", { reasoning_effort: "high" }],
    ["deepseek", "none", { reasoning_effort: "none" }],
    ["openrouter", "default", {}],
    ["openai", "default", {}],
  ] as const)("carry the %s effort field for %s", async (provider, reasoningEffort, field) => {
    const { connection, sent } = connect(() => answer("Hi."), {
      settings: { provider, reasoningEffort },
      env: { OPENROUTER_API_KEY: "k", OPENAI_API_KEY: "k", DEEPSEEK_API_KEY: "k" },
    });
    await complete(connection);
    expect(sent[0].body).toEqual({
      model: "openai/example",
      messages: [
        { role: "system", content: "System." },
        { role: "user", content: "User." },
      ],
      stream: false,
      ...field,
    });
  });

  it("honor Retry-After on a 429 before retrying", async () => {
    let attempts = 0;
    const { connection, sent } = connect(() =>
      attempts++ === 0
        ? Response.json(
            { error: { message: "Rate limited" } },
            { status: 429, headers: { "Retry-After": "2" } },
          )
        : answer("Hi."),
    );
    const result = complete(connection);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
    expect(await result).toBe("Hi.");
  });

  it("fail without retrying when Retry-After exceeds 30 seconds", async () => {
    const { connection, sent } = connect(() =>
      Response.json(
        { error: { message: "Rate limited" } },
        { status: 429, headers: { "Retry-After": "31" } },
      ),
    );
    expect(await failure(complete(connection))).toEqual({ message: "Rate limited" });
    expect(sent).toHaveLength(1);
  });

  it("time out a hung request after 120 seconds and retry it twice", async () => {
    const { connection, sent } = connect(hang);
    const result = failure(complete(connection));
    await vi.runAllTimersAsync();
    expect(await result).toEqual({
      message: "Request timed out after 120 seconds. Check VS Code's `http.proxy` setting.",
    });
    expect(sent).toHaveLength(3);
  });
});

describe("setup requests", () => {
  it("list every model ID from the provider without filtering, with no model set", async () => {
    const { connection, sent } = connect(
      () => Response.json({ data: [{ id: "a" }, { id: "z/unusual" }, { id: "a" }] }),
      { settings: { model: "" }, env: { OPENROUTER_API_KEY: "environment-secret" } },
    );
    expect(await connection.listModels()).toEqual(["a", "z/unusual", "a"]);
    expect(sent[0]).toMatchObject({
      url: "https://openrouter.ai/api/v1/models",
      method: "GET",
      headers: { Authorization: "Bearer environment-secret" },
    });
  });

  it("ping until a partial first stream chunk, then abort while the stream remains pending", async () => {
    let aborted = false;
    const now = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(42);
    const { connection, sent } = connect(
      (init) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: {"));
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
      { now },
    );
    expect(await connection.ping()).toBe(32);
    expect(aborted).toBe(true);
    expect(sent[0].body).toEqual({
      model: "openai/example",
      messages: [{ role: "user", content: "ping" }],
      stream: true,
      reasoning: { effort: "low" },
    });
  });

  it("don't report a connection for a non-SSE response or an SSE comment", async () => {
    const html = connect(() => new Response("<html>ok</html>", { headers: { "Content-Type": "text/html" } }));
    expect(await failure(html.connection.ping())).toEqual({ message: "Expected an SSE response." });
    const comment = connect(() => sse(": keepalive\n\n"));
    expect(await failure(comment.connection.ping())).toEqual({ message: "No SSE data in response." });
  });

  it.each([
    ["the model list", (connection: Connection) => connection.listModels()],
    ["Test Connection", (connection: Connection) => connection.ping()],
  ])("time %s out after 120 seconds without retrying", async (_, call) => {
    const { connection, sent } = connect(hang);
    const result = failure(call(connection));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await result).toEqual({
      message: "Request timed out after 120 seconds. Check VS Code's `http.proxy` setting.",
    });
    await vi.runAllTimersAsync();
    expect(sent).toHaveLength(1);
  });
});

describe("failures", () => {
  it.each([
    [401, "No auth credentials found", {}, { message: "No auth credentials found", fix: "setApiKey" }],
    [
      404,
      "Not found",
      { provider: "custom", customBaseUrl: "http://localhost:1234" },
      { message: "Not found. Try adding `/v1` to the Custom provider base URL.", fix: "selectModel" },
    ],
    [
      400,
      "missing-model is not a valid model ID",
      {},
      { message: "missing-model is not a valid model ID", fix: "selectModel" },
    ],
    [407, "Proxy auth", {}, { message: "Proxy auth. Check VS Code's `http.proxy` setting." }],
  ] as const)("classify a %i with its fix", async (status, message, settings, expected) => {
    const { connection } = connect(() => Response.json({ error: { message } }, { status }), { settings });
    expect(await failure(complete(connection))).toEqual(expected);
  });

  it("suggest changing effort only when the failed request carried effort", async () => {
    const unsupported = () => Response.json({ error: { message: "Unsupported" } }, { status: 400 });
    const withEffort = connect(unsupported).connection;
    const noEffort = connect(unsupported, { settings: { reasoningEffort: "default" } }).connection;
    const effortHint = {
      message: "Unsupported. Reasoning effort is set to `low`; try `default`.",
      fix: "setReasoningEffort",
    };
    expect(await failure(withEffort.listModels())).toEqual({ message: "Unsupported" });
    expect(await failure(withEffort.ping())).toEqual(effortHint);
    expect(await failure(complete(withEffort))).toEqual(effortHint);
    expect(await failure(noEffort.ping())).toEqual({ message: "Unsupported" });
  });

  it("keep the chosen key out of provider and network error messages", async () => {
    const keyChoice = { kind: "new", value: "secret-value" } as const;
    const provider = connect(
      () => Response.json({ error: { message: "bad secret-value" } }, { status: 401 }),
      {
        keyChoice,
      },
    );
    expect(await failure(provider.connection.listModels())).toEqual({
      message: "bad [redacted]",
      fix: "setApiKey",
    });

    const network = connect(
      () => {
        throw Object.assign(new Error("fetch failed with secret-value"), {
          cause: { code: "ECONNREFUSED", message: "secret-value refused" },
        });
      },
      { keyChoice },
    );
    expect(await failure(network.connection.listModels())).toEqual({
      message: "ECONNREFUSED [redacted] refused. Check VS Code's `http.proxy` setting.",
    });
  });

  it("redact errors while reading a failed provider response", async () => {
    const key = "mock-secret-key";
    const { connection } = connect(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(
                Object.assign(new Error(`read failed for ${key}`), {
                  cause: { code: "ECONNRESET", message: `${key} connection closed` },
                }),
              );
            },
          }),
          { status: 400 },
        ),
      { keyChoice: { kind: "new", value: key } },
    );
    expect(await failure(connection.ping())).toEqual({
      message: "ECONNRESET [redacted] connection closed. Check VS Code's `http.proxy` setting.",
    });
  });

  it("redact errors while reading the SSE stream", async () => {
    const key = "mock-secret-key";
    const { connection } = connect(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`stream dropped for ${key}`));
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      { keyChoice: { kind: "new", value: key } },
    );
    expect(await failure(connection.ping())).toEqual({
      message: "stream dropped for [redacted]. Check VS Code's `http.proxy` setting.",
    });
  });

  it.each([
    [{ error: { message: "nested" }, message: "outer" }, "nested"],
    [{ error: "string error", message: "outer" }, "string error"],
    [{ error: { message: 123 }, message: "outer" }, "outer"],
  ])("read provider error text by the specified precedence", async (body, expected) => {
    const { connection } = connect(() => Response.json(body, { status: 403 }));
    expect(await failure(connection.listModels())).toEqual({ message: expected });
  });
});
