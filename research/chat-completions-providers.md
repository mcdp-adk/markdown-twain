# Chat Completions differences across OpenAI, OpenRouter, and compatible providers

Research for [#3](https://github.com/mcdp-adk/markdown-twain/issues/3), part of the wayfinder map [#1](https://github.com/mcdp-adk/markdown-twain/issues/1). Feeds [#7](https://github.com/mcdp-adk/markdown-twain/issues/7) (how think effort is configured and sent).

**Checked:** 2026-09-27. These APIs change often; model names and effort values below are a snapshot of that date.

**Method:** Official API docs first. Where the docs were silent, I used two other first-party sources:

- **Source code**, for the open-source servers: Ollama at [`16b4376`](https://github.com/ollama/ollama/tree/16b4376aeadbec58a18b9817d49c37b1b64e33d0), vLLM at [`24c9772`](https://github.com/vllm-project/vllm/tree/24c9772d19251dbbf70fef75119546827c540c63), and OpenAI's own OpenAPI spec at [`bafb6ad`](https://github.com/openai/openai-openapi/tree/bafb6ade833cc313d354c64644996537f5db5af5).
- **Live probes with a deliberately invalid key**, which show real error bodies and whether a route exists. No valid key was used, so success bodies and model-not-found bodies come from the docs or source, not from live calls.

## Short answer

- **One code path covers the transport:** `POST {baseURL}/chat/completions` and `GET {baseURL}/models` with `Authorization: Bearer <key>`. Every provider here accepts this. Every provider with a documented or observed error body returns errors as `{"error": {"message", ...}}`, except SiliconFlow (`{code, message, data}`) and vLLM's 401 (`{"error": "Unauthorized"}`). LM Studio's error body is not documented.
- **Think effort is where providers split.** There are three families:
  1. **Top-level `reasoning_effort` string:** OpenAI, DeepSeek, Ollama, vLLM, OpenRouter (as an alias), and SiliconFlow for a few models. The accepted values differ, and most providers map unknown values to the nearest supported one.
  2. **OpenRouter's `reasoning` object** (`{effort | max_tokens, exclude, enabled}`). OpenRouter normalizes it for every upstream model.
  3. **Boolean toggle plus token budget:** Alibaba Model Studio and SiliconFlow use `enable_thinking` + `thinking_budget`. vLLM uses `chat_template_kwargs`. LM Studio documents no effort control on `/v1/chat/completions` at all.
- **What happens with an unsupported parameter varies.** It is ignored on OpenRouter, DeepSeek (for sampling parameters in thinking mode) and vLLM (unknown fields). It returns **HTTP 400** on OpenAI (for example `none` on GPT-6 Astra), on OpenRouter when `none` is sent to a model whose reasoning is `mandatory`, and on Ollama when a non-`none` effort is sent to a model without thinking.
- **The model list tells you about reasoning only on OpenRouter and DeepSeek.** OpenRouter has a per-model `reasoning` object and `supported_parameters`; DeepSeek has `effort.supported_levels`. OpenAI, SiliconFlow, Ollama `/v1`, LM Studio `/v1` and vLLM return only the bare OpenAI shape (`id`, `object`, `created`, `owned_by`).
- **Connectivity test:** `GET /models` is not a reliable key check. OpenRouter's `/models` is public and returned 200 with a bad key, and local servers have no auth by default. The only probe that proves base URL + key + model together is a minimal chat completion. The safest form is `stream: true`, cancelled after the first chunk (see [section 4](#4-connectivity-test)).

## Comparison table

| | OpenAI | OpenRouter | DeepSeek | Alibaba Model Studio (Qwen) | SiliconFlow | Ollama | LM Studio | vLLM |
|---|---|---|---|---|---|---|---|---|
| **Base URL** | `https://api.openai.com/v1` | `https://openrouter.ai/api/v1` | `https://api.deepseek.com` (docs); `/v1` also routes | `https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1`; legacy `https://dashscope.aliyuncs.com/compatible-mode/v1`, `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`; US `https://dashscope-us.aliyuncs.com/compatible-mode/v1` | `https://api.siliconflow.com/v1` (intl), `https://api.siliconflow.cn/v1` (CN) | `http://localhost:11434/v1`; cloud `https://ollama.com/v1` | `http://localhost:1234/v1` | `http://localhost:8000/v1` (default port) |
| **Auth** | Bearer; optional `OpenAI-Organization`, `OpenAI-Project` | Bearer; optional `HTTP-Referer`, `X-OpenRouter-Title` (`X-Title` still accepted), `X-OpenRouter-Categories` | Bearer | Bearer; key is region-locked | Bearer | Local: key "required but ignored"; cloud: Bearer | None by default; Bearer when "Require Authentication" is on | None unless `--api-key`; then Bearer on `/v1/*` |
| **Effort field** | `reasoning_effort` | `reasoning: {effort \| max_tokens, exclude, enabled}`; `reasoning_effort` also accepted | `reasoning_effort`; `thinking: {type: enabled\|disabled}` | `enable_thinking` (bool), `thinking_budget` (tokens); `reasoning_effort` only on Qwen Omni | `enable_thinking`, `thinking_budget` (128–32768); `reasoning_effort` on a few models | `reasoning_effort` or `reasoning.effort` (native: `think`) | Not documented on `/v1/chat/completions` | `reasoning_effort`; `chat_template_kwargs`; `thinking_token_budget` |
| **Effort values** | `none, minimal, low, medium, high, xhigh, max` (per model) | `max, xhigh, high, medium, low, minimal, none`; mapped to nearest supported | `none, low, high, max`; `minimal`→`low`, `medium`/`xhigh`→`high` | n/a (boolean + budget) | `high, max`; `low`/`medium`→`high`, `xhigh`→`max` | model-defined; aliases `minimal`→`low`, `xhigh`/`ultra`→`max`, `none`→off | n/a | `none, minimal, low, medium, high, xhigh, max` (enum-validated) |
| **Unsupported effort / parameter** | 400 (e.g. `none` on GPT-6 Astra) | Unsupported params ignored; 400 for `none` on `mandatory` models | temperature/penalties ignored in thinking mode, no error | Thinking model called non-streaming → 400 `InvalidParameter` on some models | Not documented | 400 `"<model>" does not support thinking` if effort ≠ `none` on a non-thinking model | Not documented | Unknown fields ignored (debug log); values outside the enum → 400 |
| **`GET /models` reasoning info** | No | Yes: `reasoning` object + `supported_parameters` | Yes: `effort.supported_levels`, `default_level` | Route exists (401 without key); schema not documented | No | No (use native `POST /api/show` → `thinking`) | No (use native `GET /api/v1/models` → `capabilities.reasoning`) | No |
| **Error body** | `{"error": {message, type, param, code}}`, `code` string | `{"error": {code (number), message, metadata?}}` | OpenAI shape; `/models` without auth header returned plain text | OpenAI shape plus top-level `request_id` | `{"code": <number>, "message", "data"}`; some statuses return a plain string | OpenAI shape (`type` from status) | Not documented | `{"error": {message, type, param, code (int)}}`; 401 is `{"error": "Unauthorized"}` |

## 1. Base URLs

**OpenAI.** The spec's only server is `https://api.openai.com/v1` ([openapi.json `servers`](https://github.com/openai/openai-openapi/blob/bafb6ade833cc313d354c64644996537f5db5af5/openapi.json)). The official Node SDK defaults `baseURL` to that value and builds request URLs by string concatenation (`baseURL + path`, removing one duplicate `/`) ([openai-node `client.ts`](https://github.com/openai/openai-node/blob/master/src/client.ts)). That concatenation is the convention every "OpenAI-compatible" provider documents against: the user supplies everything up to, but not including, `/chat/completions`.

**OpenRouter.** `https://openrouter.ai/api/v1` ([API overview](https://openrouter.ai/docs/api-reference/overview), [`GET /key` OpenAPI servers](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key.md)). Note the `/api` segment. Users who type `https://openrouter.ai/v1` get a 404.

**The `/v1` trap for custom providers.** The documented base URLs disagree on whether `/v1` is present:

- DeepSeek documents `https://api.deepseek.com` with no `/v1` ([Your first API call](https://api-docs.deepseek.com/)). A live probe of `https://api.deepseek.com/v1/models` also returned a JSON 401, so both forms route.
- Alibaba puts `/v1` after a path prefix: `.../compatible-mode/v1`. The docs stress that the base URL "does not include `/chat/completions`". They recommend moving from the legacy `dashscope.aliyuncs.com` / `dashscope-intl.aliyuncs.com` hosts to workspace domains `https://{WorkspaceId}.{region}.maas.aliyuncs.com`. The key must match the region ([OpenAI compatible – Chat](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope), [Error codes – region mismatch](https://www.alibabacloud.com/help/en/model-studio/error-code)).
- SiliconFlow, Ollama, LM Studio and vLLM all end in `/v1` ([SiliconFlow chat](https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions), [SiliconFlow CN chat](https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions), [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), [LM Studio OpenAI compatibility](https://lmstudio.ai/docs/developer/openai-compat)).

**Conclusion.** Store the base URL as the user enters it. Only strip a trailing `/` and a trailing `/chat/completions` that the user may have pasted. Never auto-append `/v1`: Alibaba's `/compatible-mode/v1` would break, and DeepSeek doesn't need it. If `GET {base}/models` or `POST {base}/chat/completions` returns **404** and the URL does not end in `/v1`, show a hint such as "Did you mean `{base}/v1`?" rather than retrying silently.

## 2. Think effort

### OpenAI

- `reasoning_effort` is `"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"` or `null`. The spec says: "Not all reasoning models support every value" ([OpenAPI `ReasoningEffort`](https://github.com/openai/openai-openapi/blob/bafb6ade833cc313d354c64644996537f5db5af5/openapi.json)).
- Defaults depend on the model. `gpt-5.5` defaults to `medium`. GPT-6 Astra does not support `none`: "Setting `reasoning.effort` (Responses) or `reasoning_effort` (Chat Completions) to `none` returns HTTP 400" ([Reasoning models guide](https://developers.openai.com/api/docs/guides/reasoning)).
- When effort is not `none`, the model guide says to remove `temperature`, `top_p` and `top_logprobs`, and for Chat Completions also `logprobs` ([Model guidance](https://developers.openai.com/api/docs/guides/latest-model)). It does not say whether sending them errors. Treat them as unsafe: don't send sampling parameters alongside effort.
- `max_tokens` is deprecated in favour of `max_completion_tokens` and "not compatible with o-series models". `max_completion_tokens` includes reasoning tokens ([OpenAPI `CreateChatCompletionRequest`](https://github.com/openai/openai-openapi/blob/bafb6ade833cc313d354c64644996537f5db5af5/openapi.json)).
- `GET /models` does not say which models reason (see section 3). The only ways to discover effort support are the per-model docs or a 400.

### OpenRouter

- The request takes `reasoning: { effort?, max_tokens?, exclude?, enabled? }`. Use either `effort` (`"max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "none"`) or `max_tokens`, not both. `exclude: true` hides the trace but still bills it ([Reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md)).
- OpenRouter translates effort into each upstream's own vocabulary. For Anthropic it becomes a budget ratio; for Gemini 3 a `thinkingLevel`. "If a model doesn't support a specific effort level … OpenRouter will map your requested effort to the nearest supported level" ([same page](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md)).
- A top-level `reasoning_effort` enum (`xhigh, high, medium, low, minimal, none`) is also accepted ([Parameters](https://openrouter.ai/docs/api_reference/parameters.md)). The legacy `include_reasoning` is a deprecated alias.
- **Unsupported parameters are ignored:** "If the chosen model doesn't support a request parameter … then the parameter is ignored" ([API overview](https://openrouter.ai/docs/api-reference/overview)). By default, routing still sends the request to providers that don't support every parameter; `provider.require_parameters: true` stops that ([Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection.md)).
- **Exception:** when a model's `reasoning.mandatory` is `true`, "do not send `effort: \"none\"` — the model rejects it" ([Reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md)).
- The response carries `message.reasoning` (string) and `message.reasoning_details` (array). In streams, `delta.reasoning_details` is used.
- **Reasoning counts against `max_tokens`.** Too small a cap returns 200 with `finish_reason: "length"` and empty `content` ([Errors and debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging.md)).

### DeepSeek

- The API reference defines `thinking: { type: "enabled" | "disabled" }` (default `enabled`) and `reasoning_effort: "none" | "low" | "high" | "max"`. "`none` disables thinking mode; `low` / `high` / `max` enable thinking mode. The default effort is `high`." It also says `minimal` maps to `low`, and `medium`/`xhigh` map to `high` ([Create chat completion](https://api-docs.deepseek.com/api/create-chat-completion)).
- The thinking-mode guide repeats the mapping, adds `ultra`→`max`, and notes that the OpenAI SDK must send `thinking` through `extra_body` ([Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)).
- In thinking mode, `temperature`, `presence_penalty` and `frequency_penalty` "will not trigger an error but will also have no effect" ([Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)).
- The trace comes back as `message.reasoning_content`.
- Current models are `deepseek-flash` and `deepseek-v4-pro`. The legacy names are still accepted ([Your first API call](https://api-docs.deepseek.com/)).

### Alibaba Model Studio (Qwen)

- There is no general effort enum. Hybrid models take `enable_thinking: true | false` and `thinking_budget` (a maximum token count). Most current models have thinking on by default. Thinking-only models "cannot be disabled" ([Deep thinking](https://www.alibabacloud.com/help/en/model-studio/deep-thinking)).
- `reasoning_effort` is mentioned only for the Qwen3.8 Omni series ([same page](https://www.alibabacloud.com/help/en/model-studio/deep-thinking)).
- These fields are non-standard. The OpenAI Python SDK needs `extra_body`; plain `fetch` can put them at the top level.
- **Hard failure:** some thinking models only allow streaming. Non-streaming calls fail with `400 InvalidParameter`, message `parameter.enable_thinking must be set to false for non-streaming calls` / `parameter.enable_thinking only support stream call` ([Error codes](https://www.alibabacloud.com/help/en/model-studio/error-code)). An out-of-range `thinking_budget` is also a 400.
- The trace comes back as `reasoning_content`.

### SiliconFlow

- `enable_thinking` (boolean) toggles thinking; it applies to "most reasoning models". `thinking_budget` is an integer in 128–32768 ([SiliconFlow CN chat reference](https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions); the [English reference](https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions) lists the models and a 4096 default).
- `reasoning_effort` applies only to `Pro/deepseek-ai/DeepSeek-V4`, `deepseek-ai/DeepSeek-V4-Flash` and `Pro/zai-org/GLM-5.2`. It accepts `"high" | "max"`; `low`/`medium` map to `high` and `xhigh` maps to `max` ([CN reference](https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions)).
- The docs do not say what happens when these fields are sent to other models.

### Ollama

- `/v1/chat/completions` accepts `reasoning_effort` and `reasoning.effort` ([OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)). Mapping, from that page and [`openai/openai.go` `ThinkingFromReasoningEffort`](https://github.com/ollama/ollama/blob/16b4376aeadbec58a18b9817d49c37b1b64e33d0/openai/openai.go):
  - `none` → thinking off.
  - Models with metadata use their own level names; an unsupported name falls back to the model default.
  - Boolean-only models treat any recognized effort as `true`.
  - Models without metadata use aliases: `minimal`→`low`, `xhigh`/`ultra`→`max`.
  - Values outside `minimal, low, medium, high, xhigh, ultra, max, none` → 400.
- **Non-thinking models:** if the resolved value is truthy and the model lacks the thinking capability, the server returns **400** `"<model>" does not support thinking` ([`server/routes.go`](https://github.com/ollama/ollama/blob/16b4376aeadbec58a18b9817d49c37b1b64e33d0/server/routes.go)). The only exception is a flag used on the Anthropic-compatible path. So on Ollama, "send effort to every model" breaks non-thinking models.
- A model's levels are discoverable through the native `POST /api/show`, which returns `thinking: { values, default }`; `values: [false]` means no thinking ([Thinking](https://docs.ollama.com/capabilities/thinking)).
- The trace comes back as `message.reasoning` / `delta.reasoning` ([`openai.go` `Message`](https://github.com/ollama/ollama/blob/16b4376aeadbec58a18b9817d49c37b1b64e33d0/openai/openai.go)).

### LM Studio

- The `/v1/chat/completions` page lists the supported parameters as `model, top_p, top_k, messages, temperature, max_tokens, stream, stop, presence_penalty, frequency_penalty, logit_bias, repeat_penalty, seed`. It has no effort parameter ([Chat Completions](https://lmstudio.ai/docs/developer/openai-compat/chat-completions)).
- Effort is documented only on:
  - `/v1/responses` (`reasoning.effort`, gpt-oss);
  - the native `/api/v1/chat` (`reasoning`: `off | low | medium | high | on`).
  
  See the [changelog](https://lmstudio.ai/llms-full.txt) and [REST API](https://lmstudio.ai/docs/developer/rest).
- The trace is returned as `message.reasoning` for gpt-oss, and as `reasoning_content` for DeepSeek R1 when a developer setting is on.
- LM Studio is closed source, so what happens to an unknown `reasoning_effort` field is unknown.

### vLLM

- `reasoning_effort` is `Literal["none","minimal","low","medium","high","xhigh","max"]`. When set, the server injects `enable_thinking = (effort != "none")` into the chat template unless the caller set it ([`chat_completion/protocol.py`](https://github.com/vllm-project/vllm/blob/24c9772d19251dbbf70fef75119546827c540c63/vllm/entrypoints/openai/chat_completion/protocol.py)).
- Other controls: `chat_template_kwargs` (for example `{"enable_thinking": false}` for Qwen3, `{"thinking": true}` for DeepSeek-V3.1) and `thinking_token_budget`. The trace field is `reasoning`, renamed from `reasoning_content`. Reasoning output needs the server to be started with `--reasoning-parser` ([Reasoning outputs](https://docs.vllm.ai/en/latest/features/reasoning_outputs.html)).
- **Unknown fields are accepted and ignored.** The base model is `extra="allow"` and only logs "fields were present in the request but ignored" at debug level ([`serve/engine/protocol.py`](https://github.com/vllm-project/vllm/blob/24c9772d19251dbbf70fef75119546827c540c63/vllm/entrypoints/serve/engine/protocol.py)). A `reasoning_effort` value outside the enum fails validation (400).

## 3. Model list (`GET {base}/models`)

| Provider | Shape | Reasoning info | Notes |
|---|---|---|---|
| OpenAI | `{object: "list", data: [{id, object: "model", created, owned_by, shutdown_date?}]}` | None | 403 if the key lacks list permission ([OpenAPI `/models`](https://github.com/openai/openai-openapi/blob/bafb6ade833cc313d354c64644996537f5db5af5/openapi.json)). |
| OpenRouter | `{data: [...], total_count, links: {next}}`; each model has `id, canonical_slug, name, created, description, context_length, architecture, pricing, top_provider, per_request_limits, supported_parameters, default_parameters, …` | `reasoning: {mandatory, default_enabled?, supported_efforts?, default_effort?, supports_max_tokens?}`. It is omitted for non-reasoning models. `supported_efforts: null` means all values are accepted; if absent, effort can't be selected. `supported_parameters` includes `reasoning` / `reasoning_effort`. | [List models](https://openrouter.ai/docs/api/api-reference/models/get-models), [Discovering per-model reasoning options](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md). Live on 2026-09-27: 458 models, 326 with a `reasoning` object. **Public:** returned 200 with an invalid key. `/models/user` filters by the account's preferences and requires auth. |
| DeepSeek | OpenAI shape plus `name, context_window, max_output_tokens, input_modalities, output_modalities, effort: {supported_levels, default_level?}, api_capabilities` | `effort.supported_levels` = accepted `reasoning_effort` values (`none` excluded) | [List models](https://api-docs.deepseek.com/api/list-models) |
| Alibaba Model Studio | Not documented | Unknown | `compatible-mode/v1/models` exists (a live probe returned a JSON 401 `invalid_api_key`), but no public schema was found. Treat it as best-effort and allow manual model entry. |
| SiliconFlow | `{object, data: [{id, object, created, owned_by}]}`; filters `type`, `sub_type` (for example `sub_type=chat`) | None | [Get model list](https://docs.siliconflow.com/en/api-reference/models/get-model-list). Includes image/audio/embedding models unless filtered. |
| Ollama | OpenAI shape; `created` = last modified; `owned_by` = user or `"library"` | None on `/v1`. Use native `POST /api/show` (`thinking`, `capabilities`) | [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) |
| LM Studio | OpenAI shape | None on `/v1`. Native `GET /api/v1/models` has `capabilities.reasoning.{allowed_options, default}` | `/v1/models` lists all downloaded models when JIT loading is on, otherwise only loaded ones ([List models](https://lmstudio.ai/docs/developer/openai-compat/models)) |
| vLLM | `{object: "list", data: [{id, object, created, owned_by: "vllm", root, parent, max_model_len, permission}]}` | None | [`ModelCard`](https://github.com/vllm-project/vllm/blob/24c9772d19251dbbf70fef75119546827c540c63/vllm/entrypoints/serve/engine/protocol.py) |

**Conclusion.** Parse only `data[].id` in the shared code path; that field is present everywhere. Read OpenRouter's `reasoning` object as a per-preset extra, and optionally DeepSeek's `effort`. For everything else, reasoning support is unknown from the list.

## 4. Connectivity test

**`GET /models` alone is not enough:**

- OpenRouter's `/models` is public. A live request with a bogus key returned **200**, so it proves nothing about the key.
- `GET https://openrouter.ai/api/v1/key` does validate the key: it returned 401 with a bogus key ([Get current API key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key.md)).
- Local servers (Ollama, LM Studio, vLLM without `--api-key`) accept any key.
- None of these calls proves the chosen model id works.

**The cheapest probe that proves base URL + key + model** is one chat completion:

```json
POST {base}/chat/completions
{ "model": "<id>", "messages": [{ "role": "user", "content": "ping" }], "stream": true }
```

Cancel the `fetch` (`AbortController`) as soon as the first SSE `data:` chunk arrives, or when the HTTP status is non-2xx.

Why this form:

- **Streaming** works on every provider. It also avoids Alibaba's 400 for thinking models called non-streaming ([Error codes](https://www.alibabacloud.com/help/en/model-studio/error-code)). The HTTP status arrives before any tokens.
- **Omit any token cap.** A small cap on a reasoning model can end in 200 + `finish_reason: "length"` + empty content ([OpenRouter errors](https://openrouter.ai/docs/api_reference/errors-and-debugging.md)). It would also force the `max_tokens` vs `max_completion_tokens` choice: OpenAI deprecates `max_tokens` and says it is "not compatible with o-series models", while DeepSeek, Alibaba, SiliconFlow and Ollama document only `max_tokens`. Cancelling the stream caps the cost instead.
- **Omit the effort field** so the test cannot fail on effort support. Test effort separately, or let the first real translation surface it.
- **Watch for mid-stream errors.** After a 200, OpenRouter reports late errors in the stream as a chunk with `error` and `finish_reason: "error"`. The first chunk may be such an error ([Errors and debugging – mid-stream errors](https://openrouter.ai/docs/api_reference/errors-and-debugging.md)).

### Error shapes worth mapping

| User-facing meaning | OpenAI | OpenRouter | DeepSeek | Alibaba | SiliconFlow | Ollama | vLLM |
|---|---|---|---|---|---|---|---|
| **Bad or missing key** | 401, `code: "invalid_api_key"` (bad key) or `code: null` (missing) | 401, `error.code: 401` (live: `"Missing Authentication header"` even for a bad key) | 401, `type: "authentication_error"` | 401, `code: "invalid_api_key"` | 401, `{"code": 30014, "message": "Token is invalid."}` | n/a locally | 401 `{"error": "Unauthorized"}` |
| **Model not found** | 404 (`NotFoundError` in the SDK) | 404 `not_found` | Not documented specifically (the table lists 400 Invalid Format and 422 Invalid Parameters) | 404 `model_not_found` / "The model xxx does not exist"; also "Unsupported model xxx for OpenAI compatibility mode" | Not documented specifically | 404 `model '<id>' not found` | 404 "The model `<id>` does not exist." |
| **No credit / quota** | 429 `credit_balance_exhausted`, `*_spend_limit_exceeded`, `organization_usage_limit_exceeded` | 402 | 402 Insufficient Balance | 400 Arrearage, 403 free tier exhausted, 429 `insufficient_quota` | — | n/a | n/a |
| **Rate limited** | 429 (`Retry-After`) | 429 (`Retry-After`) | 429 | 429 `Throttling.RateQuota` / `limit_requests` | 429 | n/a | n/a |
| **Region / permission** | 403 unsupported country | 403 guardrail / moderation | — | 403 access denied; region/key mismatch | — | n/a | n/a |
| **Overloaded / upstream** | 500, 503 `server_is_overloaded` | 502 model down, 503 no provider | 500, 503 | 500 cluster not found | 503 overloaded, 504 timeout | — | — |

`—` means not documented; `n/a` means the case does not apply to a local server.

Sources: [OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes), [openai-node status→error table](https://github.com/openai/openai-node#handling-errors), [OpenRouter errors](https://openrouter.ai/docs/api_reference/errors-and-debugging.md), [DeepSeek error codes](https://api-docs.deepseek.com/quick_start/error_codes), [Alibaba error codes](https://www.alibabacloud.com/help/en/model-studio/error-code), [SiliconFlow chat reference](https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions), Ollama [`routes.go`](https://github.com/ollama/ollama/blob/16b4376aeadbec58a18b9817d49c37b1b64e33d0/server/routes.go) and [`openai.go` `NewError`](https://github.com/ollama/ollama/blob/16b4376aeadbec58a18b9817d49c37b1b64e33d0/openai/openai.go), vLLM [`serving.py`](https://github.com/vllm-project/vllm/blob/24c9772d19251dbbf70fef75119546827c540c63/vllm/entrypoints/serve/engine/serving.py) and [`authenticate.py`](https://github.com/vllm-project/vllm/blob/24c9772d19251dbbf70fef75119546827c540c63/vllm/entrypoints/serve/middleware/authenticate.py). The 401 bodies for OpenAI, OpenRouter, DeepSeek, Alibaba and SiliconFlow were observed live on 2026-09-27. OpenAI's model-not-found body was not observed live, because that needs a valid key.

**Conclusion.** Classify errors by **HTTP status first**: 401 → key, 402 → credit, 403 → permission/region, 404 → model or URL, 429 → rate/quota, 5xx → provider. Then show the message. To find a message, read `body.error.message` if `body.error` is an object, else `body.error` if it is a string (vLLM 401), else `body.message` (SiliconFlow), else the raw text (DeepSeek's plain-text 401 on `/models` without a header). Don't branch on `code`: it is a string on OpenAI, a number on OpenRouter and vLLM, and absent elsewhere. A 404 on a custom provider is ambiguous: it can mean a bad base URL or a bad model. Show both hints.

## 5. Auth headers

- **All providers:** `Authorization: Bearer <key>`.
- **OpenAI:** optional `OpenAI-Organization` and `OpenAI-Project` select the org/project for multi-org users and legacy user keys ([API overview](https://developers.openai.com/api/reference/overview)). Not needed for project keys.
- **OpenRouter:** attribution headers are optional and only affect rankings/analytics ([App attribution](https://openrouter.ai/docs/app-attribution.md)):
  - `HTTP-Referer` is the app URL. It is required to create an app page.
  - `X-OpenRouter-Title` is the display name. The older `X-Title` is still accepted.
  - `X-OpenRouter-Categories` and `X-OpenRouter-App-Visibility: hidden` are also available.
  - Title-only without a referer creates nothing. `localhost` referers also need a title.
  - For a VS Code extension, sending `HTTP-Referer: https://github.com/mcdp-adk/markdown-twain` and `X-OpenRouter-Title: markdown-twain` is harmless and optional.
- **LM Studio:** auth is off by default. When on, both `Authorization: Bearer` and `x-api-key` are accepted ([LM Studio docs](https://lmstudio.ai/llms-full.txt), [Authentication](https://lmstudio.ai/docs/developer/core/authentication)).
- **Ollama (local):** ignores the key ([OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)).
- **vLLM:** checks the key only on `/v1`, `/v2` and `/inference` ([`cli_args.py`](https://github.com/vllm-project/vllm/blob/24c9772d19251dbbf70fef75119546827c540c63/vllm/entrypoints/launchers/cli_args.py)).
- **Custom providers:** the key should be optional, because local servers work without one.

## 6. What one code path covers, and where per-provider handling is unavoidable

**One code path covers:**

- URL building: `base` + `/chat/completions` and `/models`, with the normalization in section 1.
- Bearer auth, plus optional extra headers per preset.
- The request body `{model, messages, stream}`.
- SSE parsing of `choices[0].delta.content`.
- Model-id listing from `data[].id`.
- Error classification by HTTP status, with the tolerant message extraction in section 4.
- The streaming connectivity probe.

**Per-provider handling is unavoidable for:**

1. **The think-effort field and its values.**
   - OpenAI and OpenRouter presets can send a known field: `reasoning_effort` for OpenAI; `reasoning.effort` (or `reasoning_effort`) for OpenRouter, where OpenRouter maps to the nearest supported level.
   - A custom provider can only be told what to send. Options: `reasoning_effort` (DeepSeek, Ollama, vLLM, some SiliconFlow models), `enable_thinking` + `thinking_budget` (Alibaba, SiliconFlow), or nothing (LM Studio).
   - The values also differ (`none/minimal/low/medium/high/xhigh/max` vs DeepSeek `none/low/high/max` vs SiliconFlow `high/max`).
   - This feeds [#7](https://github.com/mcdp-adk/markdown-twain/issues/7). A likely design: an "off / provider default / explicit effort" control. Send nothing unless the user picks a value, because sending effort can cause a 400 on OpenAI (unsupported value), OpenRouter (`none` on mandatory models) and Ollama (non-thinking models).
2. **Whether a model supports reasoning.** Only OpenRouter (and DeepSeek) expose this in `/models`. On OpenAI and custom providers, the extension cannot know in advance.
3. **Output token cap.** `max_completion_tokens` (OpenAI) vs `max_tokens` (everyone else). Reasoning tokens count against it everywhere, so prefer not sending a cap for translations, or make it per preset.
4. **Key validation for OpenRouter.** `/models` is public; use `GET /key` or the chat probe.
5. **Reasoning trace fields** (only if the extension ever reads them): `reasoning` (OpenRouter, Ollama, vLLM, LM Studio gpt-oss), `reasoning_content` (DeepSeek, Alibaba, SiliconFlow), `reasoning_details` (OpenRouter). For translation, ignore them and read only `content`. Note that some local models still inline `<think>…</think>` in `content` when the server has no reasoning parser (vLLM without `--reasoning-parser`).
6. **Alibaba streaming-only thinking models.** Always stream translation requests. This also removes the 400.
