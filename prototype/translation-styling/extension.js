// PROTOTYPE — throwaway. Answers one question: how should `bilingual` / `translationOnly`
// look in the built-in preview (colour, spacing, headings, lists, tables, light and dark)?
// The markup is the one fixed by "Decide the preview integration architecture"; the styling
// variants are pure CSS (preview.css), switched inside the preview (preview.js).
// Hand-written translations only; no LLM, no queue, no refresh dance.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const MODES = ['originalOnly', 'bilingual', 'translationOnly'];
const THEMES = ['Default Light Modern', 'Default Dark Modern', 'Default High Contrast', 'Default High Contrast Light'];

let mode = 'bilingual';
let translations = {};

const key = (s) => s.replace(/\s*\n\s*/g, ' ').trim();

// Hand-written translation, `null` = "{{NO_TRANSLATION_NEEDED}}", else an obvious fake.
function lookup(src) {
  const k = key(src);
  if (k in translations) return translations[k];
  return '〔译〕' + k;
}

const SKIP = new Set(['image', 'code_inline', 'math_inline', 'html_inline', 'softbreak', 'hardbreak']);
const hasText = (inline) => inline.children.some((c) => !SKIP.has(c.type) && !(c.type === 'text' && !c.content.trim()));

function placement(open, inline) {
  if (!open || !inline.content.trim() || !hasText(inline)) return null;
  if (open.type === 'paragraph_open') return open.hidden ? 'inner' : 'outer';
  if (open.type === 'heading_open') return 'outer';
  if (open.type === 'th_open' || open.type === 'td_open') return 'inner';
  return null;
}

function plugin(md) {
  const render = md.renderer.render;
  md.renderer.render = function (tokens, options, env) {
    const banner = `<span id="twain-proto" hidden data-mode="${mode}"></span>`;
    if (mode === 'originalOnly') return banner + render.call(this, tokens, options, env);

    const rules = this.rules;
    const tok = (i) => (rules[tokens[i].type] ? rules[tokens[i].type](tokens, i, options, env, this) : this.renderToken(tokens, i, options, env));
    let out = banner;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'inline') { out += tok(i); continue; }
      const where = placement(tokens[i - 1], t);
      const source = this.renderInline(t.children, options, env);
      const tr = where && lookup(t.content);
      if (!tr) { out += source; continue; }
      // Not md.renderInline(): that goes through renderer.render, i.e. this wrapper.
      const trHtml = this.renderInline(md.parseInline(tr, env)[0].children, options, env);

      if (mode === 'translationOnly') { out += trHtml; continue; }
      out += source;
      if (where === 'inner') {
        out += `<span class="twain-t">${trHtml}</span>`;
      } else {
        out += tok(++i); // the matching close token
        out += `<div class="twain-t">${trHtml}</div>`;
      }
    }
    return out;
  };
  return md;
}

function activate(context) {
  translations = JSON.parse(fs.readFileSync(path.join(context.extensionPath, 'sample', 'translations.json'), 'utf8'));

  context.subscriptions.push(
    vscode.commands.registerCommand('twainProto.pickMode', async () => {
      const pick = await vscode.window.showQuickPick(
        MODES.map((m) => ({ label: m, description: m === mode ? 'current' : '' })),
        { title: 'Display mode' },
      );
      if (!pick || pick.label === mode) return;
      mode = pick.label;
      vscode.commands.executeCommand('markdown.preview.refresh');
    }),
    vscode.commands.registerCommand('twainProto.cycleTheme', async () => {
      const c = vscode.workspace.getConfiguration('workbench');
      const next = THEMES[(THEMES.indexOf(c.get('colorTheme')) + 1) % THEMES.length];
      await c.update('colorTheme', next, vscode.ConfigurationTarget.Workspace);
      vscode.window.setStatusBarMessage(`Theme: ${next}`, 3000);
    }),
  );

  return { extendMarkdownIt: plugin };
}

module.exports = { activate };
