# Read Frog's page-translation pipeline: what markdown-twain can reuse

Research for [#5](https://github.com/mcdp-adk/markdown-twain/issues/5), part of the wayfinder map [#1](https://github.com/mcdp-adk/markdown-twain/issues/1). Feeds [#8](https://github.com/mcdp-adk/markdown-twain/issues/8) (translation request format).

**Source:** [mengxi-ream/read-frog](https://github.com/mengxi-ream/read-frog) at commit [`b4a45b9`](https://github.com/mengxi-ream/read-frog/tree/b4a45b9455eb0f63b450cb9610d87ac33883f0e9) (2026-09-27), read from the local clone. Every `path:line` below is relative to `src/` at that commit. Links are pinned permalinks, so the exact prompt text can be read upstream.

**Why the prompt text is linked, not pasted:** Read Frog is GPL-3.0 (see [License](#8-license-facts-gpl-30)). This note gives the structure, rules and exact location of every prompt. It does not copy the prompt bodies into this repo before the license question is settled. The token names, the `%%` separator, the `{{NO_TRANSLATION_NEEDED}}` sentinel and the `data-rf-attr` marker name are quoted because they are protocol identifiers.

## Short answer

Read Frog builds one request from a **system prompt** and a short **user prompt**. For page translation the system prompt is a base prompt (`default` or `precision-rewrite`) plus rule blocks that are added only when needed: multi-paragraph batching, the "already in target language" sentinel, HTML-marker rules, placeholder rules, and glossary. Up to 4 paragraphs (1,000 characters by default) are joined with a line containing only `%%`. The response is split on the same line and checked for count. On a count mismatch it retries 3 times, then translates each paragraph on its own. Inline formatting depends on the display mode. **Bilingual** sends plain text and loses links and emphasis; only formulas survive, as `{{n}}` placeholders. **Translation-only** sends HTML with every non-translatable attribute replaced by a `data-rf-attr="n"` marker, checks the markers, and restores the attributes. The cache key is a SHA-256 of the text, the provider identity, the language pair and the **fully built prompt**. The cache is shared across the whole extension and entries expire after 7 days. Target languages are ISO 639-3 codes, mapped to English names such as "Simplified Mandarin Chinese" from the `@read-frog/definitions` npm package. Reasoning and thinking settings go through the Vercel AI SDK: a top-level `reasoning` setting plus per-model default `providerOptions`.

For markdown-twain, the reusable parts are the prompt wording and the protocol ideas: the separator, the sentinel, markers or placeholders, and validation followed by fallback. The browser-extension machinery is not reusable: DOM walking, the service-worker queues, hosted-provider routing, and the IndexedDB cache.

## Pipeline at a glance

1. Content script walks the DOM into paragraphs and picks a display mode path (`utils/host/translate/core/translation-modes.ts`).
2. `translateTextForPage` gets the page context (title, description, first 2,000 characters of content, optional AI summary), skips text that franc already detects as the target language, and calls `translateTextCore` (`utils/host/translate/translate-variants.ts:160-186`, `:89-149`).
3. `translateTextCore` builds the cache hash, checks an in-tab memory cache, then sends `enqueueTranslateRequest` to the background (`utils/host/translate/translate-text.ts:315-443`).
4. Background checks the IndexedDB cache, then either puts the request in the `BatchQueue` (LLM providers) or runs it directly through `RequestQueue` (Google, Microsoft, DeepL and similar). It checks markers and placeholders and caches the result (`entrypoints/background/page-translation.ts:58-174`).
5. `BatchQueue` joins paragraphs with `%%`, builds the prompt with `isBatch: true`, calls the model, and splits the result (`entrypoints/background/translation-queues.ts:219-243`, `utils/request/batch-queue.ts`).
6. `aiTranslate` calls AI SDK `generateText` with `instructions` (system), `prompt` (user), `reasoning`, `temperature` and `providerOptions`, and strips any `<think>…</think>` prefix (`utils/host/translate/api/ai.ts:20-79`).

## 1. Prompts

### Base prompts (page translation)

Defined in `utils/constants/prompt.ts`. Each built-in prompt pairs a system prompt with a user prompt ([`prompt.ts:132-143`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/constants/prompt.ts#L132-L143)). The persisted ids are `default` and `precision-rewrite` (`:129-130`).

| Prompt | Location | Shape |
|---|---|---|
| Default system prompt | [`prompt.ts:59-69`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/constants/prompt.ts#L59-L69) | Sets the model up as a native translator of `{{targetLanguage}}`. A "Translation Rules" list of four rules: output only the translation with no preamble; keep the same number of paragraphs and the same format; place HTML tags sensibly in the translation; leave proper nouns, code and similar content untranslated. A "Document Metadata for Context Awareness" section holds `Webpage title: {{webTitle}}` and `Webpage summary: {{webSummary}}`. |
| Default user prompt | [`prompt.ts:83-86`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/constants/prompt.ts#L83-L86) | `Translate to {{targetLanguage}}:`, two blank lines, then `{{input}}`. |
| Precision-rewrite system prompt | [`prompt.ts:93-117`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/constants/prompt.ts#L93-L117) | Role: "Elite Translator and Rewriting Expert" using a "translation as rewriting" approach. **Core Strategies:** meaning over form; avoid translationese; use established terminology and keep the original term when no translation is established; keep format and untranslatables, moving HTML tags only for grammar. **Output Rules:** translation only; match paragraph, list and placeholder structure exactly; use the metadata silently. **Silent Internal Workflow:** draft, review and correct internally, then output only the final version. Ends with the same metadata section as the default. |
| Precision-rewrite user prompt | [`prompt.ts:119-122`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/constants/prompt.ts#L119-L122) | Identical to the default user prompt. |

Users can also define custom prompts (`patterns`). An unknown id falls back to `default` ([`utils/prompts/translate.ts:72-80`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/prompts/translate.ts#L72-L80)).

### Blocks appended to the system prompt

Assembly happens in `getTranslatePromptFromConfig` ([`utils/prompts/translate.ts:63-153`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/prompts/translate.ts#L63-L153)). Blocks are joined with a blank line, in this order:

1. **Batch rules**, only when `isBatch` (`:91-97`): `DEFAULT_BATCH_TRANSLATE_PROMPT` ([`prompt.ts:178-215`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/constants/prompt.ts#L178-L215)). Two rules: a standalone `%%` line in the input means standalone `%%` lines in the output, and `%%` inside normal text, code or quotes is not a separator. Then an output-format section (single paragraph: translate directly; multiple paragraphs: `%%` on its own line between translations) and a worked A/B/C example. The comment at `:171-177` warns that the example must never show the sentinel in a slot. Doing so taught models to emit it about one time in three.
2. **Sentinel rule**, only when `isBatch`: `DEFAULT_SENTINEL_TRANSLATE_PROMPT` ([`prompt.ts:231-232`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/constants/prompt.ts#L231-L232)). An "Already-translated Input Rule": output only `{{NO_TRANSLATION_NEEDED}}` when nothing but names, brands, handles, URLs, numbers or code differs from the target language; any foreign-language phrase must be translated. The comment at `:217-230` records a September 2026 benchmark behind this wording (12 variants, 6 models, 416 tasks).
3. **HTML marker rules**, only when the input contains `data-rf-attr` markers: `HTML_ATTRIBUTE_MARKER_SYSTEM_PROMPT` ([`utils/prompts/translate.ts:31-36`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/prompts/translate.ts#L31-L36)). Four rules: keep every marker exactly once per segment; never add, remove, change, renumber or move a marker across segments; keep each marker on its element; the element may move within its segment for word order.
4. **Placeholder rules**, only when the input contains a `{{n}}` token: `INLINE_ATOM_TOKEN_SYSTEM_PROMPT` ([`utils/host/translate/inline-atom-tokens.ts:147-151`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/host/translate/inline-atom-tokens.ts#L147-L151)). Three rules defining a placeholder as `{{` + number + `}}` that stands for a formula: copy it exactly once per segment, and never translate, renumber, drop, add or reformat it, although it may move. The comment at `:144-146` explains why there is deliberately no worked example.
5. **Glossary block**, appended *after* token replacement and only when terms matched: `GLOSSARY_SYSTEM_PROMPT_RULES` plus `A => B` lines ([`utils/glossary/prompt.ts:29-57`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/glossary/prompt.ts#L29-L57), joined at `:74-80`).

Blocks 3–5 open with a shared line saying the mandatory rules override anything above, so they read as one family (`utils/glossary/prompt.ts:26-27`).

### Token filling

- Tokens: `targetLanguage`, `input`, `webTitle`, `webDescription`, `webContent`, `webSummary` ([`prompt.ts:8-15`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/constants/prompt.ts#L8-L15)), written as `{{name}}` (`:57`). The built-in prompts use only `targetLanguage`, `input`, `webTitle` and `webSummary`. `webDescription` and `webContent` exist for custom prompts.
- Replacement is a chain of `replaceAll` calls in token order, applied to **both** the system and user prompts ([`utils/prompts/translate.ts:130-137`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/prompts/translate.ts#L130-L137)). Because `{{input}}` is replaced before `{{webTitle}}` and later tokens, a source paragraph that literally contains `{{webTitle}}` would itself be rewritten. This matters for Markdown docs about templating.
- Missing or blank values get fallbacks: `No title available`, `No description available`, `No content available`, `No summary available` (`:115-127`, with the blank check at `:56-61`).
- `{{targetLanguage}}` receives the English language **name**, not the code (see section 6).

### Where the title and summary come from

- `webTitle` = `document.title`. `webDescription` = the page meta description. `webContent` = the page converted to Markdown by Defuddle (falling back to `body.textContent`) and cut to **2,000 characters**. All of this is cached per URL ([`utils/host/translate/webpage-context.ts:19-52`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/host/translate/webpage-context.ts#L19-L52), [`webpage-content.ts:1-5`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/host/translate/webpage-content.ts#L1-L5)).
- `webSummary` is produced only when **"AI content aware"** (`enableAIContentAware`) is on, and it is **off by default** (`utils/constants/config.ts:112`). When on, a separate LLM call ([`utils/prompts/summary.ts:7-16`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/prompts/summary.ts#L7-L16)) sends a one-sentence system instruction asking for a 2–3 sentence summary and nothing else, plus a user message of `Title: …` and `Content: …`. The title is capped at 200 characters and the content at 3,000 characters after whitespace cleanup (`utils/content/summary.ts:10`, `:32-42`; `utils/content/utils.ts:1`). The summary is cached in `articleSummaryCache` under SHA-256(title, SHA-256(cleaned content), provider identity) for 7 days (`entrypoints/background/page-translation.ts:198`, `entrypoints/background/translation-context-summary.ts:37`, `entrypoints/background/db-cleanup.ts:15-16`). If generation fails, the result is `null` and the prompt shows `No summary available`.
- Page context is attached only for providers that can generate text, meaning LLMs (`utils/host/translate/translate-variants.ts:46-48`).
- When translating the page title itself, `webTitle` is set to the title being translated (`translate-variants.ts:192-210`).

## 2. Batching, splitting, validation, mismatch

- **Joining:** paragraph texts are joined with `"\n\n%%\n\n"` ([`entrypoints/background/translation-queues.ts:228`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/entrypoints/background/translation-queues.ts#L228)) and sent as one `{{input}}`, with `isBatch: true` so the batch rules and sentinel rule are included.
- **Batch limits:** at most `maxItemsPerBatch` = **4** paragraphs and `maxCharactersPerBatch` = **1,000** characters (`utils/constants/translate.ts:9-10`). A batch is flushed when it is full, or after `batchDelay` = 100 ms once the rate limiter has a free slot (`translation-queues.ts:312-321`; `utils/request/batch-queue.ts:235-286`). If a new paragraph would push the batch past the character cap, the current batch is flushed first (`batch-queue.ts:288-303`).
- **Batch key:** paragraphs are batched together only if they share source and target language, provider, the whole page context JSON, the hosted route and the glossary revision (`translation-queues.ts:322-335`). In other words, one batch comes from one page and context.
- **Request queue:** a token bucket with rate 8 and capacity 20 by default (`utils/constants/translate.ts:6-7`). Each request has 2 retries. A batch times out after 20 s + 15 ms per character, capped at 120 s (`translation-queues.ts:305-311`, `:347-353`; `utils/constants/translate.ts:20-22`). The AI SDK's own retries are turned off (`api/ai.ts:63`).
- **Splitting:** `parseBatchResult` trims the response, splits on `/\r?\n[ \t]*%%[ \t]*\r?\n/`, and trims each part ([`translation-queues.ts:117-122`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/entrypoints/background/translation-queues.ts#L117-L122); pattern at [`prompt.ts:29-30`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/constants/prompt.ts#L29-L30)). A `%%` inside a sentence is therefore not a split point.
- **Validation:** the only structural check is that the number of parts equals the number of paragraphs. Otherwise it throws `BatchCountMismatchError` ([`utils/request/batch-queue.ts:368-370`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/request/batch-queue.ts#L368-L370)). Parts map to paragraphs by position.
- **On mismatch:** retry the whole batch up to **3** times with exponential backoff of 1 s, 2 s, 4 s (capped at 8 s). Then **fall back to one request per paragraph**, built without `isBatch`, so neither the batch rules nor the sentinel rule are included (`batch-queue.ts:378-399`, `:419-439`; `translation-queues.ts:369-392`). Other errors, such as network or timeout failures, reject the paragraphs directly, after the RequestQueue's own retries.
- **Echo check:** after translation, if the source and output are equal after normalization (NFKC, straightened quotes, collapsed whitespace, lowercase), the translation is hidden (`utils/host/translate/text-preparation.ts:27-35`; `core/translation-modes.ts:170-185`).

## 3. Inline formatting

The two display modes use different representations (`utils/host/translate/core/translation-modes.ts`).

- **Bilingual (translation below the original):** sends **plain text**. `extractInlineAtomText` produces a prose string in which each rendered formula (MathML, KaTeX, MathJax) becomes `{{n}}` (`:539`, request at `:660`). Links, emphasis and inline code are **not** kept: the translation becomes text in a new wrapper span. Placeholders are renumbered to start above any `{{n}}` already in the prose (`inline-atom-tokens.ts:67`). After translation, `renderInlineAtomTranslation` turns literal runs into text nodes and each token into a sanitized clone of its formula. A duplicate token renders once, an unknown token stays as literal text, and a dropped token has its formula appended at the end (`dom/inline-atoms.ts:236-283`). `auditInlineAtomTokens` checks for missing, unknown or duplicate tokens (`inline-atom-tokens.ts:116`). A failed audit still renders but is **not cached** (`entrypoints/background/page-translation.ts:156-171`).
- **Translation-only (translation replaces the original):** sends **HTML**. `protectTranslationHtmlAttributes` clones the run and keeps only translatable attributes (`title`, `alt`, `aria-label`, `placeholder` and others). Every other attribute (`href`, `class`, `style`…) is removed and replaced by `data-rf-attr="<n>"`, with the originals stored in a snapshot table ([`dom/translation-html-attributes.ts:202-265`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/host/translate/dom/translation-html-attributes.ts#L202-L265); called at `core/translation-modes.ts:1098`). So the model sees `<a data-rf-attr="0">link text</a>` instead of the full tag. On return, `restore` runs `assertHtmlAttributeMarkerIntegrity`, which rejects missing, duplicate or unknown markers and a marker moved to a different tag ([`html-attribute-markers.ts:276-311`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/host/translate/html-attribute-markers.ts#L276-L311)). It then puts back the saved attributes and removes any attribute the model invented (`translation-html-attributes.ts:274-325`). If the integrity check fails, it retries once with the full, unstripped HTML (the "legacy" path, `core/translation-modes.ts:1132-1183`). The result is applied by swapping translated text into the page's own text nodes when the structures line up (`:1218`, `dom/translation-text-swap.ts:247-252`). Otherwise it sets `innerHTML` on a wrapper and detaches the originals (`:1246-1265`). The marker parser uses no DOM so it can run in the service worker (`html-attribute-markers.ts:209-262`).
- The default system prompt's rule 3 (place HTML tags sensibly) is what tells the model HTML may be present, in both modes.

## 4. `{{NO_TRANSLATION_NEEDED}}` sentinel

- Defined at [`prompt.ts:39-43`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/constants/prompt.ts#L39-L43). A match means the trimmed output equals the literal exactly. It is written to look like a prompt token on purpose: `replaceTokens` substitutes only the six known tokens, so the literal survives prompt building.
- It is only requested in batch mode, and it is one per `%%` slot. A multi-paragraph batch that collapses to one sentinel fails the count check and is retried (`prompt.ts:225-229`).
- The **raw** sentinel is cached in both the background IndexedDB cache and the in-tab memory cache, so the "no translation needed" verdict is remembered. It is mapped to `""` in exactly one place, `translateTextCore` (`translate-text.ts:407-442`). Empty strings are never cached, so mapping earlier would cause repeat requests. An empty result makes the UI remove the translation wrapper.
- It is a fallback. Before any request, franc skips paragraphs of 50 or more characters already detected as the target language (`utils/host/translate/target-language-skip.ts`). Paragraphs in user-chosen skip languages are also skipped (`translate-variants.ts:116-133`).

## 5. Cache key and scope

- **Key:** `Sha256Hex(...parts)`, which joins the parts with `|` before hashing (`utils/hash.ts`). For LLM providers the parts are ([`translate-text.ts:102-176`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/host/translate/translate-text.ts#L102-L176)):
  1. the prepared text (zero-width characters removed, trimmed);
  2. the provider identity as JSON (the **entire local provider config**, including model, options and temperature);
  3. the source language code (can be `auto`) and target language code;
  4. the **fully built system prompt and user prompt** for that single paragraph with `isBatch: true`, including page context and matched glossary terms. Any change to prompt wording, the prompt choice, the title or the summary therefore produces a new key;
  5. `enableAIContentAware=true|false`, and when enabled, title, description, the first 1,000 characters of content, and the summary;
  6. extra tags, such as `pageTitleTranslation`.
- The key is **per paragraph**, not per batch. The batch is split and each paragraph cached separately (`page-translation.ts:165-171`).
- **Scope:** one IndexedDB table, `translationCache`, shared across the whole extension: all tabs and all sites. The URL is not part of the key, although page context usually makes it page-specific in practice. Entries are removed by a daily alarm once `createdAt` is older than **7 days** (`entrypoints/background/db-cleanup.ts:9`, `:65-83`). A second, per-tab in-memory LRU cache (1,000 entries) uses the same key (`in-memory-translation-cache.ts:29-57`). "Force retranslation" skips reading the cache but still writes the new result. Empty results are never cached. Translations with broken placeholders are not cached. A cached result whose markers fail the integrity check is deleted when read (`page-translation.ts:33-52`).

## 6. Language codes and names

- Target languages are **ISO 639-3** codes, plus `cmn-Hant` for Traditional Chinese. The default target is `cmn` (`utils/constants/config.ts:84`). The config schema is `langCodeISO6393Schema` (`types/config/config.ts:28-29`), and the language pickers list `langCodeISO6393Schema.options` (`components/language-combobox-options.ts:19`).
- The list and names come from the npm package **`@read-frog/definitions@0.5.1`** (`package.json:78`). Its source monorepo `mengxi-ream/read-frog-monorepo` is not public, but the npm tarball ships `src/`. [`src/types/languages.ts`](https://cdn.jsdelivr.net/npm/@read-frog/definitions@0.5.1/src/types/languages.ts) defines `LANG_CODE_ISO6393_OPTIONS` (about 180 codes) and `ISO6393_TO_6391`. [`src/types/language-names/en.ts`](https://cdn.jsdelivr.net/npm/@read-frog/definitions@0.5.1/src/types/language-names/en.ts) defines `LANG_CODE_TO_EN_NAME`, for example `eng` → "English", `cmn` → "Simplified Mandarin Chinese", `cmn-Hant` → "Traditional Mandarin Chinese", `jpn` → "Japanese". The package's `package.json` declares **no license field**.
- The prompt's `{{targetLanguage}}` is always the **English name** `LANG_CODE_TO_EN_NAME[targetCode]` (`translate-text.ts:146`, `translation-queues.ts:96`, `execute-translate.ts:79`). Only the non-LLM providers use ISO 639-1 codes.

## 7. Provider options and reasoning (AI SDK layer)

- `aiTranslate` ([`api/ai.ts:20-79`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/host/translate/api/ai.ts#L20-L79)) calls `generateText({ model, instructions: systemPrompt, prompt, reasoning, temperature, providerOptions, abortSignal, maxRetries: 0 })` from `ai` v7 (`package.json:93`).
- **`reasoning`**: a top-level AI SDK setting, one of `provider-default | none | minimal | low | medium | high | xhigh`. It is read from the provider config only for providers that support it (`openai`, `anthropic`, `google`, `xai`, `groq`, `deepseek`, `fireworks`, `bedrock`) (`types/config/provider/constants.ts:278-304`, `utils/providers/reasoning.ts`).
- **`providerOptions`** ([`utils/providers/options.ts:113-137`](https://github.com/mengxi-ream/read-frog/blob/b4a45b9455eb0f63b450cb9610d87ac33883f0e9/src/utils/providers/options.ts#L113-L137)): the user's saved options, even `{}`, win and are wrapped as `{ [provider]: options }`. Otherwise a per-model default is taken from `LLM_MODEL_OPTIONS`, a first-match regex list aimed at minimizing thinking (`utils/constants/models.ts:577-…`). For OpenAI o-series that means `reasoningEffort: "minimal"`, and for GPT-5.x the lowest supported effort, often `none` (`models.ts:487-564`, `:614-622`). Examples for other providers: Claude and DeepSeek get `thinking: {type: "disabled"}`, and Gemini gets a zero thinking budget or level. The default is dropped when it only sets reasoning and a top-level `reasoning` is already set (`options.ts:128-134`). For OpenAI-compatible providers, snake_case keys are renamed `reasoning_effort` → `reasoningEffort` and `verbosity` → `textVerbosity` (`options.ts:22-25`, `:42-67`).
- Output cleanup: anything before a closing `</think>` tag is removed (`api/ai.ts:12`, `:66`). Ollama models are created with `think: false` (`utils/providers/model.ts`).
- Relevance to markdown-twain: we call OpenAI Chat Completions directly, not through the AI SDK. The reusable parts are the *policy*, meaning default to the lowest reasoning effort for translation and let the user override it with raw request options, and the per-model defaults table. The AI SDK wiring does not carry over. On Chat Completions the setting is the request body field `reasoning_effort`.

## 8. License facts (GPL-3.0)

These are facts from the license text and the repo. They are not legal advice.

- Read Frog's `LICENSE` is the GNU GPL version 3, and GitHub reports `GPL-3.0`. The README says Read Frog is **dual-licensed under GPLv3 and a commercial license** (`README.md:262`).
- The GPL's conditions apply to **conveying**, meaning letting other people receive copies. You may make, run and propagate covered works that you do not convey "without conditions" (GPL-3.0 §2). Publishing this repo on GitHub or a VSIX on the Marketplace is conveying.
- To "modify" means to copy or adapt all or part of a work "in a fashion requiring copyright permission". The result is a work "based on" the earlier one, and a "covered work" includes such works (§0).
- Conveying verbatim copies requires keeping the copyright and license notices intact (§4). Conveying a modified or derived version additionally requires prominent notices that you modified it, with a date; a notice that it is under GPL-3.0; and licensing **"the entire work, as a whole"** under GPL-3.0 (§5a–c). Object-code forms (a VSIX) must come with the Corresponding Source (§6).
- Consequence: if markdown-twain copies Read Frog prompt text or code *and that copying is the kind that needs copyright permission*, then conveying markdown-twain requires licensing it under GPL-3.0 as a whole. This repo currently has no license file.
- **Open, not researched:** whether short, functional prompt strings or protocol conventions (a `%%` separator, a sentinel literal, a marker attribute) are copyrightable expression at all. That is a legal question.
- The choice belongs to the user. Options: license markdown-twain under GPL-3.0 and copy with attribution; write original prompts that reuse only the documented *ideas*; or ask the Read Frog authors for a separate grant, since they already sell commercial licenses.

## Reuse inventory

### Copy verbatim (subject to the license decision)

- **Default system prompt and user prompt** (`prompt.ts:59-69`, `:83-86`). Change "Webpage title/summary" to document wording, or keep it as is.
- **Precision-rewrite system prompt and user prompt** (`prompt.ts:93-122`) as a second built-in choice with the same persisted ids, `default` and `precision-rewrite`.
- **Batch rules block** (`prompt.ts:178-215`) with the `%%` separator, `"\n\n%%\n\n"` joining, and the standalone-line split regex (`prompt.ts:30`).
- **Sentinel rule** (`prompt.ts:231-232`) and the `{{NO_TRANSLATION_NEEDED}}` literal, with the exact-match check.
- **Placeholder rules block** (`inline-atom-tokens.ts:147-151`) if `{{n}}` placeholders are used for inline code or math.
- **HTML marker rules block** (`prompts/translate.ts:31-36`) if the rendered-HTML route is chosen.
- **Summary prompt** (`prompts/summary.ts:7-16`) if an optional document summary is offered.
- **`LANG_CODE_TO_EN_NAME` names** for the languages we offer, so prompts say "Simplified Mandarin Chinese" rather than "zh-CN".

### Adapt

- **Token set and filling:** keep `{{targetLanguage}}`, `{{input}}`, `{{webTitle}}` (as the document title, from the first H1, front matter `title`, or the file name) and `{{webSummary}}`, with the same `No … available` fallbacks. Fill the context tokens *before* `{{input}}`, or use a single-pass replace, so source text containing `{{…}}` is never rewritten.
- **Batch sizing:** the 4-item / 1,000-character defaults, per-character timeout, count validation, retry-then-single fallback, and position-based mapping. Instead of a background service worker, use one in-process queue in the extension host. A document is a finite, known list of blocks, so batching can be planned up front instead of timer-driven.
- **Inline formatting:** Read Frog's bilingual mode drops links and emphasis, and only its translation-only mode keeps them, through HTML plus `data-rf-attr` markers. For Markdown the choice (issue #8) is between (a) sending the block's **Markdown source**, where inline syntax is already a compact, model-friendly markup (the precision prompt already says to keep headings, lists, placeholders, code and URLs), and (b) sending **rendered HTML with `data-rf-attr` markers**, plus Read Frog's integrity check and attribute restore. Either way, keep the pattern: validate what came back, fall back if it fails, and never cache a failed audit.
- **Cache key:** hash text + model config + language pair + fully built prompt, so prompt or context edits invalidate automatically, and cache per block. Scope and storage (workspace state, global storage, or in memory only) and a TTL still need deciding. Cache the raw sentinel and never cache empty results.
- **Reasoning policy:** default translation requests to the lowest `reasoning_effort` the model supports, per a small model table adapted from `LLM_MODEL_OPTIONS` (OpenAI rows only), let users override it with extra request-body options, and strip `</think>` prefixes.
- **Echo suppression:** compare normalized source and output (`text-preparation.ts:27-35`), and treat equal as "no translation".

### Drop (browser-specific or not needed)

- DOM walking, paragraph segmentation, virtual paragraphs, the in-place text-node swap, the spinner and wrapper machinery, inline-atom DOM cloning, and site rules. The Markdown preview is rendered by markdown-it from known blocks.
- Service-worker messaging, cancellation scopes across tabs, the `DispatchGate`, hosted and system provider routing, quotas, and idempotency keys.
- Non-LLM providers (Google, Microsoft, DeepL, DeepLX) and their HTML-escape normalization (`translation-output-normalization.ts`).
- Defuddle page extraction (the Markdown source is already available), the IndexedDB and Dexie tables, and alarm-based cleanup.
- Franc language detection and skip lists can be dropped at first. The sentinel covers blocks already in the target language.
- The glossary subsystem (revision-keyed batch merging). The glossary prompt block can be reconsidered later.

## Sources

- Read Frog source at [`b4a45b9`](https://github.com/mengxi-ream/read-frog/tree/b4a45b9455eb0f63b450cb9610d87ac33883f0e9): the files cited inline above.
- `@read-frog/definitions@0.5.1` npm package source, via jsDelivr: `src/types/languages.ts`, `src/types/language-names/en.ts`, `package.json`.
- GNU GPL v3 text: Read Frog `LICENSE` §0, §2, §4, §5, §6.
