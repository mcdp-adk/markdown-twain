// The core: everything that decides what is translated, when, and how it is
// shown. It never imports `vscode`; the adapter injects everything it needs.

import type { MarkdownIt, Renderer, Token } from "markdown-it";
import {
  RequestError,
  buildRequest,
  requestInput,
  send,
  translationContext,
  type KeySource,
  type Settings,
  type TranslationContext,
} from "./request.ts";

export type DisplayMode = "originalOnly" | "bilingual" | "translationOnly";

/** How long after the last render the latest misses are sent. */
const QUIET_MS = 1000;
/** Requests in flight at once, per window. */
const MAX_IN_FLIGHT = 4;

export interface Clock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface Log {
  info(message: string): void;
  error(message: string): void;
}

export interface TwainDeps {
  fetch: typeof globalThis.fetch;
  /** Runs `markdown.preview.refresh`. */
  refresh: () => void;
  clock: Clock;
  settings: () => Settings;
  /** Reads SecretStorage, for example `apiKey.openai`. */
  secret: (name: string) => Promise<string | undefined>;
  env: Readonly<Record<string, string | undefined>>;
  /** Document URI → its current text. */
  readDocument: (uri: string) => string | undefined;
  log: Log;
}

export interface Twain {
  /** The plugin for the built-in preview's markdown-it, through `extendMarkdownIt`. */
  markdownItPlugin(md: MarkdownIt): MarkdownIt;
  setDisplayMode(mode: DisplayMode): void;
  readonly displayMode: DisplayMode;
}

interface Miss {
  cacheKey: string;
  input: string;
  context: TranslationContext;
}

/** From the pending set going non-empty until it empties, or until it is aborted. */
interface Run {
  controller: AbortController;
  /** Cache keys queued or in flight. */
  pending: Set<string>;
  queue: Miss[];
  inFlight: number;
}

export function createTwain(deps: TwainDeps): Twain {
  let mode: DisplayMode = "originalOnly";
  const cache = new Map<string, string>();
  /** Cache keys whose request failed; they render as source and aren't misses. */
  const failed = new Set<string>();
  /** Per `env.currentDocument`, the misses of its latest render. */
  const latestMisses = new Map<string, Map<string, Miss>>();
  let quietTimer: unknown;
  let run: Run | undefined;

  function lookup(
    token: Token,
    context: TranslationContext | undefined,
    misses: Map<string, Miss> | undefined,
  ): string | undefined {
    if (!context) return undefined;
    const cacheKey = `${context.key}\n${token.content}`;
    const translation = cache.get(cacheKey);
    if (translation === undefined && misses && !failed.has(cacheKey)) {
      misses.set(cacheKey, { cacheKey, input: requestInput(token.content), context });
    }
    return translation;
  }

  function restartQuietPeriod(): void {
    if (quietTimer !== undefined) deps.clock.clearTimeout(quietTimer);
    quietTimer = deps.clock.setTimeout(endQuietPeriod, QUIET_MS);
  }

  function endQuietPeriod(): void {
    quietTimer = undefined;
    for (const misses of latestMisses.values()) {
      for (const miss of misses.values()) {
        const { cacheKey } = miss;
        if (cache.has(cacheKey) || failed.has(cacheKey) || run?.pending.has(cacheKey)) continue;
        run ??= { controller: new AbortController(), pending: new Set(), queue: [], inFlight: 0 };
        run.pending.add(cacheKey);
        run.queue.push(miss);
      }
    }
    latestMisses.clear();
    if (run) pump(run);
  }

  function pump(current: Run): void {
    while (current.inFlight < MAX_IN_FLIGHT && current.queue.length > 0) {
      current.inFlight++;
      void dispatch(current, current.queue.shift()!);
    }
  }

  async function dispatch(current: Run, miss: Miss): Promise<void> {
    let translation: string | undefined;
    try {
      const apiKey = await resolveApiKey(miss.context.keySource);
      const request = buildRequest(miss.context, miss.input, apiKey, current.controller.signal);
      translation = (await send(deps.fetch, request)) || undefined;
      if (translation === undefined) throw new RequestError(undefined, "The translation is empty.");
    } catch (error) {
      if (current === run) logFailure(error, miss.context);
    }
    // Aborted: late results are discarded.
    if (current !== run) return;

    if (translation === undefined) failed.add(miss.cacheKey);
    else cache.set(miss.cacheKey, translation);
    current.pending.delete(miss.cacheKey);
    current.inFlight--;
    if (current.pending.size === 0) {
      run = undefined;
      deps.refresh();
    } else {
      pump(current);
    }
  }

  async function resolveApiKey(source: KeySource): Promise<string | undefined> {
    return (await deps.secret(source.secretName)) || (source.envVar && deps.env[source.envVar]) || undefined;
  }

  /** Logs the status, the provider's message, the base URL, and the model; never the key or headers. */
  function logFailure(error: unknown, context: TranslationContext): void {
    const status = error instanceof RequestError && error.status !== undefined ? `${error.status} ` : "";
    const message = error instanceof Error ? error.message : String(error);
    deps.log.error(
      `Translation request failed: ${status}${message} (1 Block, ${context.url}, model ${context.model})`,
    );
  }

  function abortRun(): void {
    run?.controller.abort();
    run = undefined;
    latestMisses.clear();
    if (quietTimer !== undefined) deps.clock.clearTimeout(quietTimer);
    quietTimer = undefined;
  }

  function markdownItPlugin(md: MarkdownIt): MarkdownIt {
    const render = md.renderer.render;
    md.renderer.render = function (this: Renderer, tokens, options, env) {
      if (mode === "originalOnly") return render.call(this, tokens, options, env);

      const context = translationContext(deps.settings());
      const document: unknown = env?.currentDocument;
      let misses: Map<string, Miss> | undefined;
      if (document != null && context) {
        misses = new Map();
        latestMisses.set(String(document), misses);
        restartQuietPeriod();
      }

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
        const translation = where && lookup(token, context, misses);
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
    setDisplayMode(next) {
      if (next === "originalOnly") abortRun();
      failed.clear();
      mode = next;
      deps.refresh();
    },
    get displayMode() {
      return mode;
    },
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
