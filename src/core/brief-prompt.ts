// The Document brief prompt. Our own, not adapted from Read Frog.

/** The system prompt for writing a Document brief ahead of translating into `targetLanguage` (an English language name). */
export function briefSystemPrompt(targetLanguage: string): string {
  return `You prepare a Markdown document for translation into ${targetLanguage}. The document is translated one paragraph at a time, and your brief is given to the translator with every paragraph, so that the whole document is translated consistently.

## Brief Rules
1. Start with a summary of two or three sentences in ${targetLanguage}: what the document is about, who it is for, and its tone.
2. Then list up to 20 key terms: technical terms, proper nouns, product names, and recurring phrases, each with the ${targetLanguage} translation the whole document should use. Mark terms that must stay untranslated, such as code identifiers and brand names, as "keep as is".
3. The input may be cut off; describe only what you can see.
4. Output only the brief, in plain text, without explanations or additional content.

## Output Format
<summary>

Key terms:
- <term>: <translation>
- <term>: keep as is`;
}

/** The user message for writing a Document brief of `text`, the beginning of the document. */
export function briefUserMessage(text: string): string {
  return `Write the brief for this document:\n\n\n${text}`;
}
