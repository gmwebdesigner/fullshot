/**
 * FullShot — in-page progress overlay.
 *
 * Rendered inside a Shadow DOM so no site stylesheet can reach it, and hidden
 * for the few milliseconds around every captureVisibleTab call so it never ends
 * up inside the screenshot. Transitions are deliberately absent: a fading panel
 * could be caught mid-fade by the compositor.
 */
(() => {
  const FS = (window.__FullShot = window.__FullShot || {});
  if (FS.progressUI) return;

  const MARKER = 'data-fullshot-ignore';

  const CSS = `
    :host { all: initial; }
    .panel {
      position: fixed;
      z-index: 2147483647;
      top: 16px;
      right: 16px;
      width: 236px;
      box-sizing: border-box;
      padding: 14px 16px 12px;
      border-radius: 12px;
      background: #18181b;
      color: #fafafa;
      border: 1px solid rgba(255,255,255,.10);
      box-shadow: 0 12px 32px rgba(0,0,0,.28);
      font: 13px/1.4 Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .title { font-weight: 560; letter-spacing: -0.01em; }
    .track {
      margin: 10px 0 8px;
      height: 4px;
      border-radius: 999px;
      background: rgba(255,255,255,.14);
      overflow: hidden;
    }
    .bar { height: 100%; width: 0%; border-radius: 999px; background: #fafafa; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .count { color: #a1a1aa; font-variant-numeric: tabular-nums; font-size: 12px; }
    button {
      font: inherit;
      font-size: 12px;
      color: #fafafa;
      background: rgba(255,255,255,.08);
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 7px;
      padding: 4px 10px;
      cursor: pointer;
    }
    button:hover { background: rgba(255,255,255,.14); }
    button:focus-visible { outline: 2px solid #fafafa; outline-offset: 2px; }
    .panel[data-state="error"] { background: #7f1d1d; }
  `;

  function create({ onCancel }) {
    const host = document.createElement('div');
    host.setAttribute(MARKER, '');
    host.style.cssText = 'all: initial; position: static;';
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');
    panel.innerHTML = `
      <div class="title">Capturing page…</div>
      <div class="track"><div class="bar"></div></div>
      <div class="row">
        <span class="count">0 / 0 sections</span>
        <button type="button" aria-label="Cancel the capture">Cancel</button>
      </div>
    `;

    root.append(style, panel);
    (document.body || document.documentElement).appendChild(host);

    const bar = panel.querySelector('.bar');
    const count = panel.querySelector('.count');
    const title = panel.querySelector('.title');
    const cancelButton = panel.querySelector('button');

    cancelButton.addEventListener('click', () => onCancel?.());
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onCancel?.();
    };
    window.addEventListener('keydown', onKeyDown, true);

    return {
      host,
      update(done, total) {
        const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
        bar.style.width = `${percent}%`;
        count.textContent = `${done} / ${total} sections`;
        title.textContent = `Capturing page… ${percent}%`;
      },
      setTitle(text) {
        title.textContent = text;
      },
      error(message) {
        panel.dataset.state = 'error';
        title.textContent = message;
        count.textContent = '';
        bar.style.width = '100%';
      },
      hide() {
        host.style.display = 'none';
      },
      show() {
        host.style.display = '';
      },
      destroy() {
        window.removeEventListener('keydown', onKeyDown, true);
        host.remove();
      }
    };
  }

  FS.progressUI = { create, MARKER };
})();
