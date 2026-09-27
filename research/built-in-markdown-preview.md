# What the built-in Markdown preview allows extensions to do

Research for [#2](https://github.com/mcdp-adk/markdown-twain/issues/2) (part of the map [#1](https://github.com/mcdp-adk/markdown-twain/issues/1)).

**Question.** What can an extension do inside VS Code's built-in Markdown preview, and can LLM translations, which arrive asynchronously after rendering, be shown there with the settled UX: whole-document translation filling in progressively, one global **Display mode** (`originalOnly` / `bilingual` / `translationOnly`), and a button in the preview's editor title bar?

**Sources.** Primary only:

- `microsoft/vscode` at commit [`43dd907`](https://github.com/microsoft/vscode/tree/43dd9070f75d527ab38035c0562acbfe9de4209b) (main, 2026-09-27), mainly `extensions/markdown-language-features` (abbreviated `mlf/` below). Links are pinned to that commit.
- VS Code API docs: [Markdown Extension guide](https://code.visualstudio.com/api/extension-guides/markdown-extension), [Webview guide](https://code.visualstudio.com/api/extension-guides/webview), [when clause contexts](https://code.visualstudio.com/api/references/when-clause-contexts).
- `markdown-it` 14.x source (the built-in pins `markdown-it` 14.2.0 in `mlf/package-lock.json`).
- The Mermaid extension `mjbvz/vscode-markdown-mermaid` at commit [`9f4d37d`](https://github.com/mjbvz/vscode-markdown-mermaid/tree/9f4d37ded0cc7fdf05bbab17fb082a6fc118e269), as the reference third-party preview extension.

[mlf]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/extensions/markdown-language-features

## Verdict

**Yes, the built-in preview can support the settled UX, with one cost to validate.** The only way to get extension-host data (translations) into an already-rendered built-in preview is to **re-render it**: a markdown-it plugin (`extendMarkdownIt`) reads translations from an in-memory cache while rendering, and the extension calls `markdown.preview.refresh` when new translations arrive or the Display mode changes. That refresh is a **full reload of the preview webview** (new `webview.html`), not an in-place DOM patch. Progressive fill-in therefore means a series of throttled full reloads. Correctness is fine, and the built-in restores scroll position across reloads. But flicker and scroll drift as translated blocks push content down are real risks that a prototype should judge before committing. No other channel exists: a contributed preview script cannot message the extension host, and the preview's CSP blocks network access.

Recommended: **Architecture A (render-driven translation via a markdown-it plugin plus refresh)** below. Keep the extension-owned preview panel (Architecture C) as the fallback, as the map already says.

## 1. The three extension points

All three are declared in the contributing extension's `package.json` and collected by the built-in from `vscode.extensions.all` ([`src/markdownExtensions.ts` L112-L161, L397-L401][mlf-ext]).

| Contribution | Runs in | Can access | Evidence |
| --- | --- | --- | --- |
| `markdown.markdownItPlugins: true` + `activate()` returning `{ extendMarkdownIt(md) }` | **Extension host**, inside the built-in's single shared markdown-it instance, but the closure is ours (same process, so it can read our extension's in-memory state and the `vscode` API) | The markdown-it instance: core/block/inline rules, renderer rules, `md.renderer.render`. Rendering is **synchronous**, so a rule cannot await. | The built-in calls `extension.activate()` and then `exports.extendMarkdownIt(md)` ([`markdownExtensions.ts` L133-L147][mlf-ext]). Plugins are applied before the built-in's own renderers and before `pluginSourceMap` ([`src/markdownEngine.ts` L133-L164][mlf-engine]). The guide says `extendMarkdownIt` "must return a new markdown-it instance" and plugins "are activated lazily, when a Markdown preview is shown for the first time". |
| `markdown.previewScripts` | **Preview webview** (one `<script async nonce=…>` per script in `<body>`) | The rendered DOM only. It **cannot** reach the extension host (see §2). | [`src/preview/documentRenderer.ts` L245-L255][mlf-renderer]. Extension dirs of contributors become `localResourceRoots` ([`markdownExtensions.ts` L120][mlf-ext]). |
| `markdown.previewStyles` | **Preview webview** (`<link rel="stylesheet">` in `<head>`) | Styling only. Loaded after the built-in styles and before the user's `markdown.styles` (guide). | [`documentRenderer.ts` L234-L243][mlf-renderer] |

Details that matter for us:

- **One shared engine for every consumer.** The same `MarkdownItEngine` renders every preview (dynamic `markdown.preview` panels and the static `vscode.markdown.preview.editor` custom editor). It also serves `markdown.api.render` and tokenizes for language features such as paste and drop (`tokenize()` runs only the parse, not the renderer) ([`markdownEngine.ts` L196-L226][mlf-engine]). Side effects such as queueing translations belong in **renderer** rules or a `md.renderer.render` wrapper, not in core rules.
- **What the renderer receives.** Its `env` carries `currentDocument: vscode.Uri` and a `resourceProvider` when rendering a preview ([`markdownEngine.ts` L204-L209][mlf-engine]). This is internal and undocumented, but usable if the plugin needs to know which document it is rendering.
- **Token cache.** Tokens are cached per document URI and version. `markdown.preview.refresh` clears that cache ([`markdownEngine.ts` L47-L80][mlf-engine], [`src/commands/refreshPreview.ts`][mlf-refresh]).
- **Same extension host required.** The plugin only works when our extension runs in the same extension host as the built-in, because `extension.exports` must be readable. The built-in declares no `extensionKind` (it defaults to workspace), so ours must not force `ui`.
- **The new Markdown Editor is out of reach.** On main, the built-in also ships a WYSIWYG "Markdown Editor" (`vscode.markdown.editor`). It does **not** use `markdownItPlugins`, `previewScripts`, or `previewStyles`; it only consumes the new `markdown.codeBlockEditorProviders` ([`src/preview/markdownEditorProvider.ts` L260-L320][mlf-editor]). Our extension cannot reach it, so it is not a target.

## 2. Can results computed later reach an already-rendered preview?

### Channels that do not exist

- **Webview to host messaging for contributed scripts.** The built-in preview script calls `acquireVsCodeApi()` at load ([`preview-src/index.ts` L27][mlf-index]), and the Webview guide says it "can only be invoked once per session". A contributed script therefore cannot get its own `postMessage` handle. The built-in's host-side `onDidReceiveMessage` only handles a fixed set of message types (`cacheImageSizes`, `revealLine`, `didClick`, `openLink`, `showPreviewSecuritySelector`, `previewStyleLoadError`) and ignores everything else ([`src/preview/preview.ts` L174-L205][mlf-preview], [`types/previewMessaging.d.ts` L54-L93][mlf-msg]).
- **Host to webview messaging.** Only the built-in owns the `WebviewPanel`. Another extension has no handle to `postMessage` into it. The built-in exports no API; `activate` returns only the language client ([`src/extension.ts`][mlf-extension-ts], [`src/extension.shared.ts`][mlf-shared]).
- **Direct network access from a preview script.** The default (`Strict`) CSP is `default-src 'none'; … script-src 'nonce-…'` with no `connect-src`, so `fetch`, XHR, and WebSocket are blocked. Only the "Allow scripts and all content" security level removes the CSP ([`documentRenderer.ts` L257-L277][mlf-renderer]). Requiring users to disable preview security is not acceptable, and API keys live in SecretStorage on the host anyway.

### The channel that exists: re-render

- **`markdown.preview.refresh`** is a public, contributed command. It runs `engine.cleanCache()` and then `previewManager.refresh()`, which refreshes **every** open preview, dynamic and static ([`refreshPreview.ts`][mlf-refresh], [`src/preview/previewManager.ts` L124-L131][mlf-manager]). Each preview's `refresh()` calls `MarkdownPreview.refresh(true)` ([`preview.ts` L640-L642, L835-L837][mlf-preview]).
- **Forced refresh is a full page reload.** `forceUpdate` makes `shouldReloadPage` true, so the whole HTML document is regenerated and assigned to `webview.html` ([`preview.ts` L314-L353, L412-L433][mlf-preview]). The same holds for configuration changes (`updateConfiguration` → `refresh()` → `refresh(true)`) and contribution changes (`refresh(true)`) ([`preview.ts` L145-L147, L652-L656, L839-L843][mlf-preview]).
- **Only text edits patch in place.** A non-forced refresh after a document change renders the body only and posts `updateContent`. The webview merges it with `morphdom` and fires `window` event `vscode.markdown.updateContent` ([`preview.ts` L322, L344-L346, L424-L431][mlf-preview], [`preview-src/index.ts` L339-L413][mlf-index]). That path requires a new document version, so an extension cannot trigger it without editing the document.
- **Throttling.** After the first render, refreshes are debounced to one per 300 ms; calls while one is pending are dropped ([`preview.ts` L77, L246-L257][mlf-preview]). A pending refresh renders whatever the cache holds when it fires, so dropped calls lose nothing.
- **The markdown-it plugin reads fresh state on every render**, because it runs in our process. This is how the Mermaid extension pushes changed settings: it wraps `md.renderer.render` to inject a `<span data-config=…>` read by its preview script, and calls `markdown.preview.refresh` on configuration change ([`src/vscode-extension/index.ts`][mermaid-host], [`src/vscode-extension/config.ts` L20-L39][mermaid-config]).

### State across re-renders

- **The built-in's own state survives reloads.** The built-in keeps `scrollProgress` (scrollY / body height) in `vscode.setState`, and after a reload it restores the same fraction ([`preview-src/index.ts` L41-L61, L104-L119, L786-L789][mlf-index]). Webview state "is persisted even after the webview content itself is destroyed" (Webview guide). Because the restore is proportional, content that grows **above** the viewport (bilingual blocks filling in) shifts what the user sees. This is the main UX risk to prototype.
- **Contributed scripts have no `vscode.setState`.** They can only rebuild their state from the DOM, or from data the plugin embeds in the HTML. Other state is lost on every reload: `<details>` open state, text selection, the find widget's position, and the rendering work of other preview scripts (Mermaid re-renders its diagrams).
- **Hidden previews are destroyed.** The preview is created without `retainContextWhenHidden`, so a hidden preview is destroyed and fully re-rendered when shown again ([`preview.ts` L322, L714-L717][mlf-preview]). An in-memory cache on the host covers this for free.
- **The docs are stale on script reloading.** The Markdown guide says preview scripts are "reloaded on every content change". The source shows that is only true for full reloads. On in-place `updateContent` updates, scripts are not re-run; they must listen to `vscode.markdown.updateContent`, as the Mermaid preview script does ([`src/markdownPreview/index.ts` L51-L52][mermaid-preview]).

## 3. Mapping rendered blocks back to their source

- **`data-line` attributes.** The built-in's `pluginSourceMap` core rule sets `data-line = token.map[0]` (0-based start line), class `code-line`, and `dir="auto"` on **every token with a `map` except `inline`**. `html_block` gets an empty marker `<div data-line=…>` in front, because its renderer ignores attrs ([`markdownEngine.ts` L17-L40][mlf-engine]). The body ends with a sentinel `<div class="code-line" data-line="{lineCount}">` ([`documentRenderer.ts` L150][mlf-renderer]). `morphdom` copies `data-line` values over on in-place updates ([`preview-src/index.ts` L372-L392][mlf-index]).
- **Limits of `data-line`.**
  - It holds the start line only, and nested blocks share it: a `blockquote` and its first `p`, or a `li` and its paragraph.
  - Paragraphs inside tight lists are `hidden` tokens, so no `<p>` is emitted and only the `li` carries a line.
  - Table cells (`th_open`/`td_open`) have **no `map`** in markdown-it 14; only `table`, `thead`, `tbody`, and `tr` do ([markdown-it `lib/rules_block/table.mjs`](https://github.com/markdown-it/markdown-it/blob/14.1.0/lib/rules_block/table.mjs), map assignments at L143-L200). A cell is identified by row line plus column index.
- **Mapping in the plugin, not the DOM.** In Architecture A the mapping happens on **tokens in the host**, not in the DOM. Each translatable unit is an `inline` token whose parent block token is `paragraph_open`, `heading_open`, `th_open`, or `td_open`. Its `.content` is the raw inline Markdown, links, emphasis, and inline code included. That gives:
  - a natural **cache key**: `inline.content` combined with model, target language, and prompt, with no need for document identity or line numbers, so the cache survives edits that move lines;
  - a natural render path: translate the inline Markdown to inline Markdown, then render it with `md.renderInline()`, so inline formatting keeps its place.

  Code blocks (`fence`/`code_block`), `html_block`, front matter (the built-in's `yamlPreamble` plugin), math tokens (from a math plugin), and image alt text are skipped simply by only visiting the block types above. `data-line` is only needed if a preview script has to locate blocks, for example for scroll anchoring.

## 4. Editor-title button and knowing which document the preview shows

- **Targeting the preview.** A third-party `editor/title` menu item can use exactly the built-in's `when` clause:

  ```
  activeWebviewPanelId == 'markdown.preview' || activeCustomEditorId == 'vscode.markdown.preview.editor'
  ```

  The built-in uses this for its own Refresh, Toggle Lock, and Security items ([`mlf/package.json` L574-L610][mlf-pkg]). `activeWebviewPanelId` holds the *provided* (unprefixed) view type of the active panel ([`webviewWorkbenchService.ts` L224-L258][wb-service], [`webviewEditor.ts` L30-L36][wb-editor]). Both keys are documented in the when clause contexts reference. The button can open a submenu of the three Display modes, or cycle between them, with a context key set through `setContext` to show the current mode's icon.
- **Which document it shows.** No clean API answers this for the dynamic preview.
  - Editor-title commands receive the active editor's resource URI ([`editorGroupView.ts` L298, L2148][wb-group]). For a webview panel that is a synthetic `webview-panel:webview-panel/webview-<viewType>-<uuid>` URI ([`webviewEditorInput.ts` L51-L56][wb-input]), not the Markdown file.
  - The Tabs API gives `TabInputWebview` with only a `viewType`, which is the internal prefixed `mainThreadWebview-markdown.preview` ([`vscode.d.ts` `TabInputWebview`][dts], [`mainThreadEditorTabs.ts` L162-L166][wb-tabs], [`mainThreadWebviewPanels.ts` L65-L83][wb-panels]), and no URI.
  - The built-in's `activePreviewResource` is internal ([`showSource.ts`][mlf-showsource]).
  - For the **static** preview (`vscode.markdown.preview.editor`), both the command argument and `TabInputCustom.uri` are the Markdown file.
- **The settled UX does not need document identity.** Display mode is global, and translation can be **driven by rendering**: the button sets the mode and calls `markdown.preview.refresh`. Every open preview re-renders, and the plugin queues whatever blocks it sees that are missing from the cache. If per-document bookkeeping is wanted later, for example cancelling a document's jobs, the renderer's `env.currentDocument` (internal) identifies the document being rendered.

## 5. How existing extensions cope with async content

Mermaid (`bierner.markdown-mermaid`) is the canonical example ([`package.json` contributes][mermaid-pkg]):

- **Host side.** A markdown-it plugin turns ```` ```mermaid ```` fences into placeholder containers and injects configuration as a `data-config` attribute on a hidden span ([`config.ts` L20-L39][mermaid-config]). On configuration or theme change it calls `markdown.preview.refresh` ([`index.ts`][mermaid-host]).
- **Webview side.** A preview script does the async work (Mermaid rendering) **inside the webview**. It re-runs on load and on `vscode.markdown.updateContent`, and aborts in-flight renders with an `AbortController` ([`src/markdownPreview/index.ts`][mermaid-preview]).

Its async work needs nothing from the host after render. Ours does: LLM calls need SecretStorage keys and network access, and the CSP blocks both in the webview. So Mermaid's pattern carries over only for pushing data via the plugin plus `markdown.preview.refresh`, which is Architecture A.

## Viable architectures

### A. Render-driven translation in the markdown-it plugin (recommended)

- **Contributions**: `markdown.markdownItPlugins`, `markdown.previewStyles` for the bilingual `textColor`-style CSS, and optionally `markdown.previewScripts` (only for scroll anchoring, see below).
- **Render.** A `md.renderer.render` wrapper or renderer rules for each translatable `inline` token look up the in-memory per-block cache:
  - `originalOnly`: render unchanged.
  - `bilingual`: emit the source block, then a sibling translated block with a marker class. Blocks still translating can show a small placeholder.
  - `translationOnly`: replace the inline content with the rendered translation, falling back to the source while pending.
- **Async.** Cache misses seen during a render are queued in the host (deduplicated by cache key). As results land, call `markdown.preview.refresh`, throttled by us (for example at most every ~0.5–1 s, or per completed batch), on top of the built-in's 300 ms debounce.
- **Mode switch.** Set the global mode, then call `markdown.preview.refresh`. `originalOnly` renders unchanged immediately; the cache is kept.
- **Edits.** These arrive through the normal in-place `updateContent` path. Unchanged blocks hit the cache and only changed blocks are queued, which matches the settled "re-translate only changed blocks".
- **Pros**:
  - one source of truth in the host;
  - small surface: public contribution points plus one public command;
  - works for dynamic and static previews, and alongside other markdown-it plugins;
  - Mermaid-proven pattern;
  - no need to know which document a preview shows.
- **Cons and risks**:
  - Every fill-in step is a **full webview reload** of **every** open preview: flicker, images re-decoded, Mermaid diagrams re-rendered, find and selection reset, and markdown-it plus highlight.js re-run over the whole document on the host.
  - Proportional scroll restore drifts while content above the viewport grows. Mitigation to prototype: a small preview script records the top visible `data-line` element before unload (for example in `sessionStorage`, which is unverified in webviews) and re-anchors after load. The built-in scrolls first, via `setTimeout` after images load, so ordering needs care.
  - It relies on undocumented behavior (forced refresh means reload, `env.currentDocument`), which could change between VS Code versions.

### B. Preview-script DOM mutation with a live data channel (not viable)

The idea: a preview script inserts translations into the DOM as they stream in, with no reloads. It fails because no channel carries data from the host to a running preview: `acquireVsCodeApi` is already consumed, the host cannot post into a panel it does not own, and the CSP blocks `connect-src`. Workarounds such as smuggling data through re-requested stylesheets or images from a local resource root, or asking users to set preview security to "Allow scripts and all content", are fragile or unsafe. B collapses into A: data can only arrive through a re-render.

### C. Extension-owned preview panel (fallback)

A `WebviewPanel` owned by our extension with its own `postMessage` channel lets translations stream into the DOM with no reloads, and gives full control over scroll. Costs: re-implementing what the built-in preview does, including scroll sync, link handling, the CSP and security levels, theming, images, and third-party `markdown.markdownItPlugins`/`previewScripts` support. It can be cheapened by rendering with the built-in's `markdown.api.render` command, which uses the shared engine with all contributed plugins ([`src/commands/renderDocument.ts`][mlf-render]; `onCommand:markdown.api.render` activates the built-in), and by loading the built-in's `media/markdown.css`. But `api.render` renders without a webview resource provider, so relative image links need extra handling ([`markdownEngine.ts` L353-L395][mlf-engine]). Per the map, do not build this up front.

## Open points for later tickets

- **Prototype needed**: how bad full-reload flicker and scroll drift feel during progressive fill-in on a long document with images and a Mermaid diagram, and whether a `data-line` scroll-anchor script fixes drift. This decides A versus C.
- **Refresh throttle interval and batch size** (ties into "Request throughput" in the map's Fog).
- **Where progress and failure show** (placeholders in the preview versus the status bar) belongs to the "Failure and progress UX" fog item. Architecture A can render per-block placeholders or error markers cheaply.

[mlf-ext]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/extensions/markdown-language-features/src/markdownExtensions.ts
[mlf-engine]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/extensions/markdown-language-features/src/markdownEngine.ts
[mlf-renderer]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/extensions/markdown-language-features/src/preview/documentRenderer.ts
[mlf-preview]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/extensions/markdown-language-features/src/preview/preview.ts
[mlf-manager]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/extensions/markdown-language-features/src/preview/previewManager.ts
[mlf-editor]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/extensions/markdown-language-features/src/preview/markdownEditorProvider.ts
[mlf-refresh]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/extensions/markdown-language-features/src/commands/refreshPreview.ts
[mlf-render]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/extensions/markdown-language-features/src/commands/renderDocument.ts
[mlf-showsource]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/extensions/markdown-language-features/src/commands/showSource.ts
[mlf-extension-ts]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/extensions/markdown-language-features/src/extension.ts
[mlf-shared]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/extensions/markdown-language-features/src/extension.shared.ts
[mlf-index]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/extensions/markdown-language-features/preview-src/index.ts
[mlf-msg]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/extensions/markdown-language-features/types/previewMessaging.d.ts
[mlf-pkg]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/extensions/markdown-language-features/package.json
[wb-service]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/src/vs/workbench/contrib/webviewPanel/browser/webviewWorkbenchService.ts
[wb-editor]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/src/vs/workbench/contrib/webviewPanel/browser/webviewEditor.ts
[wb-input]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/src/vs/workbench/contrib/webviewPanel/browser/webviewEditorInput.ts
[wb-group]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/src/vs/workbench/browser/parts/editor/editorGroupView.ts
[wb-tabs]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/src/vs/workbench/api/browser/mainThreadEditorTabs.ts
[wb-panels]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/src/vs/workbench/api/browser/mainThreadWebviewPanels.ts
[dts]: https://github.com/microsoft/vscode/blob/43dd9070f75d527ab38035c0562acbfe9de4209b/src/vscode-dts/vscode.d.ts
[mermaid-pkg]: https://github.com/mjbvz/vscode-markdown-mermaid/blob/9f4d37ded0cc7fdf05bbab17fb082a6fc118e269/package.json
[mermaid-host]: https://github.com/mjbvz/vscode-markdown-mermaid/blob/9f4d37ded0cc7fdf05bbab17fb082a6fc118e269/src/vscode-extension/index.ts
[mermaid-config]: https://github.com/mjbvz/vscode-markdown-mermaid/blob/9f4d37ded0cc7fdf05bbab17fb082a6fc118e269/src/vscode-extension/config.ts
[mermaid-preview]: https://github.com/mjbvz/vscode-markdown-mermaid/blob/9f4d37ded0cc7fdf05bbab17fb082a6fc118e269/src/markdownPreview/index.ts
