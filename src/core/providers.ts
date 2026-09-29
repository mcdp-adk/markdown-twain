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
