import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fakeTranslation,
  joinSegments,
  LATENCY_MS,
  QUIET_MS,
  type Reply,
  SENTINEL,
  type SentRequest,
  scenario,
  withoutTranslations,
} from "./scenario-harness.ts";

afterEach(() => {
  vi.useRealTimers();
});

const DOC = "file:///doc.md";

const MIXED = `---
title: Front matter is not a Block
---

# Heading

A paragraph with a [link](https://example.com) and \`code\`.

- tight item one
- tight item two

| Head | Other |
| --- | --- |
| cell | \`only code\` |

\`\`\`js
const fence = "untouched";
\`\`\`

    indented code

$$
x^2
$$

<div>An HTML block</div>

![alt text is not a Block](image.png)

> A quoted paragraph.
`;

describe("scenario 1: bilingual", () => {
  it("puts a translation under every Block and leaves everything else untouched", async () => {
    const s = scenario();
    s.setDisplayMode("bilingual");
    const refreshesBefore = s.refreshes;

    // Nothing is cached yet, so the first render shows the source as it is.
    expect(s.render(DOC, MIXED)).toBe(s.plainRender(MIXED));
    expect(s.sent).toHaveLength(0);

    // The batches go out once the Document brief lands.
    await s.advance(QUIET_MS + LATENCY_MS * 1.5);
    expect(s.sent).toHaveLength(2);

    await s.settle();
    expect(s.refreshes - refreshesBefore).toBe(1);
    expect(s.sent.flatMap((request) => request.blocks)).toEqual([
      "Heading",
      "A paragraph with a [link](https://example.com) and `code`.",
      "tight item one",
      "tight item two",
      "Head",
      "Other",
      "cell",
      "A quoted paragraph.",
    ]);

    const html = s.render(DOC, MIXED);
    expect(withoutTranslations(html)).toBe(s.plainRender(MIXED));
    expect(html.match(/class="twain-t"/g)).toHaveLength(8);
    // Block-level Blocks get an outer div after their closing tag.
    expect(html).toContain('</h1>\n<div class="twain-t">译 Heading</div>');
    expect(html).toContain(
      '</p>\n<div class="twain-t">译 A paragraph with a <a href="https://example.com">link</a> and <code>code</code>.</div>',
    );
    expect(html).toContain('</p>\n<div class="twain-t">译 A quoted paragraph.</div>');
    // Tight-list paragraphs and table cells get an inner span.
    expect(html).toContain('<li>tight item one<span class="twain-t">译 tight item one</span></li>');
    expect(html).toContain('<th>Head<span class="twain-t">译 Head</span></th>');
    expect(html).toContain('<td>cell<span class="twain-t">译 cell</span></td>');
    expect(html).toContain("<td><code>only code</code></td>");

    // Everything was cached, so the refresh render sends nothing more.
    await s.settle();
    expect(s.sent).toHaveLength(2);
    expect(s.refreshes - refreshesBefore).toBe(1);
  });

  it("sends each Block as raw inline Markdown with soft breaks joined", async () => {
    const s = scenario();
    s.setDisplayMode("bilingual");
    s.render(DOC, "One line\n   and the next.\n\nA hard  \nbreak and\\\nanother.\n");
    await s.settle();

    expect(s.sent[0].blocks).toEqual(["One line and the next.", "A hard  \nbreak and\\\nanother."]);
    expect(s.sent[0].body.messages).toEqual([
      { role: "system", content: expect.stringContaining("Simplified Chinese") },
      {
        role: "user",
        content:
          "Translate to Simplified Chinese:\n\n\nOne line and the next.\n\n%%\n\nA hard  \nbreak and\\\nanother.",
      },
    ]);
    expect(s.sent[0].body.stream).toBe(false);
    expect(s.sent[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(s.sent[0].headers).toEqual({
      Authorization: "Bearer sk-or-env-key",
      "Content-Type": "application/json",
    });
  });

  it("strips a leading think block and trims the translation", async () => {
    const s = scenario({
      reply: (request) => ({
        content: `<think>\nLet me think.\n</think>\n\n  ${fakeTranslation(request.input)}  \n`,
      }),
    });
    s.setDisplayMode("bilingual");
    s.render(DOC, "Hello.\n");
    await s.settle();

    expect(s.render(DOC, "Hello.\n")).toBe('<p>Hello.</p>\n<div class="twain-t">译 Hello.</div>');
  });

  it("queues nothing for a render without env.currentDocument", async () => {
    const s = scenario();
    s.setDisplayMode("bilingual");
    s.renderWithoutDocument("Hello.\n");
    await s.settle();

    expect(s.sent).toHaveLength(0);
  });
});

describe("scenario 2: originalOnly", () => {
  it("starts in originalOnly, renders byte-identical to the unplugged renderer, and sends nothing", async () => {
    const s = scenario();
    expect(s.twain.displayMode).toBe("originalOnly");

    expect(s.render(DOC, MIXED)).toBe(s.plainRender(MIXED));
    await s.settle();
    expect(s.sent).toHaveLength(0);
    expect(s.refreshes).toBe(0);
  });

  it("brings back the untouched preview after bilingual", async () => {
    const s = scenario();
    s.setDisplayMode("bilingual");
    s.render(DOC, MIXED);
    await s.settle();
    const refreshesBefore = s.refreshes;

    s.setDisplayMode("originalOnly");
    expect(s.refreshes - refreshesBefore).toBe(1);
    expect(s.render(DOC, MIXED)).toBe(s.plainRender(MIXED));
  });
});

describe("scenario 3: editing", () => {
  const V1 = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";

  it("re-translates only the edited Block, from the latest render", async () => {
    const s = scenario();
    s.setDisplayMode("bilingual");
    s.render(DOC, V1);
    await s.settle();
    s.render(DOC, V1);
    expect(s.sent).toHaveLength(1);
    const refreshesBefore = s.refreshes;

    // Two renders inside the quiet period: only the latest one's misses are sent.
    s.render(DOC, V1.replace("Second paragraph.", "Second draft."));
    await s.advance(QUIET_MS / 2);
    s.render(DOC, V1.replace("Second paragraph.", "Second, final."));
    await s.advance(QUIET_MS / 2);
    expect(s.sent).toHaveLength(1);

    await s.advance(QUIET_MS / 2);
    expect(s.sent.slice(1).map((request) => request.input)).toEqual(["Second, final."]);

    await s.settle();
    expect(s.refreshes - refreshesBefore).toBe(1);
    const html = s.render(DOC, V1.replace("Second paragraph.", "Second, final."));
    expect(html).toContain('<div class="twain-t">译 First paragraph.</div>');
    expect(html).toContain('<div class="twain-t">译 Second, final.</div>');
    expect(html).toContain('<div class="twain-t">译 Third paragraph.</div>');
  });

  it("lets misses from an edit join the run in progress", async () => {
    const latencyMs = 3 * QUIET_MS;
    const s = scenario({ latencyMs });
    s.setDisplayMode("bilingual");
    const refreshesBefore = s.refreshes;
    s.render(DOC, V1);
    await s.advance(QUIET_MS + latencyMs + QUIET_MS / 2);
    expect(s.sent).toHaveLength(1);

    // The run is still in flight when the edit's misses are added.
    s.render(DOC, `${V1}\nFourth paragraph.\n`);
    await s.advance(QUIET_MS);
    await s.settle();

    expect(s.sent.map((request) => request.blocks)).toEqual([
      ["First paragraph.", "Second paragraph.", "Third paragraph."],
      ["Fourth paragraph."],
    ]);
    expect(s.refreshes - refreshesBefore).toBe(1);
  });
});

describe("scenario 4: batching", () => {
  const paragraphs = (n: number, length = 0) =>
    Array.from({ length: n }, (_, i) => `Paragraph ${i + 1}.`.padEnd(length, "x"));

  it("packs up to 4 Blocks per request in document order, joined with %%", async () => {
    const s = scenario();
    s.setDisplayMode("bilingual");
    const refreshesBefore = s.refreshes;
    const doc = `${paragraphs(5).join("\n\n")}\n\nA soft\nbreak.\n`;
    s.render(DOC, doc);
    await s.settle();

    expect(s.sent.map((request) => request.input)).toEqual([
      "Paragraph 1.\n\n%%\n\nParagraph 2.\n\n%%\n\nParagraph 3.\n\n%%\n\nParagraph 4.",
      "Paragraph 5.\n\n%%\n\nA soft break.",
    ]);
    expect(s.refreshes - refreshesBefore).toBe(1);
    const html = s.render(DOC, doc);
    expect(html).toContain('<div class="twain-t">译 Paragraph 4.</div>');
    expect(html).toContain('<div class="twain-t">译 A soft break.</div>');
  });

  it("packs up to 1,000 characters per request, and sends a longer Block on its own", async () => {
    const s = scenario();
    s.setDisplayMode("bilingual");
    const [a, b, c] = paragraphs(3, 400);
    const long = "Long.".padEnd(1200, "x");
    s.render(DOC, [a, b, c, long, "Short."].join("\n\n"));
    await s.settle();

    expect(s.sent.map((request) => request.blocks)).toEqual([[a, b], [c], [long], ["Short."]]);
  });

  it("uses the same system prompt, with the batch and sentinel rules, for every request", async () => {
    const s = scenario();
    s.setDisplayMode("bilingual");
    s.render(DOC, `${paragraphs(5).join("\n\n")}\n`);
    await s.settle();

    const [batch, single] = s.sent.map((request) => request.body.messages[0].content);
    expect(single).toBe(batch);
    expect(batch).toContain("## Multi-paragraph Translation Rules");
    expect(batch).toContain(
      "## Already-translated Input Rule\nOutput only {{NO_TRANSLATION_NEEDED}} when only non-translatable names, brands, handles, URLs, numbers, or code differ from Simplified Chinese.",
    );
  });

  it("sends each Block on its own when a batch comes back with the wrong segment count", async () => {
    const s = scenario({
      // A model that ignores the separators and answers in one piece.
      reply: (request) => ({ content: request.blocks.map(fakeTranslation).join("\n\n") }),
    });
    s.setDisplayMode("bilingual");
    const refreshesBefore = s.refreshes;
    const doc = paragraphs(3).join("\n\n");
    s.render(DOC, doc);
    await s.settle();

    expect(s.sent.map((request) => request.blocks)).toEqual([
      ["Paragraph 1.", "Paragraph 2.", "Paragraph 3."],
      ["Paragraph 1."],
      ["Paragraph 2."],
      ["Paragraph 3."],
    ]);
    expect(s.refreshes - refreshesBefore).toBe(1);
    const html = s.render(DOC, doc);
    expect(html).toContain('<div class="twain-t">译 Paragraph 1.</div>');
    expect(html).toContain('<div class="twain-t">译 Paragraph 3.</div>');
  });
});

describe("scenario 5: sentinel and empty segments", () => {
  const ALREADY = "这一段已经是简体中文。";
  const EMPTY = "The model skips this one.";
  const doc = `First paragraph.\n\n${ALREADY}\n\n${EMPTY}\n`;
  const answer = (block: string): string => {
    if (block === ALREADY) return SENTINEL;
    if (block === EMPTY) return "";
    return fakeTranslation(block);
  };
  const reply = (request: SentRequest): Reply => ({ content: joinSegments(request.blocks.map(answer)) });

  it("renders a sentinel Block as source in every mode and never requests it again", async () => {
    const s = scenario({ reply });
    s.setDisplayMode("bilingual");
    s.render(DOC, doc);
    await s.settle();
    expect(s.sent).toHaveLength(1);

    const bilingual = s.render(DOC, doc);
    expect(bilingual).toContain(`<p>${ALREADY}</p>\n<p>`);
    expect(bilingual).not.toContain("NO_TRANSLATION_NEEDED");
    s.setDisplayMode("translationOnly");
    const translationOnly = s.render(DOC, doc);
    expect(translationOnly).toContain(`<p>${ALREADY}</p>`);
    expect(translationOnly).toContain("<p>译 First paragraph.</p>");
    await s.settle();

    // The retry from picking a translated mode re-sends only the empty Block.
    expect(s.sent.map((request) => request.blocks)).toEqual([["First paragraph.", ALREADY, EMPTY], [EMPTY]]);
  });

  it("leaves an empty segment as source, doesn't re-request it on the next render, and sends it again on a retry", async () => {
    const s = scenario({ reply });
    s.setDisplayMode("bilingual");
    const refreshesBefore = s.refreshes;
    s.render(DOC, doc);
    await s.settle();
    expect(s.refreshes - refreshesBefore).toBe(1);

    expect(s.render(DOC, doc)).toContain(`<p>${EMPTY}</p>\n`);
    expect(s.render(DOC, doc)).not.toContain(`<div class="twain-t"></div>`);
    await s.settle();
    expect(s.sent).toHaveLength(1);

    s.setDisplayMode("bilingual");
    s.render(DOC, doc);
    await s.settle();
    expect(s.sent.map((request) => request.blocks)).toEqual([["First paragraph.", ALREADY, EMPTY], [EMPTY]]);
  });

  it("treats a sentinel answer to a single-Block request the same way", async () => {
    const s = scenario({ reply });
    s.setDisplayMode("bilingual");
    s.render(DOC, `${ALREADY}\n`);
    await s.settle();

    expect(s.render(DOC, `${ALREADY}\n`)).toBe(s.plainRender(`${ALREADY}\n`));
    s.setDisplayMode("bilingual");
    s.render(DOC, `${ALREADY}\n`);
    await s.settle();
    expect(s.sent).toHaveLength(1);
  });

  it("treats a segment identical to its Block like the sentinel", async () => {
    const soft = "这一段已经是\n简体中文。";
    const doc = `First paragraph.\n\n${soft}\n`;
    // A model that echoes the Block instead of answering with the sentinel; the echo is of what was sent.
    const s = scenario({
      reply: (request) => ({
        content: joinSegments(
          request.blocks.map((block) => (block.startsWith("这") ? block : fakeTranslation(block))),
        ),
      }),
    });
    s.setDisplayMode("bilingual");
    s.render(DOC, doc);
    await s.settle();

    const html = s.render(DOC, doc);
    expect(html).toContain('<div class="twain-t">译 First paragraph.</div>');
    expect(html.match(/class="twain-t"/g)).toHaveLength(1);
    s.setDisplayMode("bilingual");
    s.render(DOC, doc);
    await s.settle();
    expect(s.sent).toHaveLength(1);
  });

  it("fails a Block whose per-Block fallback comes back empty", async () => {
    const s = scenario({
      reply: (request) => {
        // Batches lose their separators; on its own, the second Block comes back empty.
        if (request.blocks.length > 1) return { content: request.blocks.map(fakeTranslation).join("\n\n") };
        return { content: request.input === "Second." ? "" : fakeTranslation(request.input) };
      },
    });
    s.setDisplayMode("bilingual");
    s.render(DOC, "First.\n\nSecond.\n");
    await s.settle();

    const html = s.render(DOC, "First.\n\nSecond.\n");
    expect(html).toContain('<div class="twain-t">译 First.</div>');
    expect(html.match(/class="twain-t"/g)).toHaveLength(1);
    await s.settle();
    expect(s.sent).toHaveLength(3);
  });
});

describe("scenario 6: Document brief", () => {
  const doc = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n");

  it("is the first request for a document, and its text appears in every batch's system prompt", async () => {
    const s = scenario();
    s.setDisplayMode("bilingual");
    const refreshesBefore = s.refreshes;
    s.render(DOC, doc);
    await s.advance(QUIET_MS);
    expect(s.requests.map((request) => request.kind)).toEqual(["brief"]);

    await s.settle();
    expect(s.requests.map((request) => request.kind)).toEqual(["brief", "translation", "translation"]);
    expect(s.refreshes - refreshesBefore).toBe(1);
    for (const request of s.sent) {
      expect(request.system).toContain('\nDocument brief: A brief of "Paragraph 1.".\nKey terms: none.');
    }
    expect(s.render(DOC, doc)).toContain('<div class="twain-t">译 Paragraph 6.</div>');
  });

  it("is written from the first 12,000 characters of the document's text, with the translation's request parameters", async () => {
    const s = scenario({ settings: { reasoningEffort: "low" } });
    s.setDisplayMode("bilingual");
    const head = `# Title\n\n${"Words and more words. ".repeat(1000)}`.slice(0, 12_000);
    const long = `${head}The part past the limit.\n`;
    s.render(DOC, long);
    await s.settle();

    const [brief, batch] = s.requests;
    expect(brief.kind).toBe("brief");
    expect(brief.input.endsWith(`\n${head}`)).toBe(true);
    expect(brief.input).not.toContain("past the limit");
    expect(brief.system).not.toBe(batch.system);
    expect(brief.url).toBe(batch.url);
    expect(brief.headers).toEqual(batch.headers);
    const { messages: _brief, ...briefParameters } = brief.body;
    const { messages: _batch, ...batchParameters } = batch.body;
    expect(briefParameters).toEqual(batchParameters);
    expect(briefParameters).toMatchObject({
      model: "test/model",
      stream: false,
      reasoning: { effort: "low" },
    });
  });

  it("leaves every Block a miss until it lands, then sends the latest render's misses", async () => {
    const s = scenario({ latencyMs: 3 * QUIET_MS });
    s.setDisplayMode("bilingual");
    const refreshesBefore = s.refreshes;
    s.render(DOC, "First draft.\n");
    await s.advance(QUIET_MS);
    expect(s.requests.map((request) => request.kind)).toEqual(["brief"]);

    // An edit while the brief is in flight: still all source, and no second brief.
    expect(s.render(DOC, "Final text.\n")).toBe(s.plainRender("Final text.\n"));
    await s.advance(QUIET_MS);
    expect(s.requests).toHaveLength(1);

    await s.settle();
    expect(s.sent.map((request) => request.blocks)).toEqual([["Final text."]]);
    expect(s.refreshes - refreshesBefore).toBe(1);
    expect(s.render(DOC, "Final text.\n")).toContain('<div class="twain-t">译 Final text.</div>');
  });

  it("sends nothing when the latest render before it lands has no misses", async () => {
    const s = scenario({ latencyMs: 3 * QUIET_MS });
    s.setDisplayMode("bilingual");
    s.render(DOC, "Half-typed text.\n");
    await s.advance(QUIET_MS);
    s.render(DOC, "```\ncode only\n```\n");
    await s.settle();

    expect(s.requests.map((request) => request.kind)).toEqual(["brief"]);
  });

  it("is handled like any other failed request when it fails", async () => {
    const s = scenario({
      secrets: { "apiKey.openrouter": "sk-very-secret" },
      briefReply: () => ({ status: 500, body: { error: { message: "Upstream error" } } }),
    });
    s.setDisplayMode("bilingual");
    const refreshesBefore = s.refreshes;
    s.render(DOC, doc);
    await s.settle();

    expect(s.requests.map((request) => request.kind)).toEqual(["brief"]);
    expect(s.refreshes - refreshesBefore).toBe(1);
    const log = s.logLines.join("\n");
    expect(log).toContain("Document brief request failed: 500 Upstream error");
    expect(log).not.toContain("sk-very-secret");

    // The refresh render shows the source and sends nothing more.
    expect(s.render(DOC, doc)).toBe(s.plainRender(doc));
    await s.settle();
    expect(s.requests).toHaveLength(1);

    // A retry asks for the brief again.
    s.setDisplayMode("bilingual");
    s.render(DOC, doc);
    await s.settle();
    expect(s.requests.map((request) => request.kind)).toEqual(["brief", "brief"]);
  });

  it("isn't regenerated when the document is edited", async () => {
    const s = scenario();
    s.setDisplayMode("bilingual");
    s.render(DOC, doc);
    await s.settle();

    const edited = doc.replace("Paragraph 1.", "An edited first paragraph.");
    s.render(DOC, edited);
    await s.settle();

    expect(s.requests.map((request) => request.kind)).toEqual([
      "brief",
      "translation",
      "translation",
      "translation",
    ]);
    expect(s.sent[2].blocks).toEqual(["An edited first paragraph."]);
    expect(s.sent[2].system).toBe(s.sent[0].system);
    expect(s.render(DOC, edited)).toContain('<div class="twain-t">译 An edited first paragraph.</div>');
  });

  it("is kept per translation context, so another Target language gets its own brief", async () => {
    const s = scenario();
    s.setDisplayMode("bilingual");
    s.render(DOC, doc);
    await s.settle();

    s.settings.targetLanguage = "ja";
    s.render(DOC, doc);
    await s.settle();
    s.settings.targetLanguage = "zh-Hans";
    s.render(DOC, doc);
    await s.settle();

    const kinds = s.requests.map((request) => request.kind);
    expect(kinds).toEqual(["brief", "translation", "translation", "brief", "translation", "translation"]);
    expect(s.requests[3].system).toContain("Japanese");
  });

  it("makes identical text in two documents be requested twice", async () => {
    const s = scenario();
    s.setDisplayMode("bilingual");
    s.render("file:///a.md", "# Document A\n\nSame text.\n");
    s.render("file:///b.md", "# Document B\n\nSame text.\n");
    await s.settle();

    expect(s.requests.filter((request) => request.kind === "brief")).toHaveLength(2);
    expect(s.sent.map((request) => request.blocks)).toEqual([
      ["Document A", "Same text."],
      ["Document B", "Same text."],
    ]);
  });
});

describe("scenario 12: two documents", () => {
  const docA = Array.from({ length: 20 }, (_, i) => `Document A, paragraph ${i + 1}.`).join("\n\n");
  const docB = Array.from({ length: 20 }, (_, i) => `Document B, paragraph ${i + 1}.`).join("\n\n");

  it("share one pending set and one refresh, with never more than 4 requests in flight", async () => {
    const s = scenario();
    s.setDisplayMode("bilingual");
    const refreshesBefore = s.refreshes;
    s.render("file:///a.md", docA);
    s.render("untitled:Untitled-1", docB);
    await s.settle();

    expect(s.sent).toHaveLength(10);
    expect(s.maxInFlight).toBe(4);
    expect(s.refreshes - refreshesBefore).toBe(1);
    expect(s.render("file:///a.md", docA)).toContain("译 Document A, paragraph 20.");
    expect(s.render("untitled:Untitled-1", docB)).toContain("译 Document B, paragraph 20.");
  });
});

describe("requests", () => {
  it.each([
    ["openrouter", "low", { reasoning: { effort: "low" } }],
    ["openai", "high", { reasoning_effort: "high" }],
    ["deepseek", "none", { reasoning_effort: "none" }],
  ] as const)("carry the %s effort style", async (provider, reasoningEffort, field) => {
    const s = scenario({
      settings: { provider, reasoningEffort },
      env: { OPENROUTER_API_KEY: "k", OPENAI_API_KEY: "k", DEEPSEEK_API_KEY: "k" },
    });
    s.setDisplayMode("bilingual");
    s.render(DOC, "Hello.\n");
    await s.settle();

    expect(s.sent[0].body).toMatchObject(field);
    expect(Object.keys(s.sent[0].body).sort()).toEqual(
      ["model", "messages", "stream", ...Object.keys(field)].sort(),
    );
  });

  it.each(["openrouter", "openai"])("carry no effort field at default for %s", async (provider) => {
    const s = scenario({
      settings: { provider, reasoningEffort: "default" },
      env: { OPENROUTER_API_KEY: "k", OPENAI_API_KEY: "k" },
    });
    s.setDisplayMode("bilingual");
    s.render(DOC, "Hello.\n");
    await s.settle();

    expect(Object.keys(s.sent[0].body).sort()).toEqual(["messages", "model", "stream"]);
  });

  it("take the key from SecretStorage before the environment", async () => {
    const s = scenario({ secrets: { "apiKey.openrouter": "sk-secret" } });
    s.setDisplayMode("bilingual");
    s.render(DOC, "Hello.\n");
    await s.settle();

    expect(s.sent[0].headers.Authorization).toBe("Bearer sk-secret");
  });

  it("go to a Custom base URL as entered, and carry no Authorization without a key", async () => {
    const s = scenario({
      settings: {
        provider: "custom",
        customBaseUrl: "http://localhost:1234/api/chat/completions/",
        reasoningEffort: "low",
      },
      env: {},
    });
    s.setDisplayMode("bilingual");
    s.render(DOC, "Hello.\n");
    await s.settle();

    expect(s.sent[0].url).toBe("http://localhost:1234/api/chat/completions");
    expect(s.sent[0].headers).toEqual({ "Content-Type": "application/json" });
    expect(s.sent[0].body.reasoning_effort).toBe("low");
  });

  it("read a Custom key from customApiKeyEnv", async () => {
    const s = scenario({
      settings: { provider: "custom", customBaseUrl: "http://localhost:1234", customApiKeyEnv: "MY_KEY" },
      env: { MY_KEY: "sk-mine" },
    });
    s.setDisplayMode("bilingual");
    s.render(DOC, "Hello.\n");
    await s.settle();

    expect(s.sent[0].url).toBe("http://localhost:1234/chat/completions");
    expect(s.sent[0].headers.Authorization).toBe("Bearer sk-mine");
  });

  it("follow a resolved auto Target language, cached under the resolved tag", async () => {
    const s = scenario({ settings: { targetLanguage: "auto", displayLanguage: "zh-tw" } });
    s.setDisplayMode("bilingual");
    s.render(DOC, "Hello.\n");
    await s.settle();
    expect(s.sent[0].input).toBe("Hello.");
    expect(s.sent[0].body.messages[1].content).toMatch(/^Translate to Traditional Chinese:/);

    // The same resolved language, set explicitly, hits the same cache entry.
    s.settings.targetLanguage = "zh-Hant";
    expect(s.render(DOC, "Hello.\n")).toContain('<div class="twain-t">译 Hello.</div>');
  });
});

describe("interim failure handling", () => {
  it("logs a failed request without the key, renders the Block as source, and doesn't resend it until a mode is picked", async () => {
    const s = scenario({
      secrets: { "apiKey.openrouter": "sk-very-secret" },
      reply: () => ({ status: 401, body: { error: { message: "No auth credentials found" } } }),
    });
    s.setDisplayMode("bilingual");
    const refreshesBefore = s.refreshes;
    s.render(DOC, "Hello.\n");
    await s.settle();

    expect(s.sent).toHaveLength(1);
    expect(s.refreshes - refreshesBefore).toBe(1);
    expect(s.logLines.join("\n")).toContain("401");
    expect(s.logLines.join("\n")).toContain("No auth credentials found");
    expect(s.logLines.join("\n")).not.toContain("sk-very-secret");
    expect(s.logLines.join("\n")).not.toContain("Authorization");

    // The refresh render doesn't record the failed Block as a miss.
    expect(s.render(DOC, "Hello.\n")).toBe(s.plainRender("Hello.\n"));
    await s.settle();
    expect(s.sent).toHaveLength(1);

    // Picking a translated mode clears the failed set.
    s.setDisplayMode("bilingual");
    s.render(DOC, "Hello.\n");
    await s.settle();
    expect(s.sent).toHaveLength(2);
  });

  it("treats an empty translation as a failure", async () => {
    const s = scenario({ reply: () => ({ content: "  <think>…</think>  " }) });
    s.setDisplayMode("bilingual");
    s.render(DOC, "Hello.\n");
    await s.settle();

    expect(s.render(DOC, "Hello.\n")).toBe(s.plainRender("Hello.\n"));
    await s.settle();
    expect(s.sent).toHaveLength(1);
  });

  it("drops the run and discards late results when originalOnly is picked", async () => {
    const s = scenario();
    s.setDisplayMode("bilingual");
    s.render(DOC, "Hello.\n");
    await s.advance(QUIET_MS + LATENCY_MS * 1.5);
    expect(s.sent).toHaveLength(1);

    s.setDisplayMode("originalOnly");
    const refreshesAfter = s.refreshes;
    await s.settle();
    expect(s.refreshes).toBe(refreshesAfter);

    s.setDisplayMode("bilingual");
    expect(s.render(DOC, "Hello.\n")).toBe(s.plainRender("Hello.\n"));
  });
});
