# markdown-twain

markdown-twain translates VS Code's built-in Markdown preview with an LLM. It works in desktop VS Code 1.96 or later with a provider that supports the OpenAI-compatible Chat Completions API. You choose the provider, model, and Target language. Opening a preview in **Original Only** sends no document text to the provider; translation starts when you select a translated Display mode.

## Install

Search for **markdown-twain** in VS Code's Extensions view and select **Install**, or run:

```sh
code --install-extension mcdp-adk.markdown-twain
```

The extension is for desktop VS Code. To build a VSIX yourself, see [Build a VSIX from source](docs/releasing.md#build-a-vsix-from-source).

## Translate a document

1. Run **markdown-twain: Set Up LLM Connection** from the Command Palette. Choose a provider, a key source, and a model. Setup ends with a Test Connection result. [Connection options](#llm-connection) are below.
2. In VS Code **User** Settings, choose `markdownTwain.targetLanguage` if you want a language other than your VS Code display language. The default, `auto`, follows that display language. If it is unsupported, choose a language from the setting's list instead. Simplified and Traditional Chinese are separate choices. There is no source-language setting.
3. Open a Markdown file and run **Markdown: Open Preview** from the Command Palette. In the preview title bar, select the globe button and choose **Bilingual** or **Translation Only**. You can also run **markdown-twain: Pick Display Mode** from the Command Palette.

The status bar shows **Preparing…** and then a count of processed Blocks while translation runs. The preview keeps showing the source until the run finishes, then refreshes with the translations. Selecting **Original Only** restores the untranslated preview and stops translation work. The Display mode applies to previews in the current VS Code window and starts as Original Only in each new window.

| Display mode | What you see |
| --- | --- |
| **Original Only** | The built-in preview without translations. |
| **Bilingual** | Each translated Block below its source Block. |
| **Translation Only** | Translated Blocks in place of their source Blocks. |

### What gets translated

A **Block** is a heading, paragraph, or table cell; this includes prose in list items and blockquotes. The extension translates these Blocks and reuses a translation while the Block, LLM connection, and Target language stay the same. Blocks already in the Target language can remain in their source form without a duplicate translation.

Code blocks, math blocks, front matter, raw HTML blocks, and paragraphs containing only an image are left unchanged in the preview. Paragraphs containing only inline code, inline math, or inline HTML are also skipped. In prose that contains Markdown formatting, the model is instructed to preserve links, URLs, and inline code.

**What is sent to the provider:** Before translating a document's Blocks, the extension sends up to the first 12,000 characters of the document's raw text to create a Document brief for consistent terminology. This can include code, math, HTML, and images that remain untranslated in the preview. It then sends the Blocks that need translation. A mixed prose paragraph is sent as inline Markdown. Preserving inline content is best effort: the model is instructed to keep Markdown syntax, URLs, and inline code unchanged, but its response is not structurally validated. Inline math, inline HTML, and image alt text may also change. The [v1 spec](https://github.com/mcdp-adk/markdown-twain/issues/19) describes this boundary.

## LLM connection

**Set Up LLM Connection** offers four Provider presets. Each preset supplies its base URL and has a corresponding API-key environment variable:

| Provider preset | Environment variable |
| --- | --- |
| OpenAI | `OPENAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Ollama Cloud | `OLLAMA_API_KEY` |

Choose **Custom** for another OpenAI-compatible endpoint, such as a local Ollama or LM Studio server. Enter the API base URL, for example `http://localhost:11434/v1`. The extension appends `/chat/completions` and does not add `/v1` for you. A Custom provider may have no key; Provider presets require one.

The key step can save a key in VS Code's SecretStorage or use an environment variable. For a Custom provider, enter the variable's name or choose **No key**. Set an environment variable before launching VS Code so the extension host can read it; setting it only in VS Code's integrated terminal is insufficient. A saved key takes precedence over an environment variable. Selecting an environment-variable option during setup removes the saved key for that provider. For a preset, clearing a saved key falls back to its environment variable if set; for Custom, use **Set API Key** to configure an environment variable again. Keys are never stored in `settings.json`.

Choose a model from the provider's `/models` list or enter its ID manually. Manual entry remains available if a Custom server has no model-list endpoint. The `default` Reasoning effort sends no effort field. On a fresh install, setup does not ask for an effort; run **markdown-twain: Set Reasoning Effort** after setup to choose another value. **Select Model**, **Set API Key**, **Clear API Key**, and **Test Connection** are also available from the Command Palette. Connection settings live in User Settings, not workspace settings.

## Troubleshooting

Run **markdown-twain: Test Connection** first. It reports the provider, model, and connection timing on success; on failure, read the error notification and use a suggested fix command if one is offered. Setup tests the connection automatically. For a failed translation run, **markdown-twain: Show Log** records the provider's message. If setup succeeds but no translation appears, confirm that the preview is in Bilingual or Translation Only and that the Target language is the one you intended.

| Symptom | Check |
| --- | --- |
| No key for a Provider preset | Run **Set API Key**, or make its environment variable available when VS Code starts. A saved key takes precedence over the variable. |
| Unknown model or HTTP 404 | Run **Select Model**. For a Custom provider, also check the base URL; some servers need `/v1` in it. |
| HTTP 400 with a non-default Reasoning effort | Run **Set Reasoning Effort** and try `default`. |
| Custom provider lists no models | Enter a model ID manually; model listing is not required for manual entry. |
| Custom provider fails Test Connection | The test requires streaming Chat Completions. Translation requests are non-streaming, so a server without streaming may fail the test even if it can translate. |
| Network error or HTTP 407 | Check VS Code's `http.proxy` setting and the proxy limitations below. |

The extension relies on VS Code's proxy handling. These proxy setups cannot be used directly:

- NTLM or Digest proxies;
- SOCKS4;
- SOCKS5 with authentication;
- `http.fetchAdditionalSupport: false`;
- `http.proxySupport: off`.

For an NTLM or Digest proxy, use a local HTTP relay such as Cntlm or Px. For an unsupported SOCKS proxy, use a compatible HTTP relay or proxy. Set VS Code's `http.proxy` to the local HTTP URL where that relay listens, and remove either disabling setting listed above before retrying. The extension has no separate proxy setting.

## Credits

[Read Frog](https://github.com/mengxi-ream/read-frog) inspired markdown-twain and supplied prompt text adapted for Markdown translation.

## License

Copyright (C) 2026 mcdp-adk. Licensed under GPL-3.0-only; includes prompt text adapted from Read Frog. See [LICENSE](LICENSE).
