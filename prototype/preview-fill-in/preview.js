// PROTOTYPE — throwaway. Runs inside the built-in preview webview.
// When the plugin's banner says data-anchor="1": remember the first block whose top is
// on screen (by data-line), and after each full reload scroll that block back to the
// same viewport offset, overriding the built-in's proportional restore.
(function () {
  const KEY = 'twain-proto-anchor';
  let store = null, storeName = 'none';
  for (const [name, get] of [['sessionStorage', () => window.sessionStorage], ['localStorage', () => window.localStorage]]) {
    try { const s = get(); s.setItem(KEY + '-probe', '1'); store = s; storeName = name; break; } catch { /* try next */ }
  }

  const badge = document.createElement('div');
  badge.id = 'twain-proto-badge';
  document.documentElement.appendChild(badge); // outside <body>, so morphdom leaves it alone

  let settling = true;
  let restored = 'nothing saved';

  function banner() { return document.getElementById('twain-proto'); }
  function anchorOn() { return banner()?.dataset.anchor === '1'; }

  function show() {
    const b = banner();
    badge.textContent = `PROTOTYPE · ${b?.dataset.mode ?? '?'} · ${b?.dataset.variant ?? '?'} · ${storeName} · restore: ${restored}${settling ? ' · settling' : ''}`;
  }

  function currentAnchor() {
    for (const el of document.querySelectorAll('.code-line[data-line]')) {
      const top = el.getBoundingClientRect().top;
      if (top >= 0) return { line: el.dataset.line, top };
    }
    return null;
  }

  function save() {
    if (settling || !store || !anchorOn()) return;
    const a = currentAnchor();
    if (a) store.setItem(KEY, JSON.stringify(a));
  }

  function apply() {
    if (!store || !anchorOn()) return;
    const saved = JSON.parse(store.getItem(KEY) || 'null');
    if (!saved) return;
    const el = document.querySelector(`.code-line[data-line="${saved.line}"]`);
    if (!el) { restored = `line ${saved.line} not found`; return; }
    const delta = el.getBoundingClientRect().top - saved.top;
    if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
    restored = `line ${saved.line}, corrected ${Math.round(delta)}px`;
  }

  function endSettling() {
    if (!settling) return;
    settling = false;
    show();
    save();
  }

  // The built-in appends the content after DOMContentLoaded, then restores scroll
  // proportionally after images load. Keep re-anchoring on every layout change
  // (images, Mermaid) until things are quiet for 800 ms, 3 s pass, or the user acts.
  let quiet;
  function settleTick() {
    if (!settling) return;
    apply();
    show();
    clearTimeout(quiet);
    quiet = setTimeout(endSettling, 800);
  }

  function start() {
    if (!banner()) { setTimeout(start, 20); return; }
    new ResizeObserver(settleTick).observe(document.body);
    window.addEventListener('scroll', () => (settling ? settleTick() : save()), { passive: true });
    for (const ev of ['wheel', 'keydown', 'mousedown', 'touchstart']) window.addEventListener(ev, endSettling, { passive: true });
    setTimeout(endSettling, 3000);
    window.addEventListener('vscode.markdown.updateContent', show); // in-place edit path
    settleTick();
  }
  start();
})();
