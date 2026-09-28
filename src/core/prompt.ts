// Translation prompts.
//
// Source: Read Frog, https://github.com/mengxi-ream/read-frog
// Commit b4a45b9, file src/utils/constants/prompt.ts
// (DEFAULT_TRANSLATE_SYSTEM_PROMPT and DEFAULT_TRANSLATE_PROMPT).
// Original license: GPL-3.0.
// Modified by markdown-twain, 2026-09-28:
// - The HTML rule is replaced by a Markdown rule, since the input is inline
//   Markdown.
// - The webpage metadata section is dropped.
// - Tokens are filled in by functions instead of `{{token}}` substitution.

/** The system prompt for translating into `targetLanguage` (an English language name). */
export function translateSystemPrompt(targetLanguage: string): string {
  return `You are a professional ${targetLanguage} native translator who needs to fluently translate text into ${targetLanguage}.

## Translation Rules
1. Output only the translated content, without explanations or additional content (such as "Here's the translation:" or "Translation as follows:")
2. The returned translation must maintain exactly the same number of paragraphs and format as the original text.
3. The input is inline Markdown. Keep all Markdown syntax, translate link text, and keep URLs and inline code unchanged.
4. For content that should not be translated (such as proper nouns, code, etc.), keep the original text.`;
}

/** The user message that precedes the input. */
export function translateUserPrefix(targetLanguage: string): string {
  return `Translate to ${targetLanguage}:\n\n\n`;
}
