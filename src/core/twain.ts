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
import {
  CUSTOM_PROVIDER_ID,
  PROVIDER_PRESETS,
  providerConnection,
  type ReasoningEffort,
} from "./providers.ts";
import {
  batchInput,
  buildBriefRequest,
  buildRequest,
  RequestError,
  requestInput,
  resolveApiKey,
  type Settings,
  send,
  splitBatchResponse,
  type TranslationContext,
  translationContext,
} from "./request.ts";
import { resolveTargetLanguage } from "./target-language.ts";

export type DisplayMode = "originalOnly" | "bilingual" | "translationOnly";
export type PreflightFailure =
  | { kind: "notSetUp"; message: string; fix: "setUpConnection" }
  | { kind: "noKey"; message: string; fix: "setApiKey" }
  | { kind: "unsupportedDisplayLanguage"; message: string; fix: "openTargetLanguageSetting" };
type RunError = ReturnType<typeof classifyConnectionError> | PreflightFailure;

class EmptyBriefError extends Error {}

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

/**
 * Translation progress, with change events. Counts are Blocks, never requests or briefs:
 * `landed` includes failed Blocks, and `total` is every Block the run's pending
 * set has held, across all documents.
 */
export type Status =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "translating"; landed: number; total: number }
  | { kind: "halted"; error: RunError }
  | { kind: "someFailed"; count: number; total: number };

/** Fired at most once per run, when it ends. */
export type RunEnd =
  | { kind: "halted"; error: RunError }
  | { kind: "finishedWithFailures"; count: number; total: number };

export interface Twain {
  /** The plugin for the built-in preview's markdown-it, through `extendMarkdownIt`. */
  markdownItPlugin(md: MarkdownIt): MarkdownIt;
  setDisplayMode(mode: DisplayMode): Promise<PreflightFailure | undefined>;
  /** Restarts translation after a markdownTwain setting changes. */
  settingsChanged(): void;
  readonly displayMode: DisplayMode;
  setupSteps(provider: string, effort: ReasoningEffort): ReturnType<typeof setupSteps>;
  listModels(settings: ConnectionSettings, keyChoice?: KeyChoice): Promise<string[]>;
  testConnection(settings: ConnectionSettings, keyChoice?: KeyChoice): Promise<number>;
  classifyConnectionError(
    error: unknown,
    settings: ConnectionSettings,
  ): ReturnType<typeof classifyConnectionError>;
  /** Clears the failed set, and refreshes if the mode is translated. */
  retry(): void;
  readonly status: Status;
  onStatusChange(listener: (status: Status) => void): void;
  onRunEnd(listener: (event: RunEnd) => void): void;
}

interface Miss {
  cacheKey: string;
  input: string;
  context: TranslationContext;
  settings: Settings;
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
  /** Blocks the pending set has held. */
  blocksTotal: number;
  /** Blocks landed, failed ones included. */
  blocksLanded: number;
  /** Blocks failed since the run started or the last retry. */
  blocksFailed: number;
}

export function createTwain(deps: TwainDeps): Twain {
  let mode: DisplayMode = "originalOnly";
  const cache = new Map<string, CacheEntry>();
  /** Per brief key, the document's translation context with its Document brief; frozen once it lands. */
  const briefs = new Map<string, TranslationContext>();
  /** Cache keys for empty Block answers; they render as source until a retry. */
  const failed = new Set<string>();
  /** Per `env.currentDocument`, its latest render. */
  const latestRenders = new Map<string, DocumentRender>();
  let quietTimer: unknown;
  let run: Run | undefined;
  /** Blocks failed since the last retry, out of the Blocks of the runs that ended since then. */
  let failuresSinceRetry = { count: 0, total: 0 };
  let halted: RunError | undefined;
  let modePickVersion = 0;
  let status: Status = { kind: "idle" };
  const statusListeners: ((status: Status) => void)[] = [];
  const runEndListeners: ((event: RunEnd) => void)[] = [];

  function currentStatus(): Status {
    if (halted) return { kind: "halted", error: halted };
    if (run) {
      if (run.blocksLanded === 0 && run.awaitingBrief.size > 0) return { kind: "preparing" };
      return { kind: "translating", landed: run.blocksLanded, total: run.blocksTotal };
    }
    if (failuresSinceRetry.count > 0) return { kind: "someFailed", ...failuresSinceRetry };
    return { kind: "idle" };
  }

  /** Call after anything that may change the status; fires a change event if it did. */
  function updateStatus(): void {
    const next = currentStatus();
    if (JSON.stringify(next) === JSON.stringify(status)) return;
    status = next;
    for (const listener of statusListeners) listener(status);
  }

  /** A retry's part in the core: forgets which Blocks failed. */
  function clearFailures(): void {
    failed.clear();
    failuresSinceRetry = { count: 0, total: 0 };
    halted = undefined;
    if (run) run.blocksFailed = 0;
  }

  /** Resolve the key once for both validation and the request that follows it. */
  async function preflight(settings: Settings): Promise<{ apiKey?: string; failure?: PreflightFailure }> {
    const connection = providerConnection(settings);
    if (
      !settings.model.trim() ||
      !connection ||
      (settings.provider === CUSTOM_PROVIDER_ID && !settings.customBaseUrl.trim())
    ) {
      return { failure: { kind: "notSetUp", message: "No LLM connection set up.", fix: "setUpConnection" } };
    }
    const apiKey = await resolveApiKey(deps.secret, deps.env, {
      secretName: connection.secretName,
      envVar: connection.envVar,
    });
    if (!apiKey && settings.provider !== CUSTOM_PROVIDER_ID) {
      const label = PROVIDER_PRESETS.find((preset) => preset.id === settings.provider)?.label;
      return { failure: { kind: "noKey", message: `No API key for ${label}.`, fix: "setApiKey" } };
    }
    const language = resolveTargetLanguage(settings.targetLanguage, settings.displayLanguage);
    if (!language.ok) {
      const message =
        settings.targetLanguage === "auto"
          ? `VS Code's display language "${language.tag}" isn't in the Target language list.`
          : `Target language "${language.tag}" isn't in the Target language list.`;
      return { failure: { kind: "unsupportedDisplayLanguage", message, fix: "openTargetLanguageSetting" } };
    }
    return { apiKey };
  }

  /** Validate the live settings before sending; changed settings need a fresh render. */
  async function dispatchPreflight(current: Run, expectedSettings: Settings) {
    const settings = deps.settings();
    const check = await preflight(settings);
    if (current !== run) return;
    if (check.failure) {
      haltRun(current, check.failure);
      return;
    }
    if (JSON.stringify(settings) !== JSON.stringify(expectedSettings)) {
      abortRun();
      deps.refresh();
      updateStatus();
      return;
    }
    return check;
  }

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

  function briefContext(briefKey: string, base: TranslationContext): TranslationContext | undefined {
    const saved = briefs.get(briefKey);
    // The cached brief and translations may still match after a setting change,
    // while the source of the key for a new request may have changed.
    return saved && { ...saved, keySource: base.keySource };
  }

  function endQuietPeriod(): void {
    quietTimer = undefined;
    if (halted) return;
    for (const render of latestRenders.values()) {
      const context = briefContext(render.briefKey, render.base);
      if (context) enqueueBatches(context, render.misses, render.settings);
      // A render with no misses still replaces the misses waiting for a brief in flight.
      else if (render.misses.size > 0 || run?.pending.has(render.briefKey)) enqueueBrief(render);
    }
    latestRenders.clear();
    if (run) pump(run);
    updateStatus();
  }

  /** The run in progress, or a new one. */
  function currentRun(): Run {
    run ??= {
      controller: new AbortController(),
      pending: new Set(),
      queue: [],
      inFlight: 0,
      awaitingBrief: new Map(),
      blocksTotal: 0,
      blocksLanded: 0,
      blocksFailed: 0,
    };
    return run;
  }

  /** Enqueues a document's misses that aren't cached, failed, or pending, packed into batches. */
  function enqueueBatches(context: TranslationContext, misses: BlockInputs, settings: Settings): void {
    const fresh = [...misses]
      .map(([content, input]) => ({ cacheKey: cacheKeyOf(context, content), input, context, settings }))
      .filter(({ cacheKey }) => !cache.has(cacheKey) && !failed.has(cacheKey) && !run?.pending.has(cacheKey));
    if (fresh.length === 0) return;
    const current = currentRun();
    current.blocksTotal += fresh.length;
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
    if (current !== run || halted || current.controller.signal.aborted) return;
    while (current.inFlight < MAX_IN_FLIGHT) {
      const request = current.queue.shift();
      if (!request) return;
      current.inFlight++;
      void request();
    }
  }

  /** After a request's results are recorded: ends the run once nothing is pending. */
  function landed(current: Run): void {
    if (current !== run) return;
    if (current.pending.size > 0) {
      pump(current);
      updateStatus();
      return;
    }
    run = undefined;
    failuresSinceRetry.total += current.blocksTotal;
    deps.refresh();
    updateStatus();
    if (current.blocksFailed > 0) {
      const event: RunEnd = {
        kind: "finishedWithFailures",
        count: current.blocksFailed,
        total: current.blocksTotal,
      };
      for (const listener of runEndListeners) listener(event);
    }
  }

  async function dispatchBrief(current: Run, render: DocumentRender): Promise<void> {
    let brief: string;
    try {
      const check = await dispatchPreflight(current, render.settings);
      if (!check) return;
      const text = deps.readDocument(render.uri);
      if (text === undefined) throw new Error("The document's text can't be read");
      const input = text.slice(0, BRIEF_INPUT_CHARS);
      brief = await send(
        deps.fetch,
        buildBriefRequest(render.base, input, check.apiKey, current.controller.signal),
      );
      if (!brief.trim()) throw new EmptyBriefError("Document brief came back empty. Retry translation.");
    } catch (error) {
      if (current === run) {
        const covered = current.awaitingBrief.get(render.briefKey)?.size ?? render.misses.size;
        logRequestFailure(
          "Document brief",
          error,
          render.base,
          covered === 1 ? "1 Block" : `${covered} Blocks`,
        );
        haltRun(
          current,
          error instanceof EmptyBriefError
            ? { message: error.message }
            : classifyConnectionError(error, render.settings, render.settings.reasoningEffort !== "default"),
        );
      }
      return;
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
      enqueueBatches(context, misses, render.settings);
    } else {
      failed.add(render.briefKey);
    }
    landed(current);
  }

  async function dispatchBatch(current: Run, batch: Miss[]): Promise<void> {
    const { context, settings } = batch[0];
    let responseParts: string[] | undefined;
    try {
      const check = await dispatchPreflight(current, settings);
      if (!check) return;
      const input = batchInput(batch.map((miss) => miss.input));
      const request = buildRequest(context, input, check.apiKey, current.controller.signal);
      responseParts = splitBatchResponse(await send(deps.fetch, request), batch.length);
    } catch (error) {
      if (current === run) {
        logRequestFailure(
          "Translation",
          error,
          context,
          batch.length === 1 ? "1 Block" : `${batch.length} Blocks`,
        );
        haltRun(current, classifyConnectionError(error, settings, settings.reasoningEffort !== "default"));
      }
      return;
    }
    // Aborted: late results are discarded.
    if (current !== run) return;
    current.inFlight--;

    if (responseParts && responseParts.length !== batch.length) {
      deps.log.info(
        `A batch of ${batch.length} Blocks came back as ${responseParts.length} response parts; sending each Block on its own.`,
      );
      for (const miss of batch) current.queue.push(() => dispatchBatch(current, [miss]));
      pump(current);
      return;
    }
    batch.forEach((miss, i) => {
      const responsePart = responseParts?.[i];
      // Models often echo a Block already in the Target language instead of answering with the sentinel.
      if (responsePart === NO_TRANSLATION_SENTINEL || responsePart === miss.input) {
        cache.set(miss.cacheKey, { kind: "noTranslationNeeded" });
      } else if (responsePart) {
        cache.set(miss.cacheKey, { kind: "translation", text: responsePart });
      } else {
        if (responseParts) deps.log.error(`A Block came back empty (${context.url}, model ${context.model})`);
        failed.add(miss.cacheKey);
        current.blocksFailed++;
        failuresSinceRetry.count++;
      }
      current.pending.delete(miss.cacheKey);
      current.blocksLanded++;
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
    const failure =
      error instanceof EmptyBriefError
        ? "Document brief returned empty content"
        : `${request} request failed: ${status}${message}`;
    deps.log.error(`${failure} (${subject}, ${context.url}, model ${context.model})`);
  }

  function haltRun(current: Run, classified: RunError): void {
    if (current !== run) return;
    halted = classified;
    run = undefined;
    stopQuietPeriod();
    current.controller.abort();
    deps.refresh();
    updateStatus();
    const event: RunEnd = { kind: "halted", error: classified };
    for (const listener of runEndListeners) listener(event);
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
        context = briefContext(briefKey, base);
        // After a failed brief, the document has no misses until a retry.
        if (!failed.has(briefKey)) {
          documentRender = { uri, settings, base, briefKey, misses: new Map() };
          latestRenders.set(uri, documentRender);
          if (!halted) restartQuietPeriod();
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
    testConnection: async (settings, keyChoice) => {
      const elapsed = await testConnection(
        { fetch: deps.fetch, secret: deps.secret, env: deps.env, now: () => deps.clock.now() },
        settings,
        keyChoice,
      );
      if (mode !== "originalOnly") {
        clearFailures();
        deps.refresh();
        updateStatus();
      }
      return elapsed;
    },
    classifyConnectionError,
    async setDisplayMode(next) {
      const version = ++modePickVersion;
      if (next !== "originalOnly") {
        const check = await preflight(deps.settings());
        if (version !== modePickVersion) return;
        if (check.failure) {
          if (mode !== "originalOnly") {
            abortRun();
            clearFailures();
            mode = "originalOnly";
            deps.refresh();
            updateStatus();
          }
          return check.failure;
        }
      }
      if (next === "originalOnly") abortRun();
      clearFailures();
      mode = next;
      deps.refresh();
      updateStatus();
    },
    settingsChanged() {
      modePickVersion++;
      abortRun();
      clearFailures();
      if (mode !== "originalOnly") deps.refresh();
      updateStatus();
    },
    get displayMode() {
      return mode;
    },
    retry() {
      clearFailures();
      if (mode !== "originalOnly") deps.refresh();
      updateStatus();
    },
    get status() {
      return status;
    },
    onStatusChange(listener) {
      statusListeners.push(listener);
    },
    onRunEnd(listener) {
      runEndListeners.push(listener);
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
