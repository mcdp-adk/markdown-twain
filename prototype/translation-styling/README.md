# PROTOTYPE: translation styling in the built-in preview (throwaway)

Answers [Prototype translation styling in the preview](https://github.com/mcdp-adk/markdown-twain/issues/11):
what should `bilingual` and `translationOnly` look like (colour and spacing for headings, paragraphs,
list items, blockquotes, and table cells) in light and dark themes? Not production code; hand-written
Chinese translations in `sample/translations.json`, no LLM.

The markup is the one fixed by [Decide the preview integration architecture](https://github.com/mcdp-adk/markdown-twain/issues/6):
a sibling `<div class="twain-t">` after block-level Blocks, an inner `<span class="twain-t">` in tight-list
paragraphs and table cells, inline replacement in `translationOnly`. The variants are CSS only.

## Run

```bash
code --new-window --extensionDevelopmentPath="$(pwd)/prototype/translation-styling" prototype/translation-styling/sample
```

Open `README.md`, `essay.md`, or `CONTEXT.md` and open the preview to the side (`Ctrl+K V`).
Any other Markdown file works too; blocks without a hand-written translation show `〔译〕` + source.

## Controls

- Floating bar at the bottom of the preview, or `←` / `→` with the preview focused: flip variants
  instantly (no reload).
- 🌐 in the preview's title bar: **Pick Display Mode** (`originalOnly` / `bilingual` / `translationOnly`).
- ◐ in the preview's title bar: **Cycle Theme** (Light Modern → Dark Modern → High Contrast → HC Light),
  written to the sample folder's workspace settings.

## Variants

| Key | Name | Colour | Spacing and headings |
| --- | --- | --- | --- |
| A | Read Frog port | Read Frog `textColor` green `oklch(0.693 0.17 162.48)` in every theme | 8px below the source; heading translation at heading size, rule under the pair |
| B | Theme-tuned pair | Same hue, darker on light themes; HC: text colour + dashed underline | Tight (0.15em) pair, normal gap after it; heading translation at heading size, rule under the pair |
| C | Annotation | Text colour faded to ~60%, 0.93em | Tight gloss; heading translation is a body-sized subtitle below the heading's rule |
| D | Left rule | Normal text colour | Thin link-coloured bar on the left; heading translation lighter weight, slightly smaller |

## Verdict

**B (Theme-tuned pair)** was chosen; see the resolution on
[Prototype translation styling in the preview](https://github.com/mcdp-adk/markdown-twain/issues/11).
