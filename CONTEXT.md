# markdown-twain

A VS Code extension that translates Markdown documents inside the preview with an LLM, in the spirit of Immersive Translate and Read Frog.

## Language

**Display mode**:
How a translated document is shown in the preview; one of `originalOnly`, `bilingual`, `translationOnly`.
_Avoid_: view mode, translation mode

**originalOnly**:
The display mode that shows only the source document, as if untranslated.
_Avoid_: original, source mode

**bilingual**:
The display mode that shows each translated block directly below its source block.
_Avoid_: side-by-side, dual, parallel

**translationOnly**:
The display mode that shows translated blocks in place of their source blocks.
_Avoid_: translated mode, target-only

**Block**:
The unit that is translated and cached on its own: a paragraph (including one inside a list item or blockquote), a heading, or a table cell.
_Avoid_: segment, node, unit

**Reasoning effort**:
How hard the model thinks before translating; one of `default` (leave it to the model), `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `none` turns thinking off, which is not the same as `default`.
_Avoid_: think effort, thinking level

**Provider preset**:
A built-in, unchangeable set of connection data for a known provider: its base URL, default API-key environment variable, and how it takes a **Reasoning effort**.
_Avoid_: template, profile

**Custom provider**:
A provider whose base URL the user enters; it always takes **Reasoning effort** as `reasoning_effort`.
_Avoid_: other provider, manual provider

**LLM connection**:
What translation talks to: one **Provider preset** or the **Custom provider**, plus an API key, a model, and a **Reasoning effort**. There is exactly one, set in User settings; switching provider replaces it rather than switching between saved ones.
_Avoid_: profile, account, saved connection

**Target language**:
The language translation writes into: either a specific language from the offered list, or `auto`, which follows VS Code's display language.
_Avoid_: output language, destination language, to-language
