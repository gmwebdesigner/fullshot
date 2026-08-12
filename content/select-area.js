/**
 * FullShot — drag-to-select overlay.
 *
 * Returns a rect in CSS pixels relative to the viewport, or null if the user
 * cancelled. The selection is limited to the visible viewport on purpose: a
 * region spanning several screens is a full-page capture that is cropped
 * afterwards, and the result page already offers cropping via annotation.
 */
(() => {
  const FS = (window.__FullShot = window.__FullShot || {});
  if (FS.selectArea) return;

  const MARKER = 'data-fullshot-ignore';

  const CSS = `
    :host { all: initial; }
    .layer {
      position: fixed; inset: 0; z-index: 2147483647;
      cursor: crosshair;
      font: 12px/1.4 Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .dim { position: absolute; inset: 0; background: rgba(24,24,27,.38); }
    .box {
      position: absolute; display: none;
      border: 1px solid #fafafa;
      box-shadow: 0 0 0 100vmax rgba(24,24,27,.38);
      background: transparent;
    }
    .size {
      position: absolute; transform: translateY(-26px);
      background: #18181b; color: #fafafa;
      padding: 3px 7px; border-radius: 6px;
      font-variant-numeric: tabular-nums; white-space: nowrap;
    }
    .hint {
      position: absolute; left: 50%; top: 20px; transform: translateX(-50%);
      background: #18181b; color: #fafafa;
      padding: 7px 12px; border-radius: 9px;
      box-shadow: 0 8px 24px rgba(0,0,0,.25);
    }
  `;

  function select() {
    return new Promise((resolve) => {
      const host = document.createElement('div');
      host.setAttribute(MARKER, '');
      host.style.cssText = 'all: initial; position: static;';
      const root = host.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = CSS;

      const layer = document.createElement('div');
      layer.className = 'layer';
      layer.innerHTML = `
        <div class="dim"></div>
        <div class="box"><span class="size"></span></div>
        <div class="hint">Drag to select an area — Esc to cancel</div>
      `;
      root.append(style, layer);
      (document.body || document.documentElement).appendChild(host);

      const dim = layer.querySelector('.dim');
      const box = layer.querySelector('.box');
      const size = layer.querySelector('.size');
      const hint = layer.querySelector('.hint');

      let startX = 0;
      let startY = 0;
      let dragging = false;
      let rect = null;

      const cleanup = (value) => {
        window.removeEventListener('keydown', onKeyDown, true);
        host.remove();
        resolve(value);
      };

      const draw = (event) => {
        const x = Math.min(startX, event.clientX);
        const y = Math.min(startY, event.clientY);
        const w = Math.abs(event.clientX - startX);
        const h = Math.abs(event.clientY - startY);
        rect = { x, y, w, h };
        box.style.left = `${x}px`;
        box.style.top = `${y}px`;
        box.style.width = `${w}px`;
        box.style.height = `${h}px`;
        size.textContent = `${Math.round(w)} × ${Math.round(h)}`;
      };

      layer.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        dragging = true;
        startX = event.clientX;
        startY = event.clientY;
        dim.style.display = 'none';
        hint.style.display = 'none';
        box.style.display = 'block';
        layer.setPointerCapture(event.pointerId);
        draw(event);
      });

      layer.addEventListener('pointermove', (event) => {
        if (dragging) draw(event);
      });

      layer.addEventListener('pointerup', () => {
        if (!dragging) return;
        dragging = false;
        // Ignore an accidental click: nothing meaningful to capture.
        if (!rect || rect.w < 8 || rect.h < 8) {
          cleanup(null);
          return;
        }
        // Clamp to the viewport — the screenshot cannot contain anything else.
        const x = Math.max(0, rect.x);
        const y = Math.max(0, rect.y);
        cleanup({
          x,
          y,
          w: Math.min(rect.w, window.innerWidth - x),
          h: Math.min(rect.h, window.innerHeight - y)
        });
      });

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cleanup(null);
        }
      };
      window.addEventListener('keydown', onKeyDown, true);
    });
  }

  FS.selectArea = { select };
})();
