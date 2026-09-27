// PROTOTYPE — throwaway. Answers one question: is progressive fill-in through the
// built-in Markdown preview (full reload per markdown.preview.refresh) tolerable?
// Fake translations only; no LLM, no persistence, no error handling.
const vscode = require('vscode');

const MODES = ['originalOnly', 'bilingual', 'translationOnly'];

let mode = 'bilingual';
const cache = new Map(); // source inline markdown -> fake translation
const queued = new Set();
const queue = [];
let inFlight = 0;
let timer = null;
let run = newRun();
let status;
let log;

function newRun() {
  return { start: Date.now(), refreshes: 0, landed: 0, landedSinceRefresh: 0, seen: new Set() };
}

function cfg() {
  const c = vscode.workspace.getConfiguration('twainProto');
  return {
    interval: c.get('refreshIntervalMs'),
    placeholder: c.get('placeholder'),
    anchor: c.get('scrollAnchor'),
    concurrency: c.get('concurrency'),
    min: c.get('latencyMinMs'),
    max: c.get('latencyMaxMs'),
  };
}

function elapsed() {
  return ((Date.now() - run.start) / 1000).toFixed(1) + 's';
}

function refresh(reason) {
  run.refreshes++;
  log.appendLine(`[+${elapsed()}] refresh #${run.refreshes} (${reason}); ${run.landedSinceRefresh} new; ${run.landed}/${run.seen.size} done`);
  run.landedSinceRefresh = 0;
  updateStatus();
  vscode.commands.executeCommand('markdown.preview.refresh');
}

// --- fake translator ---------------------------------------------------------

function fakeTranslate(src) {
  // Same inline markdown, so links / emphasis / code keep their place; similar length.
  return '⟦译⟧ ' + src;
}

function lookup(src) {
  run.seen.add(src);
  if (cache.has(src)) return cache.get(src);
  if (!queued.has(src)) {
    queued.add(src);
    queue.push(src);
    setImmediate(pump);
  }
  return null;
}

function pump() {
  const c = cfg();
  while (inFlight < c.concurrency && queue.length) {
    const src = queue.shift();
    inFlight++;
    const delay = c.min + Math.random() * Math.max(0, c.max - c.min);
    setTimeout(() => {
      inFlight--;
      queued.delete(src);
      cache.set(src, fakeTranslate(src));
      run.landed++;
      run.landedSinceRefresh++;
      landed();
      pump();
    }, delay);
  }
  updateStatus();
}

function landed() {
  const { interval } = cfg();
  if (interval === 0) {
    if (!queue.length && !inFlight) refresh('drained');
    return;
  }
  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      refresh('throttle');
    }, interval);
  }
}

// --- markdown-it plugin ------------------------------------------------------

const INNER = new Set(['th_open', 'td_open']); // translation goes inside the container

function unitOf(open, inline) {
  if (!open || !inline.content.trim()) return null;
  // Image-only paragraphs have nothing to translate.
  if (inline.children.every((c) => c.type === 'image' || c.type === 'softbreak' || (c.type === 'text' && !c.content.trim()))) return null;
  if (open.type === 'paragraph_open') return open.hidden ? 'inner' : 'outer';
  if (open.type === 'heading_open') return 'outer';
  if (INNER.has(open.type)) return 'inner';
  return null;
}

function plugin(md) {
  const render = md.renderer.render;
  md.renderer.render = function (tokens, options, env) {
    const c = cfg();
    const banner = `<span id="twain-proto" hidden data-mode="${mode}" data-anchor="${c.anchor ? 1 : 0}" data-variant="${variantLabel(c)}"></span>`;
    if (mode === 'originalOnly') return banner + render.call(this, tokens, options, env);

    const rules = this.rules;
    const tok = (i) => (rules[tokens[i].type] ? rules[tokens[i].type](tokens, i, options, env, this) : this.renderToken(tokens, i, options, env));
    let out = banner;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'inline') { out += tok(i); continue; }
      const open = tokens[i - 1];
      const where = unitOf(open, t);
      const source = this.renderInline(t.children, options, env);
      if (!where) { out += source; continue; }

      const tr = lookup(t.content);
      // Not md.renderInline(): that goes through renderer.render, i.e. this wrapper.
      const trHtml = tr == null ? null : this.renderInline(md.parseInline(tr, env)[0].children, options, env);

      if (mode === 'translationOnly') { out += trHtml ?? source; continue; }

      // bilingual
      let inner = trHtml, cls = '';
      if (tr == null) {
        if (c.placeholder === 'none') inner = null;
        else if (c.placeholder === 'dots') { inner = '…'; cls = ' twain-pending'; }
        else { inner = source; cls = ' twain-ghost'; }
      }
      out += source;
      if (inner == null) continue;
      if (where === 'inner') {
        out += `<span class="twain-t twain-inner${cls}">${inner}</span>`;
      } else {
        out += tok(++i); // the matching close token
        out += `<div class="twain-t twain-${open.tag}${cls}">${inner}</div>`;
      }
    }
    return out;
  };
  return md;
}

// --- UI ----------------------------------------------------------------------

function variantLabel(c) {
  return `${c.interval === 0 ? 'once-at-end' : c.interval + 'ms'} / ${c.placeholder} / anchor ${c.anchor ? 'on' : 'off'}`;
}

function updateStatus() {
  const busy = queue.length + inFlight > 0;
  status.text = `${busy ? '$(sync~spin)' : '$(check)'} twain ${run.landed}/${run.seen.size} · ${run.refreshes} refreshes · ${mode}`;
  status.tooltip = `PROTOTYPE\nvariant: ${variantLabel(cfg())}\nqueued ${queue.length}, in flight ${inFlight}, cache ${cache.size}\nelapsed ${elapsed()}`;
}

const VARIANTS = [
  { label: 'A. Naive', detail: 'refresh every 300 ms (built-in debounce floor), dots, no anchor', v: { refreshIntervalMs: 300, placeholder: 'dots', scrollAnchor: false } },
  { label: 'B. Calmer', detail: 'refresh every 1500 ms, dots, no anchor', v: { refreshIntervalMs: 1500, placeholder: 'dots', scrollAnchor: false } },
  { label: 'C. Once at end', detail: 'single refresh when the queue drains, dots, no anchor', v: { refreshIntervalMs: 0, placeholder: 'dots', scrollAnchor: false } },
  { label: 'D. Anchor', detail: 'refresh every 1000 ms, dots, data-line scroll anchor', v: { refreshIntervalMs: 1000, placeholder: 'dots', scrollAnchor: true } },
  { label: 'E. Anchor + ghost', detail: 'refresh every 1000 ms, ghost placeholder reserves height, scroll anchor', v: { refreshIntervalMs: 1000, placeholder: 'ghost', scrollAnchor: true } },
  { label: 'F. No placeholder + anchor', detail: 'refresh every 1000 ms, nothing below pending blocks, scroll anchor', v: { refreshIntervalMs: 1000, placeholder: 'none', scrollAnchor: true } },
];

function activate(context) {
  log = vscode.window.createOutputChannel('Twain Proto');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'twainProto.pickVariant';
  status.show();
  updateStatus();

  context.subscriptions.push(
    log,
    status,
    vscode.commands.registerCommand('twainProto.pickMode', async () => {
      const pick = await vscode.window.showQuickPick(
        MODES.map((m) => ({ label: m, description: m === mode ? 'current' : '' })),
        { title: 'Display mode' },
      );
      if (!pick || pick.label === mode) return;
      mode = pick.label;
      log.appendLine(`[+${elapsed()}] mode -> ${mode}`);
      refresh('mode change');
    }),
    vscode.commands.registerCommand('twainProto.replay', () => {
      cache.clear();
      run = newRun();
      log.appendLine(`--- replay, variant: ${variantLabel(cfg())}, mode: ${mode}`);
      refresh('replay');
    }),
    vscode.commands.registerCommand('twainProto.pickVariant', async () => {
      const pick = await vscode.window.showQuickPick(VARIANTS, { title: `Variant (now: ${variantLabel(cfg())})` });
      if (!pick) return;
      const c = vscode.workspace.getConfiguration('twainProto');
      for (const [k, v] of Object.entries(pick.v)) await c.update(k, v, vscode.ConfigurationTarget.Global);
      vscode.commands.executeCommand('twainProto.replay');
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('twainProto')) updateStatus();
    }),
  );

  return { extendMarkdownIt: plugin };
}

module.exports = { activate };
