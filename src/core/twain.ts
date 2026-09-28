// The core: everything that decides what is translated, when, and how it is
// shown. It never imports `vscode`; the adapter injects everything it needs.

import type { MarkdownIt, Renderer, Token } from "markdown-it";
import {
  type ConnectionSettings,
  classifyConnectionError,
  type KeyChoice,
  listModels,
  setupSteps,
  testConnection,
} from "./connection.ts";
import { NO_TRANSLATION_SENTINEL } from "./prompt.ts";
import type { ReasoningEffort } from "./providers.ts";
import {
  answerSegments,
  batchInput,
  buildBriefRequest,
  buildRequest,
  RequestError,
  requestInput,
  resolveApiKey,
  type Settings,
  send,
  type TranslationContext,
  translationContext,
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
/** Characters of a document's current text its Document brief is written from. */
const BRIEF_INPUT_CHARS = 12_000;

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
  setupSteps(provider: string, effort: ReasoningEffort): ReturnType<typeof setupSteps>;
  listModels(settings: ConnectionSettings, keyChoice?: KeyChoice): Promise<string[]>;
  testConnection(settings: ConnectionSettings, keyChoice?: KeyChoice): Promise<number>;
  classifyConnectionError(
    error: unknown,
    settings: ConnectionSettings,
  ): ReturnType<typeof classifyConnectionError>;
}

interface Miss {
  cacheKey: string;
  input: string;
  context: TranslationContext;
}

/** Block `token.content` → its request input. */
type BlockInputs = Map<string, string>;

/** One document's latest render in a translated mode. */
interface DocumentRender {
  uri: string;
  settings: Settings;
  /** The translation context without the Document brief. */
  base: TranslationContext;
  /** The document URI and `base`, which its Document brief is kept under. */
  briefKey: string;
  /** The Blocks missing from the cache. */
  misses: BlockInputs;
}

/** `noTranslationNeeded` comes from the sentinel or an echo, and renders as the source in every mode. */
type CacheEntry = { kind: "translation"; text: string } | { kind: "noTranslationNeeded" };

/** From the pending set going non-empty until it empties, or until it is aborted. */
interface Run {
  controller: AbortController;
  /** Cache keys and brief keys queued or in flight. */
  pending: Set<string>;
  /** Requests waiting for a free slot, in FIFO order. */
  queue: (() => Promise<void>)[];
  inFlight: number;
  /** Per brief key in flight, the misses of the document's latest render, enqueued once its brief lands. */
  awaitingBrief: Map<string, BlockInputs>;
}

export function createTwain(deps: TwainDeps): Twain {
  let mode: DisplayMode = "originalOnly";
  const cache = new Map<string, CacheEntry>();
  /** Per brief key, the document's translation context with its Document brief; frozen once it lands. */
  const briefs = new Map<string, TranslationContext>();
  /** Cache keys and brief keys whose request failed; their Blocks render as source and aren't misses. */
  const failed = new Set<string>();
  /** Per `env.currentDocument`, its latest render. */
  const latestRenders = new Map<string, DocumentRender>();
  let quietTimer: unknown;
  let run: Run | undefined;

  /** Until a document's brief lands, `context` is undefined and every Block is a miss. */
  function lookup(
    token: Token,
    context: TranslationContext | undefined,
    render: DocumentRender | undefined,
  ): string | undefined {
    const cacheKey = context && cacheKeyOf(context, token.content);
    const entry = cacheKey === undefined ? undefined : cache.get(cacheKey);
    const hasFailed = cacheKey !== undefined && failed.has(cacheKey);
    if (entry === undefined && render && !hasFailed) {
      render.misses.set(token.content, requestInput(token.content));
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
    for (const render of latestRenders.values()) {
      const context = briefs.get(render.briefKey);
      if (context) enqueueBatches(context, render.misses);
      // A render with no misses still replaces the misses waiting for a brief in flight.
      else if (render.misses.size > 0 || run?.pending.has(render.briefKey)) enqueueBrief(render);
    }
    latestRenders.clear();
    if (run) pump(run);
  }

  /** The run in progress, or a new one. */
  function currentRun(): Run {
    run ??= {
      controller: new AbortController(),
      pending: new Set(),
      queue: [],
      inFlight: 0,
      awaitingBrief: new Map(),
    };
    return run;
  }

  /** Enqueues a document's misses that aren't cached, failed, or pending, packed into batches. */
  function enqueueBatches(context: TranslationContext, misses: BlockInputs): void {
    const fresh = [...misses]
      .map(([content, input]) => ({ cacheKey: cacheKeyOf(context, content), input, context }))
      .filter(({ cacheKey }) => !cache.has(cacheKey) && !failed.has(cacheKey) && !run?.pending.has(cacheKey));
    if (fresh.length === 0) return;
    const current = currentRun();
    for (const miss of fresh) current.pending.add(miss.cacheKey);
    for (const batch of packBatches(fresh)) current.queue.push(() => dispatchBatch(current, batch));
  }

  /** Enqueues a document's brief, unless it is pending; its latest misses wait for it. */
  function enqueueBrief(render: DocumentRender): void {
    const current = currentRun();
    current.awaitingBrief.set(render.briefKey, render.misses);
    if (current.pending.has(render.briefKey)) return;
    current.pending.add(render.briefKey);
    current.queue.push(() => dispatchBrief(current, render));
  }

  function pump(current: Run): void {
    while (current.inFlight < MAX_IN_FLIGHT) {
      const request = current.queue.shift();
      if (!request) return;
      current.inFlight++;
      void request();
    }
  }

  /** After a request's results are recorded: ends the run once nothing is pending. */
  function landed(current: Run): void {
    if (current.pending.size === 0) {
      run = undefined;
      deps.refresh();
    } else {
      pump(current);
    }
  }

  async function dispatchBrief(current: Run, render: DocumentRender): Promise<void> {
    let brief: string | undefined;
    try {
      const text = deps.readDocument(render.uri);
      if (text === undefined) throw new Error("The document's text can't be read");
      const apiKey = await resolveApiKey(deps.secret, deps.env, render.base.keySource);
      if (current !== run) return;
      const input = text.slice(0, BRIEF_INPUT_CHARS);
      brief = await send(
        deps.fetch,
        buildBriefRequest(render.base, input, apiKey, current.controller.signal),
      );
    } catch (error) {
      if (current === run) logRequestFailure("Document brief", error, render.base, render.uri);
    }
    // Aborted: late results are discarded.
    if (current !== run) return;
    current.inFlight--;

    const misses = current.awaitingBrief.get(render.briefKey) ?? new Map();
    current.awaitingBrief.delete(render.briefKey);
    current.pending.delete(render.briefKey);
    const context = brief ? translationContext(render.settings, brief) : undefined;
    if (context) {
      briefs.set(render.briefKey, context);
      enqueueBatches(context, misses);
    } else {
      if (brief === "") {
        deps.log.error(`A Document brief came back empty (${render.base.url}, model ${render.base.model})`);
      }
      failed.add(render.briefKey);
    }
    landed(current);
  }

  async function dispatchBatch(current: Run, batch: Miss[]): Promise<void> {
    const { context } = batch[0];
    let segments: string[] | undefined;
    try {
      const apiKey = await resolveApiKey(deps.secret, deps.env, context.keySource);
      if (current !== run) return;
      const input = batchInput(batch.map((miss) => miss.input));
      const request = buildRequest(context, input, apiKey, current.controller.signal);
      segments = answerSegments(await send(deps.fetch, request), batch.length);
    } catch (error) {
      if (current === run) {
        logRequestFailure(
          "Translation",
          error,
          context,
          batch.length === 1 ? "1 Block" : `${batch.length} Blocks`,
        );
      }
    }
    // Aborted: late results are discarded.
    if (current !== run) return;
    current.inFlight--;

    if (segments && segments.length !== batch.length) {
      deps.log.info(
        `A batch of ${batch.length} Blocks came back as ${segments.length} segments; sending each Block on its own.`,
      );
      for (const miss of batch) current.queue.push(() => dispatchBatch(current, [miss]));
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
    landed(current);
  }

  /** Logs the status, the provider's message, the base URL, and the model; never the key or headers. */
  function logRequestFailure(
    request: string,
    error: unknown,
    context: TranslationContext,
    subject: string,
  ): void {
    const status = error instanceof RequestError && error.status !== undefined ? `${error.status} ` : "";
    const message = error instanceof Error ? error.message : String(error);
    deps.log.error(
      `${request} request failed: ${status}${message} (${subject}, ${context.url}, model ${context.model})`,
    );
  }

  function abortRun(): void {
    run?.controller.abort();
    run = undefined;
    latestRenders.clear();
    stopQuietPeriod();
  }

  function markdownItPlugin(md: MarkdownIt): MarkdownIt {
    const render = md.renderer.render;
    md.renderer.render = function (this: Renderer, tokens, options, env) {
      if (mode === "originalOnly") return render.call(this, tokens, options, env);

      // A copy, so that a brief landing later is built from the settings of this render.
      const settings = { ...deps.settings() };
      const base = translationContext(settings);
      const document: unknown = env?.currentDocument;
      let context: TranslationContext | undefined;
      let documentRender: DocumentRender | undefined;
      if (document != null && base) {
        const uri = String(document);
        const briefKey = briefKeyOf(uri, base);
        context = briefs.get(briefKey);
        // After a failed brief, the document has no misses until a retry.
        if (!failed.has(briefKey)) {
          documentRender = { uri, settings, base, briefKey, misses: new Map() };
          latestRenders.set(uri, documentRender);
          restartQuietPeriod();
        }
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
        const translation = where && lookup(token, context, documentRender);
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
    setupSteps,
    listModels: (settings, keyChoice) =>
      listModels(
        { fetch: deps.fetch, secret: deps.secret, env: deps.env, now: () => deps.clock.now() },
        settings,
        keyChoice,
      ),
    testConnection: (settings, keyChoice) =>
      testConnection(
        { fetch: deps.fetch, secret: deps.secret, env: deps.env, now: () => deps.clock.now() },
        settings,
        keyChoice,
      ),
    classifyConnectionError,
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

/** A Block's raw inline Markdown under a translation context that covers its whole request. */
function cacheKeyOf(context: TranslationContext, content: string): string {
  return `${context.key}\n${content}`;
}

/** A document URI under its translation context without the brief. It can't equal a cache key, which starts with `{`. */
function briefKeyOf(uri: string, base: TranslationContext): string {
  return `${uri}\n${base.key}`;
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
