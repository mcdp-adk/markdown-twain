// Drives the core through its one seam, the way the built-in preview and the
// adapter do: a real markdown-it with the plugins the built-in preview uses,
// fake timers, and a fake `fetch` that translates deterministically.

import katex from "@vscode/markdown-it-katex";
import MarkdownIt from "markdown-it";
import frontMatter from "markdown-it-front-matter";
import { vi } from "vitest";
import type { Settings } from "./request.ts";
import { createTwain, type DisplayMode } from "./twain.ts";

export { QUIET_MS } from "./twain.ts";
export const LATENCY_MS = 100;

export interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    model: string;
    messages: { role: string; content: string }[];
    [field: string]: unknown;
  };
  /** The text after the `Translate to …:` prefix. */
  input: string;
  /** The Blocks in `input`, split on the batch separator. */
  blocks: string[];
}

/** What the fake provider answers for one request. */
export type Reply = { status: number; body: unknown } | { content: string };

export const USER_PREFIX = /^Translate to [^:\n]+:\n\n\n/;
export const BATCH_SEPARATOR = "\n\n%%\n\n";
export const SENTINEL = "{{NO_TRANSLATION_NEEDED}}";

/** A batch answer: one segment per Block, joined the way the prompt asks. */
export function joinSegments(segments: string[]): string {
  return segments.join(BATCH_SEPARATOR);
}

/** The fake model's translation: the input, marked, with its Markdown intact. */
export function fakeTranslation(input: string): string {
  return `译 ${input}`;
}

export interface ScenarioOptions {
  settings?: Partial<Settings>;
  secrets?: Record<string, string>;
  env?: Record<string, string | undefined>;
  /** How long the fake provider takes to answer. */
  latencyMs?: number;
  /** Overrides the fake provider's answer; the default translates each Block. */
  reply?: (request: SentRequest) => Reply;
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
    options.reply ?? ((request) => ({ content: joinSegments(request.blocks.map(fakeTranslation)) }));

  const sent: SentRequest[] = [];
  const logLines: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let refreshes = 0;

  const fakeFetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const user = body.messages.at(-1).content as string;
    const input = user.replace(USER_PREFIX, "");
    const request: SentRequest = {
      url,
      headers: init.headers as Record<string, string>,
      body,
      input,
      blocks: input.split(BATCH_SEPARATOR),
    };
    sent.push(request);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, options.latencyMs ?? LATENCY_MS);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    } finally {
      inFlight--;
    }
    const answer = reply(request);
    return "content" in answer
      ? Response.json({ choices: [{ message: { role: "assistant", content: answer.content } }] })
      : Response.json(answer.body, { status: answer.status });
  }) as typeof fetch;

  const twain = createTwain({
    fetch: fakeFetch,
    refresh: () => refreshes++,
    clock: {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
    },
    settings: () => settings,
    secret: async (name) => secrets[name],
    env,
    readDocument: () => undefined,
    log: {
      info: (message) => logLines.push(message),
      error: (message) => logLines.push(message),
    },
  });

  const newMarkdownIt = () =>
    new MarkdownIt({ html: true, linkify: true }).use(frontMatter, () => {}).use(katex);
  const md = twain.markdownItPlugin(newMarkdownIt());
  const plain = newMarkdownIt();

  return {
    twain,
    settings,
    sent,
    logLines,
    get refreshes() {
      return refreshes;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    /** Renders the way the preview does, with `env.currentDocument`. */
    render: (uri: string, text: string) => md.render(text, { currentDocument: uri }),
    /** Renders with no `env.currentDocument`. */
    renderWithoutDocument: (text: string) => md.render(text, {}),
    /** What the preview shows without the extension. */
    plainRender: (text: string) => plain.render(text),
    setDisplayMode: (mode: DisplayMode) => twain.setDisplayMode(mode),
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
