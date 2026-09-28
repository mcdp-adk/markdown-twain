// The one test against a real model: does it follow the batch format, the
// sentinel rule, and the inline-formatting rules? Run it with `pnpm test:live`;
// the default `vitest run`, and so CI, leaves it out.

import { readFileSync } from "node:fs";
import katex from "@vscode/markdown-it-katex";
import MarkdownIt from "markdown-it";
import frontMatter from "markdown-it-front-matter";
import { expect, it } from "vitest";
import { type Settings, splitBatchResponse } from "./request.ts";
import { createTwain } from "./twain.ts";

const SETTINGS: Settings = {
  targetLanguage: "zh-Hans",
  provider: "openrouter",
  customBaseUrl: "",
  customApiKeyEnv: "",
  model: "openai/gpt-6-luna",
  reasoningEffort: "low",
  displayLanguage: "en",
};
const SAMPLE = "sample/sample.md";
const DOC = "file:///sample.md";
const BATCH_JOINER = "\n\n%%\n\n";
const SENTINEL = "{{NO_TRANSLATION_NEEDED}}";
const USER_PREFIX = /^Translate to [^:\n]+:\n\n\n/;

interface Exchange {
  system: string;
  blocks: string[];
  responseParts: string[];
}

/** The link URLs and inline code spans in a piece of inline Markdown. */
function verbatimParts(markdown: string): string[] {
  const urls = [...markdown.matchAll(/\]\(([^)\s]+)/g)].map((match) => match[1]);
  const code = [...markdown.matchAll(/`[^`]+`/g)].map((match) => match[0]);
  return [...urls, ...code].sort();
}

it("translates the sample the way the prompt asks", { timeout: 300_000 }, async () => {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY isn't set.");

  const sample = readFileSync(SAMPLE, "utf8");
  const exchanges: Exchange[] = [];
  const briefs: string[] = [];
  const errors: string[] = [];
  let rendered = false;
  let finished!: () => void;
  const runEnded = new Promise<void>((resolve) => (finished = resolve));

  const twain = createTwain({
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      const body = JSON.parse(init?.body as string);
      const user = body.messages.at(-1).content as string;
      const answer = (await response.clone().json()) as { choices?: { message?: { content?: string } }[] };
      const content = (answer.choices?.[0]?.message?.content ?? "").trim();
      if (!USER_PREFIX.test(user)) {
        briefs.push(content);
        return response;
      }
      const blocks = user.replace(USER_PREFIX, "").split(BATCH_JOINER);
      exchanges.push({
        system: body.messages[0].content,
        blocks,
        responseParts: splitBatchResponse(content, blocks.length),
      });
      return response;
    },
    refresh: () => {
      if (rendered) finished();
    },
    clock: {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
    },
    settings: () => SETTINGS,
    secret: async () => undefined,
    env: process.env,
    readDocument: (uri) => (uri === DOC ? sample : undefined),
    log: {
      info: () => {},
      error: (message) => errors.push(message),
    },
  });
  const md = twain.markdownItPlugin(
    new MarkdownIt({ html: true, linkify: true }).use(frontMatter, () => {}).use(katex),
  );

  await twain.setDisplayMode("bilingual");
  md.render(sample, { currentDocument: DOC });
  rendered = true;
  await runEnded;
  const html = md.render(sample, { currentDocument: DOC });

  expect(errors).toEqual([]);
  // One Document brief, carried in every batch's system prompt.
  expect(briefs).toHaveLength(1);
  expect(briefs[0]).not.toBe("");
  for (const { system } of exchanges) expect(system).toContain(`\nDocument brief: ${briefs[0]}`);
  // Response part counts match. The one exception is a batch whose Blocks all need no
  // translation, collapsed into a single sentinel: the per-Block fallback recovers it.
  expect(exchanges.some(({ blocks }) => blocks.length > 1)).toBe(true);
  const answered = exchanges.filter(
    ({ blocks, responseParts }) =>
      !(blocks.length > 1 && responseParts.length === 1 && responseParts[0] === SENTINEL),
  );
  for (const { blocks, responseParts } of answered) expect(responseParts).toHaveLength(blocks.length);

  // The paragraph already in Simplified Chinese gets no translation under it.
  const chinese = html.indexOf("<p>世界上");
  expect(chinese).toBeGreaterThan(-1);
  expect(html.slice(html.indexOf("</p>", chinese))).not.toMatch(/^<\/p>\n<div class="twain-t">/);

  // URLs and inline code survive unchanged.
  for (const { blocks, responseParts } of answered) {
    blocks.forEach((block, i) => {
      expect(verbatimParts(responseParts[i])).toEqual(verbatimParts(block));
    });
  }
});
