export type EffortStyle = "reasoning_effort" | "openrouter";

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  /** The environment variable read when SecretStorage holds no key. */
  apiKeyEnv: string;
  effortStyle: EffortStyle;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    effortStyle: "reasoning_effort",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    effortStyle: "openrouter",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    effortStyle: "reasoning_effort",
  },
  {
    id: "ollamaCloud",
    label: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    apiKeyEnv: "OLLAMA_API_KEY",
    effortStyle: "reasoning_effort",
  },
];

export const CUSTOM_PROVIDER_ID = "custom";

export const REASONING_EFFORTS = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ProviderConnectionSettings {
  provider: string;
  customBaseUrl: string;
  customApiKeyEnv: string;
}

/** Shared endpoint and credential source for translation and connection setup. */
export function providerConnection(settings: ProviderConnectionSettings) {
  if (settings.provider === CUSTOM_PROVIDER_ID) {
    return {
      baseUrl: normalizeCustomBaseUrl(settings.customBaseUrl),
      secretName: `apiKey.${CUSTOM_PROVIDER_ID}`,
      envVar: settings.customApiKeyEnv,
      effortStyle: "reasoning_effort" as const,
    };
  }
  const preset = PROVIDER_PRESETS.find((item) => item.id === settings.provider);
  if (!preset) return undefined;
  return {
    baseUrl: preset.baseUrl,
    secretName: `apiKey.${preset.id}`,
    envVar: preset.apiKeyEnv,
    effortStyle: preset.effortStyle,
  };
}

/** The Reasoning effort field for a request body; `default` sends nothing. */
export function effortField(style: EffortStyle, effort: ReasoningEffort): Record<string, unknown> {
  if (effort === "default") return {};
  return style === "openrouter" ? { reasoning: { effort } } : { reasoning_effort: effort };
}

/**
 * A Custom base URL is used as entered, except for a trailing `/` and a pasted
 * `/chat/completions`. `/v1` is never appended.
 */
export function normalizeCustomBaseUrl(baseUrl: string): string {
  return baseUrl
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/, "")
    .replace(/\/+$/, "");
}
