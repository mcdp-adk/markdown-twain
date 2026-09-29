import { describe, expect, it } from "vitest";
import type { ConnectionSettings } from "./connection.ts";
import {
  type Choice,
  type InputOptions,
  type Prompter,
  type StepOptions,
  type StepResult,
  selectModel,
  setApiKey,
  setReasoningEffort,
  setUpConnection,
} from "./connection-setup.ts";

const SETTINGS: ConnectionSettings = {
  provider: "openai",
  customBaseUrl: "",
  customApiKeyEnv: "",
  model: "gpt-old",
  reasoningEffort: "default",
};

/** How a scripted user answers one prompt. */
type Answer = { pick: string } | { input: string } | "back" | "cancel";

/** A prompt as the user saw it. */
interface Shown extends StepOptions {
  kind: "pick" | "input";
  items?: Pick<Choice<unknown>, "label" | "detail" | "current" | "masked">[];
  active?: string;
  value?: string;
  password?: boolean;
  required?: boolean;
}

interface SetupOptions {
  settings?: Partial<ConnectionSettings>;
  secrets?: Record<string, string | undefined>;
  env?: Record<string, string | undefined>;
  /** The provider's answer to `GET /models`; the default lists `MODELS`. */
  models?: () => Response;
}

const MODELS = ["openai/gpt-6-luna", "vendor/other"];

/**
 * Runs a Connection setup command against a user who gives `answers` in order,
 * and a provider that lists `MODELS`.
 */
async function setUp(command: typeof setUpConnection, answers: Answer[], options: SetupOptions = {}) {
  const shown: Shown[] = [];
  const modelRequests: { url: string; headers: Record<string, string> }[] = [];
  const next = (kind: Shown["kind"]): Answer => {
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`No answer left for ${JSON.stringify(shown.at(-1))}`);
    if (typeof answer === "object" && !(kind in answer)) {
      throw new Error(`Expected a ${kind} answer, got ${JSON.stringify(answer)}`);
    }
    return answer;
  };
  const prompter: Prompter = {
    async pick<T>(items: Choice<T>[], stepOptions: StepOptions, active?: Choice<T>) {
      shown.push({
        kind: "pick",
        ...stepOptions,
        items: items.map(({ label, detail, current, masked }) => ({ label, detail, current, masked })),
        active: active?.label,
      });
      const answer = next("pick");
      if (typeof answer === "string") return { kind: answer };
      const item = items.find((candidate) => candidate.label === (answer as { pick: string }).pick);
      if (!item) throw new Error(`No item ${JSON.stringify(answer)} in ${JSON.stringify(shown.at(-1))}`);
      return { kind: "selected", value: item.value } satisfies StepResult<T>;
    },
    async input(inputOptions: InputOptions) {
      shown.push({ kind: "input", ...inputOptions });
      const answer = next("input");
      if (typeof answer === "string") return { kind: answer };
      return { kind: "selected", value: (answer as { input: string }).input };
    },
  };
  const result = await command(
    {
      fetch: (async (url: string, init: RequestInit) => {
        modelRequests.push({ url, headers: init.headers as Record<string, string> });
        return options.models?.() ?? Response.json({ data: MODELS.map((id) => ({ id })) });
      }) as typeof fetch,
      secret: async (name) => options.secrets?.[name],
      env: options.env ?? { OPENROUTER_API_KEY: "sk-or-env" },
      clock: {
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        now: () => Date.now(),
      },
    },
    prompter,
    { ...SETTINGS, ...options.settings },
  );
  if (answers.length > 0) throw new Error(`Unused answers: ${JSON.stringify(answers)}`);
  return { result, shown, modelRequests };
}

describe("Set Up LLM Connection", () => {
  it("walks a Provider preset through its steps and returns only what changed", async () => {
    const { result, shown, modelRequests } = await setUp(setUpConnection, [
      { pick: "OpenRouter" },
      { pick: "Use $OPENROUTER_API_KEY" },
      { pick: "openai/gpt-6-luna" },
    ]);
    expect(result).toEqual({
      settings: { provider: "openrouter", model: "openai/gpt-6-luna" },
      secret: { kind: "delete", name: "apiKey.openrouter" },
    });
    expect(shown.map((prompt) => [prompt.title, `${prompt.step}/${prompt.totalSteps}`])).toEqual([
      ["Set Up LLM Connection", "1/3"],
      ["Set Up LLM Connection", "2/3"],
      ["Set Up LLM Connection", "3/3"],
    ]);
    expect(modelRequests).toEqual([
      { url: "https://openrouter.ai/api/v1/models", headers: { Authorization: "Bearer sk-or-env" } },
    ]);
  });

  it.each([
    {
      keyAnswers: [{ pick: "No key" }],
      env: {},
      customApiKeyEnv: undefined,
      headers: {},
    },
    {
      keyAnswers: [{ pick: "Read it from an environment variable…" }, { input: "LOCAL_KEY" }],
      env: { LOCAL_KEY: "sk-local" },
      customApiKeyEnv: "LOCAL_KEY",
      headers: { Authorization: "Bearer sk-local" },
    },
  ] as const)(
    "asks a Custom provider for its base URL and deletes the saved key when it takes $keyAnswers.0.pick",
    async ({ keyAnswers, env, customApiKeyEnv, headers }) => {
      const { result, shown, modelRequests } = await setUp(
        setUpConnection,
        [
          { pick: "Custom…" },
          { input: "http://localhost:11434/v1" },
          ...keyAnswers,
          { pick: "vendor/other" },
        ],
        { env, secrets: { "apiKey.custom": "sk-saved" } },
      );
      expect(result).toEqual({
        settings: {
          provider: "custom",
          customBaseUrl: "http://localhost:11434/v1",
          ...(customApiKeyEnv && { customApiKeyEnv }),
          model: "vendor/other",
        },
        secret: { kind: "delete", name: "apiKey.custom" },
      });
      expect(shown[1]).toMatchObject({ kind: "input", step: 2, totalSteps: 4, required: true });
      expect(modelRequests).toEqual([{ url: "http://localhost:11434/v1/models", headers }]);
    },
  );

  it("goes Back from an input to its pick, and from a step to the draft before it", async () => {
    const { result, shown } = await setUp(
      setUpConnection,
      [
        { pick: "OpenRouter" },
        { pick: "Enter an API key…" },
        "back",
        "back",
        { pick: "OpenAI" },
        { pick: "Enter an API key…" },
        { input: "sk-openai" },
        { pick: "vendor/other" },
        { pick: "high" },
      ],
      { settings: { reasoningEffort: "low" } },
    );
    expect(result).toEqual({
      settings: { model: "vendor/other", reasoningEffort: "high" },
      secret: { kind: "store", name: "apiKey.openai", value: "sk-openai" },
    });
    expect(shown.map(({ title, step, active }) => [title, step, active])).toEqual([
      ["Set Up LLM Connection", 1, "OpenAI"],
      ["Set Up LLM Connection", 2, undefined],
      ["Enter API Key", 2, undefined],
      ["Set Up LLM Connection", 2, undefined],
      ["Set Up LLM Connection", 1, "OpenAI"],
      ["Set Up LLM Connection", 2, undefined],
      ["Enter API Key", 2, undefined],
      ["Set Up LLM Connection", 3, undefined],
      ["Set Up LLM Connection", 4, "low"],
    ]);
  });

  it("asks for the Reasoning effort only when it isn't default, offering the current effort first", async () => {
    const { shown } = await setUp(
      setUpConnection,
      [{ pick: "OpenRouter" }, { pick: "Use $OPENROUTER_API_KEY" }, { pick: "vendor/other" }, "cancel"],
      { settings: { reasoningEffort: "medium" } },
    );
    expect(shown.map((prompt) => prompt.totalSteps)).toEqual([4, 4, 4, 4]);
    expect(shown[3].active).toBe("medium");
    expect(shown[3].items?.[0]).toMatchObject({ label: "medium", current: true });
  });

  it("saves nothing when cancelled", async () => {
    const { result } = await setUp(setUpConnection, [
      { pick: "OpenRouter" },
      { pick: "Enter an API key…" },
      { input: "sk-new" },
      "cancel",
    ]);
    expect(result).toBeUndefined();
  });
});

describe("API-key step", () => {
  it.each([
    {
      name: "a Provider preset with its environment variable set",
      settings: { provider: "openrouter" },
      secrets: {},
      items: [{ label: "Enter an API key…" }, { label: "Use $OPENROUTER_API_KEY" }],
      placeHolder: undefined,
    },
    {
      name: "a Provider preset with a saved key and no environment variable",
      settings: { provider: "openai" },
      secrets: { "apiKey.openai": "sk-saved" },
      items: [{ label: "Keep the saved key", masked: true }, { label: "Replace it with a new key…" }],
      placeHolder: "You can export $OPENAI_API_KEY in the extension host environment instead.",
    },
    {
      name: "a Custom provider",
      settings: { provider: "custom", customBaseUrl: "http://localhost:11434/v1" },
      secrets: {},
      items: [
        { label: "Enter an API key…" },
        { label: "Read it from an environment variable…" },
        { label: "No key" },
      ],
      placeHolder: undefined,
    },
  ])("offers the key sources of $name", async ({ settings, secrets, items, placeHolder }) => {
    const { result, shown } = await setUp(setApiKey, ["cancel"], { settings, secrets });
    expect(result).toBeUndefined();
    expect(shown[0].items).toEqual(items.map((item) => ({ detail: undefined, current: undefined, ...item })));
    expect(shown[0].placeHolder).toBe(placeHolder);
  });
});

describe("model step", () => {
  it("shows why the model list failed and still takes a model ID", async () => {
    const { result, shown } = await setUp(
      selectModel,
      [{ pick: "Enter a model ID…" }, { input: "my/model" }],
      {
        settings: { provider: "openrouter", model: "vendor/other" },
        models: () => Response.json({ error: { message: "Upstream down" } }, { status: 500 }),
      },
    );
    expect(result).toEqual({ settings: { model: "my/model" } });
    expect(shown).toMatchObject([
      {
        placeHolder: "Could not load models: Upstream down",
        items: [{ label: "Enter a model ID…", detail: "Could not load models: Upstream down" }],
      },
      { kind: "input", title: "Enter Model ID", value: "vendor/other", canBack: true, required: true },
    ]);
  });

  it("names a current model the provider doesn't list", async () => {
    const { shown } = await setUp(selectModel, ["cancel"], {
      settings: { provider: "openrouter", model: "gone/model" },
    });
    expect(shown[0].placeHolder).toBe("Current model gone/model is not in this provider's model list.");
  });
});

describe("single-step commands", () => {
  it("Select Model marks the current model and changes only the model", async () => {
    const { result, shown } = await setUp(selectModel, [{ pick: "openai/gpt-6-luna" }], {
      settings: { provider: "openrouter", model: "vendor/other", reasoningEffort: "low" },
    });
    expect(result).toEqual({ settings: { model: "openai/gpt-6-luna" } });
    expect(shown).toMatchObject([
      {
        title: "Select Model",
        items: [
          { label: "Enter a model ID…" },
          { label: "openai/gpt-6-luna", current: false },
          { label: "vendor/other", current: true },
        ],
      },
    ]);
  });

  it("Set Reasoning Effort offers the current effort first and changes only the effort", async () => {
    const { result, shown } = await setUp(setReasoningEffort, [{ pick: "high" }], {
      settings: { reasoningEffort: "low" },
    });
    expect(result).toEqual({ settings: { reasoningEffort: "high" } });
    expect(shown).toMatchObject([{ title: "Set Reasoning Effort", active: "low" }]);
    expect(shown[0].items?.map((item) => item.label)).toEqual([
      "low",
      "default",
      "none",
      "minimal",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("Set API Key stores a new key for a Provider preset, changing no setting", async () => {
    const { result, shown } = await setUp(setApiKey, [{ pick: "Enter an API key…" }, { input: "sk-new" }]);
    expect(result).toEqual({
      settings: {},
      secret: { kind: "store", name: "apiKey.openai", value: "sk-new" },
    });
    expect(shown).toMatchObject([
      { title: "Set API Key" },
      { title: "Enter API Key", password: true, required: true },
    ]);
  });

  it("Set API Key for a Custom provider writes the environment variable it reads and deletes the saved key", async () => {
    const { result } = await setUp(
      setApiKey,
      [{ pick: "Read it from an environment variable…" }, { input: "MY_KEY" }],
      { settings: { provider: "custom", customBaseUrl: "http://localhost:11434/v1" } },
    );
    expect(result).toEqual({
      settings: { customApiKeyEnv: "MY_KEY" },
      secret: { kind: "delete", name: "apiKey.custom" },
    });
  });
});
