import { APP_NAME, FORMAT, PDF_MODE, LIMITS } from '../shared/constants.js';
import { getSettings } from '../shared/storage.js';
import { getCapture } from '../shared/db.js';
import { buildFilename, domainOf, formatBytes, formatDateTime, oneOf } from '../shared/utils.js';
import { render, footerHeight, drawFooter } from './annotate.js';
import { buildPdf } from './pdf.js';

const $ = (id) => document.getElementById(id);

/** The quality steps the selector offers. */
const QUALITIES = [70, 80, 90, 100];

const previewCanvas = $('preview');
const ctx = previewCanvas.getContext('2d');
const wrap = $('canvas-wrap');
const textInput = $('text-input');
const statusEl = $('status');

const state = {
  record: null,
  image: null,
  /** original PNG blob, reused verbatim when no re-encoding is needed */
  sourceBlob: null,
  annotations: [],
  tool: 'none',
  color: '#ef4444',
  format: FORMAT.PNG,
  quality: 100,
  pdfMode: PDF_MODE.SINGLE,
  footer: false,
  scale: 1,
  draft: null,
  settings: null
};

document.getElementById('app-name').textContent = APP_NAME;

function setStatus(text, tone = '') {
  statusEl.textContent = text;
  if (tone) statusEl.dataset.tone = tone;
  else delete statusEl.dataset.tone;
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                    */
/* -------------------------------------------------------------------------- */

function layoutPreview() {
  if (!state.image) return;
  const available = Math.max(200, wrap.clientWidth - 24);
  state.scale = Math.min(1, available / state.image.width);
  previewCanvas.width = Math.max(1, Math.round(state.image.width * state.scale));
  previewCanvas.height = Math.max(1, Math.round(state.image.height * state.scale));
  paint();
}

function paint() {
  if (!state.image) return;
  ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  const list = state.draft ? [...state.annotations, state.draft] : state.annotations;
  render(ctx, state.image, list, state.scale);
}

/** Pointer position in image pixels. */
function toImageCoords(event) {
  const rect = previewCanvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * state.image.width,
    y: ((event.clientY - rect.top) / rect.height) * state.image.height
  };
}

/* -------------------------------------------------------------------------- */
/* Annotation input                                                           */
/* -------------------------------------------------------------------------- */

previewCanvas.addEventListener('pointerdown', (event) => {
  if (state.tool === 'none' || event.button !== 0) return;
  const point = toImageCoords(event);

  if (state.tool === 'text') {
    openTextInput(event, point);
    return;
  }

  state.draft = {
    type: state.tool,
    color: state.color,
    x1: point.x,
    y1: point.y,
    x2: point.x,
    y2: point.y
  };
  previewCanvas.setPointerCapture(event.pointerId);
});

previewCanvas.addEventListener('pointermove', (event) => {
  if (!state.draft) return;
  const point = toImageCoords(event);
  state.draft.x2 = point.x;
  state.draft.y2 = point.y;
  paint();
});

previewCanvas.addEventListener('pointerup', () => {
  if (!state.draft) return;
  const { x1, y1, x2, y2 } = state.draft;
  // Ignore stray clicks that produce a zero-size shape.
  if (Math.hypot(x2 - x1, y2 - y1) > 6) state.annotations.push(state.draft);
  state.draft = null;
  paint();
});

function openTextInput(event, point) {
  const wrapRect = wrap.getBoundingClientRect();
  textInput.hidden = false;
  textInput.value = '';
  textInput.style.left = `${event.clientX - wrapRect.left + wrap.scrollLeft}px`;
  textInput.style.top = `${event.clientY - wrapRect.top + wrap.scrollTop}px`;
  textInput.focus();

  const commit = (accept) => {
    textInput.hidden = true;
    textInput.removeEventListener('keydown', onKey);
    textInput.removeEventListener('blur', onBlur);
    if (accept && textInput.value.trim()) {
      state.annotations.push({
        type: 'text',
        color: state.color,
        text: textInput.value.trim(),
        x1: point.x,
        y1: point.y
      });
      paint();
    }
  };
  const onKey = (keyEvent) => {
    if (keyEvent.key === 'Enter') commit(true);
    if (keyEvent.key === 'Escape') commit(false);
  };
  const onBlur = () => commit(true);
  textInput.addEventListener('keydown', onKey);
  textInput.addEventListener('blur', onBlur);
}

for (const button of document.querySelectorAll('.tool[data-tool]')) {
  button.addEventListener('click', () => {
    state.tool = button.dataset.tool;
    for (const other of document.querySelectorAll('.tool[data-tool]')) {
      const active = other === button;
      other.classList.toggle('is-active', active);
      other.setAttribute('aria-pressed', String(active));
    }
    previewCanvas.dataset.tool = state.tool;
  });
}

for (const swatch of document.querySelectorAll('.swatch')) {
  swatch.addEventListener('click', () => {
    state.color = swatch.dataset.color;
    for (const other of document.querySelectorAll('.swatch')) {
      const active = other === swatch;
      other.classList.toggle('is-active', active);
      other.setAttribute('aria-checked', String(active));
    }
  });
}

$('undo').addEventListener('click', () => {
  state.annotations.pop();
  paint();
});

$('clear').addEventListener('click', () => {
  state.annotations = [];
  paint();
});

window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    state.annotations.pop();
    paint();
  }
});

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

function viewportLabel() {
  const viewport = state.record?.viewport;
  if (!viewport) return '—';
  const base = `${Math.round(viewport.w)} × ${Math.round(viewport.h)}`;
  const dpr = viewport.dpr && viewport.dpr !== 1 ? ` @${viewport.dpr}x` : '';
  return `${base}${dpr}`;
}

/**
 * Draw the screenshot, its annotations and the optional client footer at full
 * resolution. Returns null when nothing has been added, so callers can use the
 * untouched original instead of paying for a copy.
 */
function composeCanvas(footer) {
  if (!state.annotations.length && !footer) return null;

  const width = state.image.width;
  const bar = footer ? footerHeight(width) : 0;
  // Never grow past what the browser can allocate: if the capture already sits
  // at the ceiling, the strip is drawn over the last pixels instead.
  const footerTop = Math.min(
    state.image.height,
    Math.max(0, Math.min(LIMITS.MAX_CANVAS_SIDE, Math.floor(LIMITS.MAX_CANVAS_AREA / width)) - bar)
  );
  const height = bar ? footerTop + bar : state.image.height;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const exportCtx = canvas.getContext('2d', { alpha: false });
  exportCtx.fillStyle = '#ffffff';
  exportCtx.fillRect(0, 0, width, height);
  render(exportCtx, state.image, state.annotations, 1);

  if (bar) {
    drawFooter(exportCtx, width, footerTop, {
      url: state.record.url || '',
      date: formatDateTime(new Date(state.record.createdAt)),
      viewport: viewportLabel()
    });
  }

  return canvas;
}

/** Free a canvas's backing store now instead of waiting for the collector. */
function release(canvas) {
  if (!canvas) return;
  canvas.width = 1;
  canvas.height = 1;
}

/**
 * Produce the file to save.
 * Returns the original blob untouched when nothing needs re-encoding — that
 * shortcut saves several seconds on a tall PNG.
 */
async function compose({ format, quality, footer, pdfMode }) {
  const canvas = composeCanvas(footer);

  if (format === FORMAT.PDF) {
    try {
      // With no annotations and no footer the original bitmap is already the
      // page content, so a full-size copy of it is pure waste.
      return await buildPdf(canvas || state.image, {
        mode: pdfMode,
        quality,
        title: state.record.title || domainOf(state.record.url)
      });
    } finally {
      release(canvas);
    }
  }

  if (!canvas) {
    if (format === FORMAT.PNG) return state.sourceBlob;
    // JPG still has to go through a canvas, even with nothing drawn on top.
    const plain = bareCanvas();
    try {
      return await encode(plain, format, quality);
    } finally {
      release(plain);
    }
  }

  try {
    return await encode(canvas, format, quality);
  } finally {
    release(canvas);
  }
}

/** A plain full-resolution copy of the screenshot, with no extras. */
function bareCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = state.image.width;
  canvas.height = state.image.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.image, 0, 0);
  return canvas;
}

function encode(canvas, format, quality) {
  const mime = format === FORMAT.JPG ? 'image/jpeg' : 'image/png';
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error('The image could not be encoded.'))),
      mime,
      format === FORMAT.JPG ? quality / 100 : undefined
    );
  });
}

function filenameFor(format) {
  return buildFilename(state.settings.filenameTemplate, {
    url: state.record.url,
    title: state.record.title,
    date: new Date(state.record.createdAt),
    extension: format
  });
}

async function download() {
  setStatus('Preparing…');
  const blob = await compose({
    format: state.format,
    quality: state.quality,
    pdfMode: state.pdfMode,
    footer: state.footer
  });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename: filenameFor(state.format),
      saveAs: false
    });
    setStatus(`Saved · ${formatBytes(blob.size)}`);
  } catch (error) {
    setStatus(`Download failed: ${error?.message || error}`, 'error');
  } finally {
    // The download reads the blob asynchronously, so the URL has to outlive
    // this call. A minute is far more than any local write needs.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

async function copyToClipboard({ footer }) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    setStatus('Copying images is not available in this browser. Use Download instead.', 'error');
    return;
  }
  setStatus('Preparing…');
  try {
    // Clipboard image data must be PNG: no browser accepts image/jpeg here.
    const blob = await compose({ format: FORMAT.PNG, quality: 100, footer, pdfMode: state.pdfMode });
    const items = { 'image/png': blob };
    if (footer) {
      const summary = [
        state.record.url || '',
        formatDateTime(new Date(state.record.createdAt)),
        `Viewport ${viewportLabel()}`
      ].join('\n');
      items['text/plain'] = new Blob([summary], { type: 'text/plain' });
    }
    await navigator.clipboard.write([new ClipboardItem(items)]);
    setStatus(footer ? 'Copied with URL, date and viewport.' : 'Copied to clipboard.');
  } catch (error) {
    setStatus(`Copy failed: ${error?.message || error}. Use Download instead.`, 'error');
  }
}

/* -------------------------------------------------------------------------- */
/* Panel wiring                                                               */
/* -------------------------------------------------------------------------- */

for (const button of document.querySelectorAll('.seg[data-format]')) {
  button.addEventListener('click', () => {
    state.format = button.dataset.format;
    for (const other of document.querySelectorAll('.seg[data-format]')) {
      const active = other === button;
      other.classList.toggle('is-active', active);
      other.setAttribute('aria-checked', String(active));
    }
    // Quality drives the JPEG encoder, and PDF pages are JPEG too.
    $('quality-field').hidden = state.format === FORMAT.PNG;
    $('pdf-field').hidden = state.format !== FORMAT.PDF;
    $('copy').disabled = state.format === FORMAT.PDF;
  });
}

$('quality').addEventListener('change', (event) => {
  state.quality = Number(event.target.value);
});

$('pdf-mode').addEventListener('change', (event) => {
  state.pdfMode = event.target.value;
});

$('client-footer').addEventListener('change', (event) => {
  state.footer = event.target.checked;
});

$('download').addEventListener('click', () => download().catch((error) => setStatus(String(error.message || error), 'error')));
$('copy').addEventListener('click', () => copyToClipboard({ footer: false }));
$('copy-client').addEventListener('click', () => {
  $('client-footer').checked = true;
  state.footer = true;
  copyToClipboard({ footer: true });
});

$('new-capture').addEventListener('click', async () => {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id) chrome.tabs.remove(tab.id);
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(layoutPreview, 120);
});

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

(async () => {
  const id = new URLSearchParams(location.search).get('id');
  state.settings = await getSettings();

  // Settings are untrusted input: they outlive upgrades and can be edited by
  // hand. An unknown format would reach both a CSS selector, where it throws
  // and takes the whole page down, and the saved file's extension.
  state.format = oneOf(state.settings.format, FORMAT, FORMAT.PNG);
  state.pdfMode = oneOf(state.settings.pdfMode, PDF_MODE, PDF_MODE.SINGLE);
  state.quality = oneOf(Number(state.settings.jpgQuality), QUALITIES, 90);

  const stored = document.querySelector(`.seg[data-format="${state.format}"]`);
  if (stored && state.format !== FORMAT.PNG) stored.click();
  $('pdf-mode').value = state.pdfMode;
  $('quality').value = String(state.quality);
  state.footer = Boolean(state.settings.clientFooter);
  $('client-footer').checked = state.footer;

  const record = id ? await getCapture(id) : null;
  if (!record) {
    setStatus('This capture is no longer available. Take a new one.', 'error');
    document.querySelector('.layout').hidden = true;
    return;
  }

  state.record = record;
  state.sourceBlob = record.blob;
  state.image = await createImageBitmap(record.blob);

  $('meta-domain').textContent = domainOf(record.url);
  $('meta-line').textContent = `${formatDateTime(new Date(record.createdAt))} · viewport ${viewportLabel()}`;
  document.title = `${APP_NAME} — ${domainOf(record.url)}`;

  $('stat-size').textContent = `${record.width} × ${record.height}`;
  $('stat-tiles').textContent = String(record.tiles);
  $('stat-time').textContent = `${(record.durationMs / 1000).toFixed(1)}s`;
  $('stat-bytes').textContent = formatBytes(record.blob.size);

  if (record.clamped || record.truncatedReason) {
    const warning = $('warning');
    warning.hidden = false;
    warning.textContent =
      record.truncatedReason ||
      'This page was taller than a single image allows, so the capture was cut off at the maximum size.';
  }

  layoutPreview();
})().catch((error) => setStatus(String(error?.message || error), 'error'));
