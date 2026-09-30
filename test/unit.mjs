/**
 * Self-check for the pure helpers — the ones that decide a file name, refuse a
 * tab, or clamp a canvas. No browser, no Chrome, runs in a second:
 *
 *   node test/unit.mjs
 *
 * The end-to-end suites cover the capture itself; this covers the string and
 * number handling underneath it, where a wrong answer is silent.
 */
import assert from 'node:assert/strict';
import { FORMAT, PDF_MODE, LIMITS } from '../shared/constants.js';
import {
  sanitize, domainOf, buildFilename, tabBlockReason, clampCanvasHeight, oneOf, formatBytes
} from '../shared/utils.js';

let checks = 0;
const check = (label, fn) => {
  fn();
  checks += 1;
  console.log(`PASS  ${label}`);
};

/* ---- file names: the one place user data becomes a path ------------------ */

check('sanitize strips path separators and traversal', () => {
  assert.equal(sanitize('../../etc/passwd'), 'etcpasswd');
  assert.equal(sanitize('..'), 'capture');
  assert.equal(sanitize('/'), 'capture');
  assert.equal(sanitize(''), 'capture');
  assert.equal(sanitize(null), 'capture');
});

check('buildFilename cannot escape the download folder', () => {
  const name = buildFilename('{domain}-{title}', {
    url: 'https://example.com/',
    title: '../../../../Desktop/owned',
    date: new Date(2026, 0, 2, 3, 4),
    extension: 'png'
  });
  assert.ok(!name.includes('/'), name);
  assert.ok(!name.includes('..'), name);
  assert.ok(name.startsWith('fullshot-') && name.endsWith('.png'), name);
});

check('buildFilename expands the documented variables', () => {
  assert.equal(
    buildFilename('{domain}-{date}-{time}', {
      url: 'https://www.example.com/pricing',
      title: 'Pricing',
      date: new Date(2026, 7, 11, 16, 32),
      extension: 'png'
    }),
    'fullshot-example-com-2026-08-11-1632.png'
  );
});

check('buildFilename leaves an unknown variable alone', () => {
  const name = buildFilename('{nope}-{domain}', {
    url: 'https://example.com/',
    date: new Date(2026, 0, 1),
    extension: 'jpg'
  });
  assert.ok(name.includes('nope'), name);
});

check('domainOf drops www and survives rubbish', () => {
  assert.equal(domainOf('https://www.example.com/x'), 'example.com');
  assert.equal(domainOf('not a url'), 'page');
});

/* ---- which tabs may be captured ----------------------------------------- */

check('tabBlockReason refuses the pages Chrome forbids', () => {
  assert.ok(tabBlockReason({ url: 'chrome://settings' }));
  assert.ok(tabBlockReason({ url: 'https://chromewebstore.google.com/' }));
  assert.ok(tabBlockReason({ url: '' }));
  assert.ok(tabBlockReason(null));
});

check('tabBlockReason allows an ordinary page', () => {
  assert.equal(tabBlockReason({ url: 'https://example.com/pricing' }), null);
});

check('tabBlockReason judges PDFs by path, not by query string', () => {
  assert.ok(tabBlockReason({ url: 'https://example.com/report.pdf' }));
  assert.ok(tabBlockReason({ url: 'https://example.com/report.pdf?v=2' }));
  // An HTML page that merely mentions a PDF in its query is capturable.
  assert.equal(tabBlockReason({ url: 'https://example.com/view?file=report.pdf' }), null);
});

/* ---- canvas ceiling ------------------------------------------------------ */

check('clampCanvasHeight leaves a normal page untouched', () => {
  assert.deepEqual(clampCanvasHeight(1440, 8000), { height: 8000, clamped: false });
});

check('clampCanvasHeight caps the side and the area', () => {
  const side = clampCanvasHeight(1000, 40000);
  assert.equal(side.height, LIMITS.MAX_CANVAS_SIDE);
  assert.equal(side.clamped, true);

  const area = clampCanvasHeight(30000, 16384);
  assert.ok(30000 * area.height <= LIMITS.MAX_CANVAS_AREA);
  assert.equal(area.clamped, true);
});

/* ---- values read back from storage are untrusted -------------------------- */

check('oneOf refuses a value the code does not know', () => {
  assert.equal(oneOf('jpg', FORMAT, FORMAT.PNG), 'jpg');
  assert.equal(oneOf('a4', PDF_MODE, PDF_MODE.SINGLE), 'a4');
  // The shape that would break out of a CSS selector, or out of a file name.
  assert.equal(oneOf('png"] , script', FORMAT, FORMAT.PNG), 'png');
  assert.equal(oneOf(undefined, FORMAT, FORMAT.PNG), 'png');
  assert.equal(oneOf(85, [70, 80, 90, 100], 90), 90);
});

check('formatBytes reads like a file manager', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(900), '900 B');
  assert.equal(formatBytes(1536), '1.5 KB');
});

console.log(`\n${checks} checks passed`);
