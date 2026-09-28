// The core: everything that decides what is translated, when, and how it is
// shown. It never imports `vscode`; the adapter injects everything it needs.

import type { MarkdownIt, Renderer, Token } from "markdown-it";
import { NO_TRANSLATION_SENTINEL } from "./prompt.ts";
import {
  RequestError,
  answerSegments,
  batchInput,
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
export const QUIET_MS = 1000;
/** Requests in flight at once, per window. */
const MAX_IN_FLIGHT = 4;
/** Blocks per request, at most. */
const MAX_BATCH_BLOCKS = 4;
/** Characters of Block text per request, at most, unless a single Block is longer. */
const MAX_BATCH_CHARS = 1000;

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

/** `noTranslationNeeded` comes from the sentinel or an echo, and renders as the source in every mode. */
type CacheEntry = { kind: "translation"; text: string } | { kind: "noTranslationNeeded" };

/** From the pending set going non-empty until it empties, or until it is aborted. */
interface Run {
  controller: AbortController;
  /** Cache keys queued or in flight. */
  pending: Set<string>;
  /** Requests waiting for a free slot, each the Blocks it carries, in document order. */
  queue: Miss[][];
  inFlight: number;
}

export function createTwain(deps: TwainDeps): Twain {
  let mode: DisplayMode = "originalOnly";
  const cache = new Map<string, CacheEntry>();
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
    const entry = cache.get(cacheKey);
    if (entry === undefined && misses && !failed.has(cacheKey)) {
      misses.set(cacheKey, { cacheKey, input: requestInput(token.content), context });
    }
    return entry?.kind === "translation" ? entry.text : undefined;
  }

  function stopQuietPeriod(): void {
    if (quietTimer !== undefined) deps.clock.clearTimeout(quietTimer);
    quietTimer = undefined;
  }

  function restartQuietPeriod(): void {
    stopQuietPeriod();
    quietTimer = deps.clock.setTimeout(endQuietPeriod, QUIET_MS);
  }

  function endQuietPeriod(): void {
    quietTimer = undefined;
    for (const misses of latestMisses.values()) {
      const fresh = [...misses.values()].filter(
        ({ cacheKey }) => !cache.has(cacheKey) && !failed.has(cacheKey) && !run?.pending.has(cacheKey),
      );
      if (fresh.length === 0) continue;
      run ??= { controller: new AbortController(), pending: new Set(), queue: [], inFlight: 0 };
      for (const miss of fresh) run.pending.add(miss.cacheKey);
      run.queue.push(...packBatches(fresh));
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

  async function dispatch(current: Run, batch: Miss[]): Promise<void> {
    const { context } = batch[0];
    let segments: string[] | undefined;
    try {
      const apiKey = await resolveApiKey(context.keySource);
      const input = batchInput(batch.map((miss) => miss.input));
      const request = buildRequest(context, input, apiKey, current.controller.signal);
      segments = answerSegments(await send(deps.fetch, request), batch.length);
    } catch (error) {
      if (current === run) logRequestFailure(error, context, batch.length);
    }
    // Aborted: late results are discarded.
    if (current !== run) return;
    current.inFlight--;

    if (segments && segments.length !== batch.length) {
      deps.log.info(
        `A batch of ${batch.length} Blocks came back as ${segments.length} segments; sending each Block on its own.`,
      );
      current.queue.push(...batch.map((miss) => [miss]));
      pump(current);
      return;
    }
    batch.forEach((miss, i) => {
      const segment = segments?.[i];
      // Models often echo a Block already in the Target language instead of answering with the sentinel.
      if (segment === NO_TRANSLATION_SENTINEL || segment === miss.input) {
        cache.set(miss.cacheKey, { kind: "noTranslationNeeded" });
      } else if (segment) {
        cache.set(miss.cacheKey, { kind: "translation", text: segment });
      } else {
        if (segments) deps.log.error(`A Block came back empty (${context.url}, model ${context.model})`);
        failed.add(miss.cacheKey);
      }
      current.pending.delete(miss.cacheKey);
    });
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
  function logRequestFailure(error: unknown, context: TranslationContext, blockCount: number): void {
    const status = error instanceof RequestError && error.status !== undefined ? `${error.status} ` : "";
    const message = error instanceof Error ? error.message : String(error);
    const blocks = blockCount === 1 ? "1 Block" : `${blockCount} Blocks`;
    deps.log.error(
      `Translation request failed: ${status}${message} (${blocks}, ${context.url}, model ${context.model})`,
    );
  }

  function abortRun(): void {
    run?.controller.abort();
    run = undefined;
    latestMisses.clear();
    stopQuietPeriod();
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
 * Packs one document's misses into requests, in document order: up to
 * MAX_BATCH_BLOCKS Blocks or MAX_BATCH_CHARS characters, sharing one context.
 */
function packBatches(misses: Miss[]): Miss[][] {
  const batches: Miss[][] = [];
  let batch: Miss[] = [];
  let chars = 0;
  for (const miss of misses) {
    const fits =
      batch.length < MAX_BATCH_BLOCKS &&
      chars + miss.input.length <= MAX_BATCH_CHARS &&
      batch[0]?.context.key === miss.context.key;
    if (batch.length > 0 && !fits) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(miss);
    chars += miss.input.length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
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
