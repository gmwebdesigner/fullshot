import { DEBUG, BLOCKED_SCHEMES, BLOCKED_HOSTS, LIMITS } from './constants.js';

export const log = (...args) => {
  if (DEBUG) console.log('[FullShot]', ...args);
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pad to two digits. */
const p2 = (n) => String(n).padStart(2, '0');

/**
 * Filename-safe version of an arbitrary string.
 * Keeps letters, digits and dashes; collapses everything else.
 */
export function sanitize(value, maxLength = 60) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/[\s._]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, maxLength) || 'capture';
}

/** Hostname of a URL, or a readable fallback. */
export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'page';
  }
}

/**
 * Expand a filename template.
 * Variables: {domain} {title} {date} {time}
 */
export function buildFilename(template, { url, title, date = new Date(), extension }) {
  const vars = {
    domain: sanitize(domainOf(url)),
    title: sanitize(title || 'untitled', 40),
    date: `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`,
    time: `${p2(date.getHours())}${p2(date.getMinutes())}`
  };
  const base = String(template || '{domain}-{date}-{time}')
    .replace(/\{(\w+)\}/g, (match, key) => (key in vars ? vars[key] : match));
  return `fullshot-${sanitize(base, 120)}.${extension}`;
}

/** Human readable date used on the result page. */
export function formatDateTime(date = new Date()) {
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** Human readable byte size. */
export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Why a tab cannot be captured, or null when it can.
 * Returns a sentence a human can act on, never an error code.
 */
export function tabBlockReason(tab) {
  if (!tab) return 'No active tab was found. Open a page and try again.';
  const url = tab.url || tab.pendingUrl || '';
  if (!url) {
    return 'This tab has no address yet. Wait for it to load, then try again.';
  }
  const scheme = url.slice(0, url.indexOf(':') + 1);
  if (BLOCKED_SCHEMES.includes(scheme)) {
    return "This page can't be captured because Chrome doesn't allow extensions to access it.";
  }
  if (BLOCKED_HOSTS.some((host) => url.includes(host))) {
    return "The Chrome Web Store can't be captured — Chrome blocks extensions on this site.";
  }
  if (/\.pdf($|[?#])/i.test(url)) {
    return "Chrome's built-in PDF viewer can't be captured. Open the PDF in a normal page or use the browser's own print-to-PDF.";
  }
  return null;
}

/**
 * Clamp a stitched image to what Chrome can actually allocate.
 * Returns { height, clamped } in device pixels.
 */
export function clampCanvasHeight(width, height) {
  let capped = height;
  if (capped > LIMITS.MAX_CANVAS_SIDE) capped = LIMITS.MAX_CANVAS_SIDE;
  if (width * capped > LIMITS.MAX_CANVAS_AREA) {
    capped = Math.floor(LIMITS.MAX_CANVAS_AREA / width);
  }
  return { height: Math.max(1, capped), clamped: capped < height };
}
