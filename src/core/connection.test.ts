import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionSettings } from "./connection.ts";
import { scenario } from "./scenario-harness.ts";

const settings: ConnectionSettings = {
  provider: "openrouter",
  customBaseUrl: "",
  customApiKeyEnv: "",
  model: "openai/example",
  reasoningEffort: "low",
};

afterEach(() => vi.useRealTimers());

describe("scenario 15: LLM connection through Twain", () => {
  it("offers actionable missing-setting errors", async () => {
    const { twain } = scenario();
    const custom = { ...settings, provider: "custom" };
    let error: unknown;
    try {
      await twain.testConnection(custom);
    } catch (caught) {
      error = caught;
    }
    expect(twain.classifyConnectionError(error, custom)).toEqual({
      message: "Set a Custom provider base URL.",
      fix: "setUpConnection",
    });
    const noModel = { ...settings, model: "" };
    try {
      await twain.testConnection(noModel);
    } catch (caught) {
      error = caught;
    }
    expect(twain.classifyConnectionError(error, noModel)).toEqual({
      message: "Select a model.",
      fix: "selectModel",
    });
  });

  it("lists every model ID from the provider without filtering", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://openrouter.ai/api/v1/models");
      expect(init.method).toBe("GET");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer environment-secret");
      return Response.json({ data: [{ id: "a" }, { id: "z/unusual" }, { id: "a" }] });
    });
    const { twain } = scenario({
      connectionFetch: fetchImpl,
      env: { OPENROUTER_API_KEY: "environment-secret" },
    });
    expect(await twain.listModels(settings)).toEqual(["a", "z/unusual", "a"]);
  });

  it("aborts after a partial first stream chunk while the stream remains pending", async () => {
    let aborted = false;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toEqual({
        model: "openai/example",
        messages: [{ role: "user", content: "ping" }],
        stream: true,
        reasoning: { effort: "low" },
      });
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
    });
    const now = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(42);
    const { twain } = scenario({ connectionFetch: fetchImpl, now });
    expect(await twain.testConnection(settings)).toBe(32);
    expect(aborted).toBe(true);
  });

  it("does not report a connection for a non-SSE response or an SSE comment", async () => {
    const html = scenario({
      connectionFetch: async () =>
        new Response("<html>ok</html>", { headers: { "Content-Type": "text/html" } }),
    });
    await expect(html.twain.testConnection(settings)).rejects.toThrow("Expected an SSE response.");

    const comment = scenario({
      connectionFetch: async () =>
        new Response(": keepalive\n\n", { headers: { "Content-Type": "text/event-stream" } }),
    });
    await expect(comment.twain.testConnection(settings)).rejects.toThrow("No SSE data in response.");
  });

  it("suggests changing effort only when the failed request carried effort", async () => {
    const { twain } = scenario({
      connectionFetch: async () => Response.json({ error: { message: "Unsupported" } }, { status: 400 }),
    });
    let modelsError: unknown;
    let pingError: unknown;
    let defaultError: unknown;
    try {
      await twain.listModels(settings);
    } catch (error) {
      modelsError = error;
    }
    try {
      await twain.testConnection(settings);
    } catch (error) {
      pingError = error;
    }
    const noEffort = { ...settings, reasoningEffort: "default" as const };
    try {
      await twain.testConnection(noEffort);
    } catch (error) {
      defaultError = error;
    }
    expect(twain.classifyConnectionError(modelsError, settings)).toEqual({ message: "Unsupported" });
    expect(twain.classifyConnectionError(pingError, settings)).toEqual({
      message: "Unsupported. Reasoning effort is set to `low`; try `default`.",
      fix: "setReasoningEffort",
    });
    expect(twain.classifyConnectionError(defaultError, noEffort)).toEqual({ message: "Unsupported" });
  });

  it("uses explicit Custom key choices and omits effort at default", async () => {
    const custom = {
      ...settings,
      provider: "custom",
      customBaseUrl: "http://localhost:11434/v1/chat/completions/",
      reasoningEffort: "default" as const,
    };
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const { twain } = scenario({
      env: { LOCAL_KEY: "environment-secret" },
      connectionFetch: async (url, init) => {
        seen.push({ url, init });
        if (url.endsWith("/models")) return Response.json({ data: [{ id: "local" }] });
        return new Response("data: {", { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    await twain.listModels(custom, { kind: "env", name: "LOCAL_KEY" });
    await twain.testConnection(custom, { kind: "none" });
    expect(seen[0].url).toBe("http://localhost:11434/v1/models");
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe("Bearer environment-secret");
    expect(seen[1].url).toBe("http://localhost:11434/v1/chat/completions");
    expect((seen[1].init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(String(seen[1].init.body))).toEqual({
      model: "openai/example",
      messages: [{ role: "user", content: "ping" }],
      stream: true,
    });
  });

  it("keeps chosen secrets out of provider and network error messages", async () => {
    const { twain } = scenario({
      connectionFetch: async () => Response.json({ error: { message: "bad secret-value" } }, { status: 401 }),
    });
    let error: unknown;
    try {
      await twain.listModels(settings, { kind: "new", value: "secret-value" });
    } catch (caught) {
      error = caught;
    }
    expect(twain.classifyConnectionError(error, settings)).toEqual({
      message: "bad [redacted]",
      fix: "setApiKey",
    });
    const network = scenario({
      connectionFetch: async () => {
        throw Object.assign(new Error("fetch failed with secret-value"), {
          cause: { code: "ECONNREFUSED", message: "secret-value refused" },
        });
      },
    });
    try {
      await network.twain.listModels(settings, { kind: "new", value: "secret-value" });
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toBe("ECONNREFUSED [redacted] refused");
    const classified = network.twain.classifyConnectionError(error, settings);
    expect(classified.message).toContain("ECONNREFUSED [redacted] refused");
    expect(classified.message).not.toContain("secret-value");
  });

  it("shows sanitized cause details when a Document brief loses its connection", async () => {
    const key = "mock-secret-key";
    const s = scenario({
      secrets: { "apiKey.openrouter": key },
      briefReply: () => {
        throw Object.assign(new Error(`fetch failed with ${key}`), {
          cause: { code: "ECONNRESET", message: `connection reset for ${key}` },
        });
      },
    });
    await s.setDisplayMode("bilingual");
    s.render("file:///network.md", "Hello.\n");
    await s.settle();

    expect(s.runEnds).toEqual([
      {
        kind: "halted",
        error: {
          message: "ECONNRESET connection reset for [redacted]. Check VS Code's `http.proxy` setting.",
        },
      },
    ]);
    expect(s.logLines.join("\n")).toContain("ECONNRESET connection reset for [redacted]");
    expect(s.logLines.join("\n")).not.toContain(key);
  });

  it("redacts errors while reading a failed provider response", async () => {
    const key = "mock-secret-key";
    const response = new Response(
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
    );
    const { twain } = scenario({ connectionFetch: async () => response });
    let error: unknown;
    try {
      await twain.testConnection(settings, { kind: "new", value: key });
    } catch (caught) {
      error = caught;
    }

    expect((error as Error).message).toBe("ECONNRESET [redacted] connection closed");
    expect(twain.classifyConnectionError(error, settings)).toEqual({
      message: "ECONNRESET [redacted] connection closed. Check VS Code's `http.proxy` setting.",
    });
  });

  it("redacts errors while reading the SSE stream", async () => {
    const key = "mock-secret-key";
    const { twain } = scenario({
      connectionFetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`stream dropped for ${key}`));
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    let error: unknown;
    try {
      await twain.testConnection(settings, { kind: "new", value: key });
    } catch (caught) {
      error = caught;
    }

    expect((error as Error).message).toBe("stream dropped for [redacted]");
    expect(twain.classifyConnectionError(error, settings)).toEqual({
      message: "stream dropped for [redacted]. Check VS Code's `http.proxy` setting.",
    });
  });

  it.each([
    [{ error: { message: "nested" }, message: "outer" }, "nested"],
    [{ error: "string error", message: "outer" }, "string error"],
    [{ error: { message: 123 }, message: "outer" }, "outer"],
  ])("reads provider error text by the specified precedence", async (body, expected) => {
    const { twain } = scenario({
      connectionFetch: async () => Response.json(body, { status: 403 }),
    });
    let error: unknown;
    try {
      await twain.listModels(settings);
    } catch (caught) {
      error = caught;
    }
    expect(twain.classifyConnectionError(error, settings)).toEqual({ message: expected });
  });
});
