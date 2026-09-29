# Changelog

## 0.1.1

- Refactored LLM connection setup and translation execution without intentional changes to user-facing behavior.

## 0.1.0

The first Marketplace release.

- Translates VS Code's built-in Markdown preview with an LLM, one Block at a time: headings, paragraphs (including those in list items and blockquotes), and table cells.
- Three Display modes, picked from the globe button in the preview title bar or from the Command Palette: **Original Only**, **Bilingual**, and **Translation Only**.
- Target language follows VS Code's display language by default, or can be set to any language from the offered list.
- A Document brief keeps key terms consistent across a document's Blocks.
- Translations are cached per Block, LLM connection, and Target language.
- **Set Up LLM Connection** walks through a provider, a key source, and a model, then tests the connection. Provider presets cover OpenAI, OpenRouter, DeepSeek, and Ollama Cloud; a Custom provider covers any OpenAI-compatible endpoint, such as a local Ollama or LM Studio server.
- API keys are saved in VS Code's SecretStorage or read from an environment variable, and are never stored in `settings.json`.
- Reasoning effort can be left to the model or set from `none` to `max`.
- **Test Connection** and **Show Log** help diagnose connection and translation failures.
