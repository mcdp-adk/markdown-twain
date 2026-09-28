// Drives the core through its one seam, the way the built-in preview and the
// adapter do: a real markdown-it with the plugins the built-in preview uses,
// fake timers, and a fake `fetch` that translates deterministically.

import katex from "@vscode/markdown-it-katex";
import MarkdownIt, { type MarkdownIt as MarkdownItInstance } from "markdown-it";
import frontMatter from "markdown-it-front-matter";
import { vi } from "vitest";
import type { Settings } from "./request.ts";
import { createTwain, type DisplayMode, type RunEnd, type Status } from "./twain.ts";

export { QUIET_MS } from "./twain.ts";
export const LATENCY_MS = 100;

export interface SentRequest {
  /** A Document brief request, or a translation request with the `Translate to …:` prefix. */
  kind: "brief" | "translation";
  url: string;
  headers: Record<string, string>;
  body: {
    model: string;
    messages: { role: string; content: string }[];
    [field: string]: unknown;
  };
  /** The system prompt. */
  system: string;
  /** The user message after the `Translate to …:` prefix, or the whole user message of a brief request. */
  input: string;
  /** The Blocks in `input`, split on the batch separator. */
  blocks: string[];
}

/** What the fake provider answers for one request. */
export type Reply = { status: number; body: unknown; headers?: Record<string, string> } | { content: string };

export const USER_PREFIX = /^Translate to [^:\n]+:\n\n\n/;
export const BATCH_JOINER = "\n\n%%\n\n";
export const SENTINEL = "{{NO_TRANSLATION_NEEDED}}";

/** A batch answer: one response part per Block, joined the way the prompt asks. */
export function joinResponseParts(responseParts: string[]): string {
  return responseParts.join(BATCH_JOINER);
}

/** The fake model's translation: the input, marked, with its Markdown intact. */
export function fakeTranslation(input: string): string {
  return `译 ${input}`;
}

/** The fake model's Document brief: names the document by its first line. */
export function fakeBrief(request: SentRequest): string {
  const document = request.input.slice(request.input.indexOf("\n\n\n") + 3);
  return `A brief of "${document.split("\n")[0]}".\nKey terms: none.`;
}

export interface ScenarioOptions {
  settings?: Partial<Settings>;
  secrets?: Record<string, string>;
  env?: Record<string, string | undefined>;
  /** How long the fake provider takes to answer. */
  latencyMs?: number;
  /** Overrides the fake provider's answer to translation requests; the default translates each Block. */
  reply?: (request: SentRequest) => Reply;
  /** Overrides the fake provider's answer to Document brief requests. */
  briefReply?: (request: SentRequest) => Reply;
  /** Preview-owned token attributes, applied to both renderers. */
  decorateMarkdownIt?: (md: MarkdownItInstance) => void;
  /** Simulates a provider that completes even after cancellation. */
  ignoreAbort?: boolean;
  /** How long reading the API key takes before a request can start. */
  secretLatencyMs?: number;
  /** A provider response for connection setup requests, bypassing translation replies. */
  connectionFetch?: (url: string, init: RequestInit) => Response | Promise<Response>;
  now?: () => number;
}

export function scenario(options: ScenarioOptions = {}) {
  vi.useFakeTimers();

  const settings: Settings = {
    targetLanguage: "zh-Hans",
    provider: "openrouter",
    customBaseUrl: "",
    customApiKeyEnv: "",
    model: "test/model",
    reasoningEffort: "default",
    displayLanguage: "en",
    ...options.settings,
  };
  const env = options.env ?? { OPENROUTER_API_KEY: "sk-or-env-key" };
  const secrets = options.secrets ?? {};
  const reply =
    options.reply ?? ((request) => ({ content: joinResponseParts(request.blocks.map(fakeTranslation)) }));
  const briefReply = options.briefReply ?? ((request) => ({ content: fakeBrief(request) }));

  /** Each document's current text, as last rendered. */
  const documents = new Map<string, string>();
  const requests: SentRequest[] = [];
  const logLines: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let refreshes = 0;
  let aborted = 0;

  const fakeFetch = (async (url: string, init: RequestInit) => {
    if (options.connectionFetch && init.method === "GET") return options.connectionFetch(url, init);
    const body = JSON.parse(init.body as string);
    if (options.connectionFetch && body.stream === true) return options.connectionFetch(url, init);
    const user = body.messages.at(-1).content as string;
    const input = user.replace(USER_PREFIX, "");
    const request: SentRequest = {
      kind: USER_PREFIX.test(user) ? "translation" : "brief",
      url,
      headers: init.headers as Record<string, string>,
      body,
      system: body.messages[0].content,
      input,
      blocks: input.split(BATCH_JOINER),
    };
    requests.push(request);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    let abortListener: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, options.latencyMs ?? LATENCY_MS);
        abortListener = () => {
          aborted++;
          if (!options.ignoreAbort) {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          }
        };
        init.signal?.addEventListener("abort", abortListener);
      });
    } finally {
      if (abortListener) init.signal?.removeEventListener("abort", abortListener);
      inFlight--;
    }
    const answer = request.kind === "brief" ? briefReply(request) : reply(request);
    return "content" in answer
      ? Response.json({ choices: [{ message: { role: "assistant", content: answer.content } }] })
      : Response.json(answer.body, { status: answer.status, headers: answer.headers });
  }) as typeof fetch;

  const twain = createTwain({
    fetch: fakeFetch,
    refresh: () => refreshes++,
    clock: {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: options.now ?? (() => Date.now()),
    },
    settings: () => settings,
    secret: async (name) => {
      if (options.secretLatencyMs) {
        await new Promise((resolve) => setTimeout(resolve, options.secretLatencyMs));
      }
      return secrets[name];
    },
    env,
    readDocument: (uri) => documents.get(uri),
    log: {
      info: (message) => logLines.push(message),
      error: (message) => logLines.push(message),
    },
  });

  const newMarkdownIt = () => {
    const md = new MarkdownIt({ html: true, linkify: true }).use(frontMatter, () => {}).use(katex);
    options.decorateMarkdownIt?.(md);
    return md;
  };
  const md = twain.markdownItPlugin(newMarkdownIt());
  const plain = newMarkdownIt();
  const statuses: Status[] = [];
  const runEnds: RunEnd[] = [];
  twain.onStatusChange((status) => statuses.push(status));
  twain.onRunEnd((event) => runEnds.push(event));

  return {
    twain,
    settings,
    /** Every status the core changed to, in order. */
    statuses,
    /** Every run-end event, in order. */
    runEnds,
    /** Every request, in the order it was sent. */
    requests,
    /** The translation requests, in the order they were sent. */
    get sent() {
      return requests.filter((request) => request.kind === "translation");
    },
    logLines,
    get refreshes() {
      return refreshes;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    get aborted() {
      return aborted;
    },
    /** Renders the way the preview does, with `env.currentDocument`; `text` becomes the document's current text. */
    render: (uri: string, text: string) => {
      documents.set(uri, text);
      return md.render(text, { currentDocument: uri });
    },
    /** Renders with no `env.currentDocument`. */
    renderWithoutDocument: (text: string) => md.render(text, {}),
    /** What the preview shows without the extension. */
    plainRender: (text: string) => plain.render(text),
    setDisplayMode: (mode: DisplayMode) => twain.setDisplayMode(mode),
    retry: () => twain.retry(),
    /** Advances fake time, letting timers and the promises they start run. */
    advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    /** Runs every pending timer, so the whole run finishes. */
    settle: () => vi.runAllTimersAsync(),
  };
}

/** The render with every translation removed. */
export function withoutTranslations(html: string): string {
  return html.replace(/<(div|span) class="twain-t">[\s\S]*?<\/\1>/g, "");
}
