// PROTOTYPE — throwaway. Runs inside the built-in preview webview.
// A floating bar (and the ← / → keys) flips html[data-twain-variant] between the CSS-only
// styling variants in preview.css. No reload needed; the choice is remembered across reloads
// in localStorage when the webview allows it.
(function () {
  const VARIANTS = [
    ['A', 'Read Frog port'],
    ['B', 'Theme-tuned pair'],
    ['C', 'Annotation'],
    ['D', 'Left rule'],
  ];
  const KEY = 'twain-proto-variant';
  const load = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const save = (v) => { try { localStorage.setItem(KEY, v); } catch { /* not persisted */ } };

  let i = Math.max(0, VARIANTS.findIndex(([k]) => k === load()));

  const bar = document.createElement('div');
  bar.id = 'twain-proto-bar';
  bar.innerHTML = '<button data-d="-1" title="Previous variant (←)">‹</button><span class="label"></span><button data-d="1" title="Next variant (→)">›</button><span class="meta"></span>';
  document.documentElement.appendChild(bar); // outside <body>, so in-place updates leave it alone

  function theme() {
    const c = document.body.classList;
    return c.contains('vscode-high-contrast-light') ? 'hc-light' : c.contains('vscode-high-contrast') ? 'hc-dark' : c.contains('vscode-dark') ? 'dark' : 'light';
  }

  function show() {
    const [k, name] = VARIANTS[i];
    document.documentElement.dataset.twainVariant = k;
    bar.querySelector('.label').textContent = `${k} · ${name}`;
    const mode = document.getElementById('twain-proto')?.dataset.mode ?? '?';
    bar.querySelector('.meta').textContent = `PROTOTYPE · ${mode} · ${theme()}`;
  }

  function step(d) {
    i = (i + d + VARIANTS.length) % VARIANTS.length;
    save(VARIANTS[i][0]);
    show();
  }

  bar.addEventListener('click', (e) => { const d = e.target.dataset?.d; if (d) step(Number(d)); });
  window.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, [contenteditable]')) return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });
  window.addEventListener('vscode.markdown.updateContent', show);
  function start() {
    if (!document.body) { setTimeout(start, 20); return; }
    new MutationObserver(show).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    show();
    setTimeout(show, 200); // the banner arrives with the content, after this script runs
  }
  start();
})();
