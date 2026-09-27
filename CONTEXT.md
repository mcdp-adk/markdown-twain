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
