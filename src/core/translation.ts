// Translation execution for the preview. The markdown-it adapter supplies raw Block Markdown.
import { briefSystemPrompt, briefUserMessage } from "./brief-prompt.ts";
import {
  type Connection,
  type ConnectionDeps,
  ConnectionFailure,
  type ConnectionFix,
  openConnection,
} from "./connection.ts";
import { NO_TRANSLATION_SENTINEL } from "./prompt.ts";
import {
  batchInput,
  requestInput,
  type Settings,
  splitBatchResponse,
  type TranslationContext,
  translationContext,
} from "./request.ts";
import { resolveTargetLanguage } from "./target-language.ts";

export type DisplayMode = "originalOnly" | "bilingual" | "translationOnly";
/** Why translation can't start or stopped, and the action that fixes it. */
export type Failure = { message: string; fix?: ConnectionFix | "openTargetLanguageSetting" };

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

export interface Log {
  info(message: string): void;
  error(message: string): void;
}

export interface TranslationDeps extends ConnectionDeps {
  /** Runs `markdown.preview.refresh`. */
  refresh: () => void;
  settings: () => Settings;
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
  | { kind: "halted"; error: Failure }
  | { kind: "someFailed"; count: number; total: number };

/** Fired at most once per run, when it ends. */
export type RunEnd =
  | { kind: "halted"; error: Failure }
  | { kind: "finishedWithFailures"; count: number; total: number };

/** One synchronous render's mode and Block lookup, held against its settings snapshot. */
export interface RenderSession {
  readonly mode: DisplayMode;
  /** Returns a cached translation or records a miss for the current render. */
  translationOf(rawBlockMarkdown: string): string | undefined;
}

export interface TranslationExecution {
  /** Starts a render and records the latest document even when it has no Blocks. */
  beginRender(document: unknown): RenderSession;
  setDisplayMode(mode: DisplayMode): Promise<Failure | undefined>;
  /** Restarts translation after a markdownTwain setting changes. */
  settingsChanged(): void;
  readonly displayMode: DisplayMode;
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

/** Raw Block Markdown → its request input. */
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

export function createTranslation(deps: TranslationDeps): TranslationExecution {
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
  let halted: Failure | undefined;
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

  /** The connection checked, with its key read once for both the check and the request that follows it. */
  async function preflight(settings: Settings): Promise<{ connection?: Connection; failure?: Failure }> {
    const connection = openConnection(deps, settings);
    try {
      await connection.check();
    } catch (error) {
      return { failure: failureOf(error) };
    }
    const language = resolveTargetLanguage(settings.targetLanguage, settings.displayLanguage);
    if (!language.ok) {
      const message =
        settings.targetLanguage === "auto"
          ? `VS Code's display language "${language.tag}" isn't in the Target language list.`
          : `Target language "${language.tag}" isn't in the Target language list.`;
      return { failure: { message, fix: "openTargetLanguageSetting" } };
    }
    return { connection };
  }

  /** Validate the live settings before sending; changed settings need a fresh render. */
  async function dispatchPreflight(
    current: Run,
    expectedSettings: Settings,
  ): Promise<Connection | undefined> {
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
    return check.connection;
  }

  /** Until a document's brief lands, `context` is undefined and every Block is a miss. */
  function lookup(
    rawBlockMarkdown: string,
    context: TranslationContext | undefined,
    render: DocumentRender | undefined,
  ): string | undefined {
    const cacheKey = context && cacheKeyOf(context, rawBlockMarkdown);
    const entry = cacheKey === undefined ? undefined : cache.get(cacheKey);
    const hasFailed = cacheKey !== undefined && failed.has(cacheKey);
    if (entry === undefined && render && !hasFailed) {
      render.misses.set(rawBlockMarkdown, requestInput(rawBlockMarkdown));
    }
    return entry?.kind === "translation" ? entry.text : undefined;
  }

  function beginRender(document: unknown): RenderSession {
    if (mode === "originalOnly") {
      return { mode, translationOf: () => undefined };
    }

    // A copy, so that a brief landing later is built from the settings of this render.
    const settings = { ...deps.settings() };
    const base = translationContext(settings, openConnection(deps, settings));
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
        if (!halted) restartQuietPeriod();
      }
    }

    return {
      mode,
      translationOf(rawBlockMarkdown) {
        return lookup(rawBlockMarkdown, context, documentRender);
      },
    };
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
    if (halted) return;
    for (const render of latestRenders.values()) {
      const context = briefs.get(render.briefKey);
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
    let connection: Connection;
    try {
      const checked = await dispatchPreflight(current, render.settings);
      if (!checked) return;
      connection = checked;
      const text = deps.readDocument(render.uri);
      if (text === undefined) throw new Error("The document's text can't be read");
      const input = text.slice(0, BRIEF_INPUT_CHARS);
      brief = await connection.complete(
        briefSystemPrompt(render.base.targetLanguage),
        briefUserMessage(input),
        current.controller.signal,
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
        haltRun(current, failureOf(error));
      }
      return;
    }
    // Aborted: late results are discarded.
    if (current !== run) return;
    current.inFlight--;

    const misses = current.awaitingBrief.get(render.briefKey) ?? new Map();
    current.awaitingBrief.delete(render.briefKey);
    current.pending.delete(render.briefKey);
    const context = brief ? translationContext(render.settings, connection, brief) : undefined;
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
      const connection = await dispatchPreflight(current, settings);
      if (!connection) return;
      const input = batchInput(batch.map((miss) => miss.input));
      const answer = await connection.complete(
        context.system,
        context.userPrefix + input,
        current.controller.signal,
      );
      responseParts = splitBatchResponse(answer, batch.length);
    } catch (error) {
      if (current === run) {
        logRequestFailure(
          "Translation",
          error,
          context,
          batch.length === 1 ? "1 Block" : `${batch.length} Blocks`,
        );
        haltRun(current, failureOf(error));
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
    const status = error instanceof ConnectionFailure && error.status !== undefined ? `${error.status} ` : "";
    const message =
      error instanceof ConnectionFailure
        ? error.detail
        : error instanceof Error
          ? error.message
          : String(error);
    const failure =
      error instanceof EmptyBriefError
        ? "Document brief returned empty content"
        : `${request} request failed: ${status}${message}`;
    deps.log.error(`${failure} (${subject}, ${context.url}, model ${context.model})`);
  }

  function haltRun(current: Run, classified: Failure): void {
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

  return {
    beginRender,
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

function failureOf(error: unknown): Failure {
  if (error instanceof ConnectionFailure && error.fix) return { message: error.message, fix: error.fix };
  return { message: error instanceof Error ? error.message : String(error) };
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
