// Translation prompts.
//
// Source: Read Frog, https://github.com/mengxi-ream/read-frog
// Commit b4a45b9, file src/utils/constants/prompt.ts
// (DEFAULT_TRANSLATE_SYSTEM_PROMPT, DEFAULT_TRANSLATE_PROMPT,
// DEFAULT_BATCH_TRANSLATE_PROMPT, and DEFAULT_SENTINEL_TRANSLATE_PROMPT).
// Original license: GPL-3.0-only.
// Modified by markdown-twain, 2026-09-28:
// - The HTML rule is replaced by a Markdown rule, since the input is inline
//   Markdown.
// - The metadata section holds only the Document brief, in place of the
//   webpage title and summary, and comes last.
// - Tokens are filled in by functions instead of `{{token}}` substitution.
// - The batch rules and the sentinel rule are always included, so single-Block
//   requests use the same system prompt as batches.

/** Joins the Blocks of a batch; the model answers with the same separator. */
export const BATCH_SEPARATOR = "%%";
/** What the model answers for a Block already in the Target language. */
export const NO_TRANSLATION_SENTINEL = "{{NO_TRANSLATION_NEEDED}}";

/**
 * The system prompt for translating into `targetLanguage` (an English language
 * name), with the document's `brief` inserted verbatim when there is one.
 */
export function translateSystemPrompt(targetLanguage: string, brief?: string): string {
  const sections = [defaultSystemPrompt(targetLanguage), BATCH_RULES, sentinelRule(targetLanguage)];
  if (brief !== undefined) sections.push(metadata(brief));
  return sections.join("\n\n");
}

function defaultSystemPrompt(targetLanguage: string): string {
  return `You are a professional ${targetLanguage} native translator who needs to fluently translate text into ${targetLanguage}.

## Translation Rules
1. Output only the translated content, without explanations or additional content (such as "Here's the translation:" or "Translation as follows:")
2. The returned translation must maintain exactly the same number of paragraphs and format as the original text.
3. The input is inline Markdown. Keep all Markdown syntax, translate link text, and keep URLs and inline code unchanged.
4. For content that should not be translated (such as proper nouns, code, etc.), keep the original text.`;
}

// Every output slot of the example keeps a real translation: Read Frog found
// that showing the sentinel in one taught models to overuse it.
const BATCH_RULES = `## Multi-paragraph Translation Rules
1. If input contains a standalone line containing only ${BATCH_SEPARATOR}, use a standalone ${BATCH_SEPARATOR} line in your output. If input has no standalone ${BATCH_SEPARATOR} line, don't use ${BATCH_SEPARATOR} in your output.
2. **CRITICAL**: Treat ${BATCH_SEPARATOR} as a separator only when it appears on its own line. Do not treat ${BATCH_SEPARATOR} as a separator when it appears inside normal text, code, quotes, or punctuation.

## OUTPUT FORMAT:
- **Single paragraph input** → Output translation directly (no separators, no extra text)
- **Multi-paragraph input (input uses standalone ${BATCH_SEPARATOR} separator lines)** → Put ${BATCH_SEPARATOR} on its own line between translations

## Examples

### Multi-paragraph Input:
Paragraph A

${BATCH_SEPARATOR}

Paragraph B

${BATCH_SEPARATOR}

Paragraph C

### Multi-paragraph Output:
Translation A

${BATCH_SEPARATOR}

Translation B

${BATCH_SEPARATOR}

Translation C

### Single paragraph Input:
Single paragraph content

### Single paragraph Output:
Direct translation without separators`;

function sentinelRule(targetLanguage: string): string {
  return `## Already-translated Input Rule
Output only ${NO_TRANSLATION_SENTINEL} when only non-translatable names, brands, handles, URLs, numbers, or code differ from ${targetLanguage}. A foreign-language phrase or clause must be translated.`;
}

function metadata(brief: string): string {
  return `## Document Metadata for Context Awareness
Document brief: ${brief}`;
}

/** The user message that precedes the input. */
export function translateUserPrefix(targetLanguage: string): string {
  return `Translate to ${targetLanguage}:\n\n\n`;
}
