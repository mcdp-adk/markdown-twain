# markdown-twain

markdown-twain translates VS Code's built-in Markdown preview with an LLM over the OpenAI-compatible Chat Completions API. It runs in desktop VS Code 1.96 or later. Translation starts only when you choose a translated Display mode; each window starts in Original Only.

## Read in your language

Open a Markdown preview and use its globe button, or run **markdown-twain: Pick Display Mode** from the Command Palette:

| Display mode | Preview |
| --- | --- |
| **Original Only** | Shows the source document without translation. |
| **Bilingual** | Shows each translated Block directly below its source Block. |
| **Translation Only** | Shows translated Blocks in place of their source Blocks. |

Headings, paragraphs (including those in lists and blockquotes), and table cells are translated. Code blocks, math blocks, front matter, raw HTML blocks, and image-only paragraphs are not sent for translation. In translated prose, the model is asked to preserve Markdown formatting, link URLs, and inline code. Image alt text in a paragraph that also contains prose may change. Blocks already in the Target language are shown as they are. After an edit, only changed Blocks need translation again.

## Install from source

Use Node.js 22 and the repository's pinned pnpm version (`12.6.0`). Build and package the extension from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm package
code --install-extension ./markdown-twain-0.0.1.vsix
```

The `.vsix` filename follows the version in `package.json`; use the generated filename if that version has changed. You can also install the package from VS Code's Extensions view using **Install from VSIX...**.

## Set up an LLM connection

1. Run **markdown-twain: Set Up LLM Connection** from the Command Palette.
2. Choose a Provider preset: **OpenAI**, **OpenRouter**, **DeepSeek**, or **Ollama Cloud**. For another OpenAI-compatible endpoint, choose **Custom** and enter its base URL. The extension appends `/chat/completions` but does not add `/v1`; for example, a local Ollama base URL can be `http://localhost:11434/v1`.
3. Choose how to provide the API key. You can save it in VS Code SecretStorage or use an environment variable available to the VS Code process. The presets look for `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, and `OLLAMA_API_KEY`, respectively. For Custom, you can name an environment variable or choose **No key** if your server does not require one. Keys are not stored in `settings.json`.
4. Pick a model from the provider's list or enter a model ID, then optionally choose a Reasoning effort. Setup ends with an automatic Test Connection.

Set **markdownTwain.targetLanguage** in VS Code Settings to choose the Target language. Its default, `auto`, follows VS Code's display language. If that language is not supported, choose a language explicitly from the setting's list. There is no source-language setting.

## Troubleshooting

Run **markdown-twain: Test Connection** to check the current provider, key, and model. For more detail, run **markdown-twain: Show Log**. Network failures also point to VS Code's `http.proxy` setting; the extension uses VS Code's proxy handling.

The following proxy setups cannot be used by the extension:

- NTLM or Digest proxies;
- SOCKS4;
- SOCKS5 with authentication;
- `http.fetchAdditionalSupport: false`;
- `http.proxySupport: off`.

For an NTLM or Digest corporate proxy, run a local HTTP relay such as Cntlm or Px, then set VS Code's `http.proxy` to the relay's local URL. If either VS Code proxy setting above is disabled, change it before retrying the connection.

## Credits

[Read Frog](https://github.com/mengxi-ream/read-frog) inspired markdown-twain and supplied prompt text adapted for Markdown translation.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
