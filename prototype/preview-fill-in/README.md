# PROTOTYPE: progressive fill-in in the built-in preview (throwaway)

Answers [Prototype progressive fill-in in the built-in preview](https://github.com/mcdp-adk/markdown-twain/issues/12):
is progressive fill-in through VS Code's built-in Markdown preview tolerable, given that every
`markdown.preview.refresh` fully reloads the preview webview? Not production code; fake translations only.

## Run

```bash
code --new-window --extensionDevelopmentPath="$(pwd)/prototype/preview-fill-in" prototype/preview-fill-in/sample
```

Open `long-document.md`, open the preview to the side (`Ctrl+K V`), scroll to the middle, then press
the ↻ button in the preview's title bar. For the Mermaid diagrams, install `bierner.markdown-mermaid`.

## Controls (preview title bar)

- 🌐 **Pick Display Mode**: `originalOnly` / `bilingual` / `translationOnly`; switching refreshes.
- ↻ **Replay Fill-In**: clears the cache and translates the whole document again.
- 🧪 **Pick Variant** (also the status-bar item): sets the settings below and replays.

| Setting (`twainProto.*`) | Meaning |
| --- | --- |
| `refreshIntervalMs` | Throttle between refreshes while translations land; `0` = one refresh when done. |
| `placeholder` | Bilingual pending block: `none`, `dots` (one line), `ghost` (invisible copy of the source, reserves height). |
| `scrollAnchor` | Preview script that re-anchors the first visible `data-line` block after each reload. |
| `concurrency`, `latencyMinMs`, `latencyMaxMs` | Fake request shape. |

State is surfaced in the status bar (done/seen, refresh count, mode), the badge in the preview's
bottom-right corner (variant, storage used by the anchor, last correction), and the **Twain Proto**
output channel (one line per refresh).
