# markdown-twain

Read any Markdown document in your own language without leaving VS Code. markdown-twain translates the **built-in Markdown preview** with an LLM of your choice, in the spirit of [Immersive Translate](https://immersivetranslate.com/) and [Read Frog](https://github.com/mengxi-ream/read-frog).

## Features

- Three display modes: `originalOnly`, `bilingual`, and `translationOnly`.
- Works with any provider that speaks the OpenAI Chat Completions protocol.
- Inline formatting such as **bold**, _emphasis_, `code`, and [links](https://code.visualstudio.com/) keeps its place in the translation.
- Only the blocks you edit are translated again.

## Getting started

1. Install the extension and open a Markdown file.

2. Run **markdown-twain: Set Up LLM Connection** from the Command Palette and pick a provider.

   The setup ends with a short connectivity test, so you know right away whether the key and model work.

3. Open the preview (`Ctrl+K V`) and choose a display mode from the globe button in its title bar.

> **Note:** API keys are stored in VS Code's secret storage, never in `settings.json`.
>
> If no key is stored, the provider's environment variable is used instead, for example `OPENAI_API_KEY`.

### What gets translated

Paragraphs, headings, list items, blockquotes, and table cells are translated. Everything else is left exactly as written:

- Code blocks and inline code
- Math, front matter, and raw HTML
  - Image alt text is also left alone.
- Blocks that are already in the target language

```json
{
  "markdownTwain.targetLanguage": "auto"
}
```

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `markdownTwain.targetLanguage` | `auto` | The language to translate into; `auto` follows VS Code's display language. |
| `markdownTwain.model` | | The model used for translation, such as `gpt-4.1-mini`. |
| `markdownTwain.reasoningEffort` | `default` | How hard the model thinks before translating. |

## Known limitations

Every time a translation lands, the preview reloads as a whole. Long documents therefore show nothing new until the entire document has been translated, which can take a while with slower models.

#### Proxies

Requests go through VS Code's own `fetch`, which follows the `http.proxy` setting. NTLM and SOCKS4 proxies are not supported.

- [x] Bilingual preview
- [ ] Progress indicator
