/**
 * FullShot — shared constants.
 * Imported as an ES module by the service worker and by the extension pages.
 * Content scripts cannot import modules, so they re-declare the few message
 * type strings they need (see content/capture.js — keep both in sync).
 */

/** Product name. Change here to rebrand: popup, result page and README read it. */
export const APP_NAME = 'FullShot';

/** Flip to true to get verbose logging in every context. */
export const DEBUG = false;

/** Message types across popup → service worker → content script → result page. */
export const MSG = {
  // popup / command → service worker
  CAPTURE_START: 'CAPTURE_START',
  // service worker → content script
  CAPTURE_BEGIN: 'CAPTURE_BEGIN',
  // content script → service worker
  CAPTURE_TILE: 'CAPTURE_TILE',
  CAPTURE_FINISH: 'CAPTURE_FINISH',
  CAPTURE_CANCEL: 'CAPTURE_CANCEL'
};

/** Capture modes. */
export const MODE = {
  FULL: 'full',
  VISIBLE: 'visible',
  AREA: 'area'
};

/** Export formats. */
export const FORMAT = {
  PNG: 'png',
  JPG: 'jpg',
  PDF: 'pdf'
};

/** PDF layouts: one tall page, or as many A4 pages as it takes. */
export const PDF_MODE = {
  SINGLE: 'single',
  A4: 'a4'
};

// Capture delay presets (fast / normal / safe) live in content/capture.js.
// A content script cannot import this module, and a copy here that nothing
// reads is a second source of truth waiting to drift out of step.

/** Hard safety limits — a page with infinite scroll must not loop forever. */
export const LIMITS = {
  /** Max stitched height, in CSS pixels. */
  MAX_CAPTURE_HEIGHT: 60000,
  /** Max number of viewport captures. */
  MAX_NUMBER_OF_CAPTURES: 120,
  /** Max wall-clock duration of one capture run, in ms. */
  MAX_CAPTURE_DURATION: 120000,
  /** Chrome refuses canvases beyond these. Conservative values. */
  MAX_CANVAS_SIDE: 16384,
  MAX_CANVAS_AREA: 16384 * 16384
};

/** Default user settings. Persisted in chrome.storage.local under SETTINGS_KEY. */
export const DEFAULT_SETTINGS = {
  format: FORMAT.PNG,
  jpgQuality: 90,
  pdfMode: PDF_MODE.SINGLE,
  delay: 'normal',
  filenameTemplate: '{domain}-{date}-{time}',
  hideFixed: true,
  // Pre-tick the "client footer" box (URL / date / viewport burnt into the image)
  clientFooter: false
};

export const SETTINGS_KEY = 'fullshot.settings';

/** IndexedDB used to hand the finished blob from the worker to the result page. */
export const DB_NAME = 'fullshot';
export const DB_STORE = 'captures';
export const DB_VERSION = 1;

/** URL schemes Chrome never lets an extension touch. */
export const BLOCKED_SCHEMES = [
  'chrome:',
  'chrome-extension:',
  'devtools:',
  'edge:',
  'about:',
  'view-source:'
];

export const BLOCKED_HOSTS = [
  'chrome.google.com/webstore',
  'chromewebstore.google.com'
];
