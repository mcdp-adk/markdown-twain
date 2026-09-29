// The markdown-it adapter: recognize Blocks, traverse tokens, and place translated HTML.
import type { MarkdownIt, Renderer, Token } from "markdown-it";
import {
  createTranslation,
  type DisplayMode,
  type Failure,
  type RunEnd,
  type Status,
  type TranslationExecution,
  type TranslationDeps as TwainDeps,
} from "./translation.ts";

export type {
  DisplayMode,
  Failure,
  Log,
  RunEnd,
  Status,
  TranslationDeps as TwainDeps,
} from "./translation.ts";
export { QUIET_MS } from "./translation.ts";

export interface Twain extends Omit<TranslationExecution, "beginRender"> {
  /** The plugin for the built-in preview's markdown-it, through `extendMarkdownIt`. */
  markdownItPlugin(md: MarkdownIt): MarkdownIt;
}

export function createTwain(deps: TwainDeps): Twain {
  const execution = createTranslation(deps);

  function markdownItPlugin(md: MarkdownIt): MarkdownIt {
    const render = md.renderer.render;
    md.renderer.render = function (this: Renderer, tokens, options, env) {
      if (execution.displayMode === "originalOnly") return render.call(this, tokens, options, env);

      const session = execution.beginRender(env?.currentDocument);
      const mode = session.mode;

      const renderToken = (i: number) => {
        const rule = this.rules[tokens[i].type];
        return rule ? rule(tokens, i, options, env, this) : this.renderToken(tokens, i, options);
      };
      let out = "";
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type !== "inline") {
          out += renderToken(i);
          continue;
        }
        const where = blockOf(tokens[i - 1], token);
        const source = this.renderInline(token.children ?? [], options, env);
        const translation = where && session.translationOf(token.content);
        if (translation == null) {
          out += source;
          continue;
        }
        // Not md.renderInline(): that goes through renderer.render and re-enters this wrapper.
        const translated = this.renderInline(
          md.parseInline(translation, env ?? {})[0].children ?? [],
          options,
          env,
        );
        if (mode === "translationOnly") {
          out += translated;
          continue;
        }
        out += source;
        if (where === "inner") {
          out += `<span class="twain-t">${translated}</span>`;
        } else {
          out += renderToken(++i);
          out += `<div class="twain-t">${translated}</div>`;
        }
      }
      return out;
    };
    return md;
  }

  return {
    markdownItPlugin,
    setDisplayMode: (mode: DisplayMode): Promise<Failure | undefined> => execution.setDisplayMode(mode),
    settingsChanged: () => execution.settingsChanged(),
    get displayMode() {
      return execution.displayMode;
    },
    retry: () => execution.retry(),
    get status(): Status {
      return execution.status;
    },
    onStatusChange: (listener: (status: Status) => void) => execution.onStatusChange(listener),
    onRunEnd: (listener: (event: RunEnd) => void) => execution.onRunEnd(listener),
  };
}

/**
 * Whether an `inline` token is a Block, and where its translation goes:
 * `outer` after the closing tag, `inner` inside the container, or `null` when
 * it isn't a Block or has no text to translate.
 */
function blockOf(open: Token | undefined, inline: Token): "outer" | "inner" | null {
  if (!inline.children?.some((child) => child.type === "text" && child.content.trim())) return null;
  switch (open?.type) {
    case "paragraph_open":
      return open.hidden ? "inner" : "outer";
    case "heading_open":
      return "outer";
    case "th_open":
    case "td_open":
      return "inner";
    default:
      return null;
  }
}
