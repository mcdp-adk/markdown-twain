import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LATENCY_MS,
  QUIET_MS,
  fakeTranslation,
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

    await s.advance(QUIET_MS);
    expect(s.sent).toHaveLength(4);

    await s.settle();
    expect(s.refreshes - refreshesBefore).toBe(1);
    expect(s.sent.map((request) => request.input).sort()).toEqual(
      [
        "Heading",
        "A paragraph with a [link](https://example.com) and `code`.",
        "tight item one",
        "tight item two",
        "Head",
        "Other",
        "cell",
        "A quoted paragraph.",
      ].sort(),
    );

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
    expect(s.sent).toHaveLength(8);
    expect(s.refreshes - refreshesBefore).toBe(1);
  });

  it("sends each Block as raw inline Markdown with soft breaks joined", async () => {
    const s = scenario();
    s.setDisplayMode("bilingual");
    s.render(DOC, "One line\n   and the next.\n\nA hard  \nbreak and\\\nanother.\n");
    await s.settle();

    expect(s.sent.map((request) => request.input)).toEqual([
      "One line and the next.",
      "A hard  \nbreak and\\\nanother.",
    ]);
    expect(s.sent[0].body.messages).toEqual([
      { role: "system", content: expect.stringContaining("Simplified Chinese") },
      { role: "user", content: "Translate to Simplified Chinese:\n\n\nOne line and the next." },
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
    expect(s.sent).toHaveLength(3);
    const refreshesBefore = s.refreshes;

    // Two renders inside the quiet period: only the latest one's misses are sent.
    s.render(DOC, V1.replace("Second paragraph.", "Second draft."));
    await s.advance(QUIET_MS / 2);
    s.render(DOC, V1.replace("Second paragraph.", "Second, final."));
    await s.advance(QUIET_MS / 2);
    expect(s.sent).toHaveLength(3);

    await s.advance(QUIET_MS / 2);
    expect(s.sent.slice(3).map((request) => request.input)).toEqual(["Second, final."]);

    await s.settle();
    expect(s.refreshes - refreshesBefore).toBe(1);
    const html = s.render(DOC, V1.replace("Second paragraph.", "Second, final."));
    expect(html).toContain('<div class="twain-t">译 First paragraph.</div>');
    expect(html).toContain('<div class="twain-t">译 Second, final.</div>');
    expect(html).toContain('<div class="twain-t">译 Third paragraph.</div>');
  });

  it("lets misses from an edit join the run in progress", async () => {
    const s = scenario({ latencyMs: 3 * QUIET_MS });
    s.setDisplayMode("bilingual");
    const refreshesBefore = s.refreshes;
    s.render(DOC, V1);
    await s.advance(QUIET_MS);
    expect(s.sent).toHaveLength(3);

    // The run is still in flight when the edit's misses are added.
    s.render(DOC, `${V1}\nFourth paragraph.\n`);
    await s.advance(QUIET_MS);
    await s.settle();

    expect(s.sent).toHaveLength(4);
    expect(s.refreshes - refreshesBefore).toBe(1);
  });
});

describe("scenario 12: two documents", () => {
  const docA = Array.from({ length: 5 }, (_, i) => `Document A, paragraph ${i + 1}.`).join("\n\n");
  const docB = Array.from({ length: 5 }, (_, i) => `Document B, paragraph ${i + 1}.`).join("\n\n");

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
    expect(s.render("file:///a.md", docA)).toContain("译 Document A, paragraph 5.");
    expect(s.render("untitled:Untitled-1", docB)).toContain("译 Document B, paragraph 5.");
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
    await s.advance(QUIET_MS + LATENCY_MS / 2);
    expect(s.sent).toHaveLength(1);

    s.setDisplayMode("originalOnly");
    const refreshesAfter = s.refreshes;
    await s.settle();
    expect(s.refreshes).toBe(refreshesAfter);

    s.setDisplayMode("bilingual");
    expect(s.render(DOC, "Hello.\n")).toBe(s.plainRender("Hello.\n"));
  });
});
