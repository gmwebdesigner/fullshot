/**
 * Geometry test.
 *
 * Captures test/stitch-probe.html, whose left strip encodes each row's own Y
 * coordinate as a colour, then decodes that strip out of the stitched image.
 * Every row must decode to its true document offset — which turns "did the
 * stitch work" into arithmetic instead of eyeballing.
 *
 *   node test/e2e-stitch.mjs        # headless
 *   HEADED=1 node test/e2e-stitch.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  sleep, requireChrome, prepareExtension, serve, launchChrome, connect, evaluate,
  openPage, openWorker, waitForTarget, readCapture, reporter, cleanDownloads
} from './harness.mjs';

const PORT = 9500 + Math.floor(Math.random() * 400);
const HTTP_PORT = PORT + 500;
const PROBE_HEIGHT = 5000;

requireChrome();

const { work, ext } = prepareExtension();
const server = await serve(path.join(ext, 'test'), HTTP_PORT, 'stitch-probe.html');
const pageUrl = `http://127.0.0.1:${HTTP_PORT}/stitch-probe.html?h=${PROBE_HEIGHT}`;
const chrome = launchChrome({
  ext,
  profile: path.join(work, 'profile'),
  port: PORT,
  url: pageUrl
});

const { check, finish } = reporter();
const watchdog = setTimeout(() => {
  console.error('watchdog: hard timeout');
  process.exit(2);
}, 150000);

try {
  const worker = await openWorker(PORT);
  const page = await openPage(PORT, pageUrl, 4000);

  const metrics = await evaluate(
    page,
    `({ h: document.documentElement.scrollHeight, vw: document.documentElement.clientWidth,
        vh: document.documentElement.clientHeight, dpr: devicePixelRatio })`
  );
  console.log('page:', metrics);

  // Park the scroll mid-page: the original position must come back. The probe
  // page sets scroll-behavior: smooth, so the test's own scroll must be instant
  // too, or it would still be animating when the capture reads the origin.
  await evaluate(page, `window.scrollTo({ top: 1234, behavior: 'instant' }); scrollY`);
  await sleep(200);

  const started = Date.now();
  const result = await evaluate(worker, "fullshot.startCapture('full')");
  console.log('capture:', result, `${Date.now() - started}ms`);
  check('full page capture completes', result?.ok === true, JSON.stringify(result));

  check(
    'scroll position restored',
    Math.abs((await evaluate(page, 'scrollY')) - 1234) < 3
  );
  check(
    'page DOM restored',
    (await evaluate(
      page,
      `[...document.querySelectorAll('[data-fullshot-ignore]')].length + '/' +
       (document.querySelector('header').getAttribute('style') || 'no-style')`
    )) === '0/no-style'
  );

  const report = await evaluate(
    worker,
    readCapture(
      result.id,
      `const bmp = await createImageBitmap(rec.blob);
       const canvas = new OffscreenCanvas(bmp.width, bmp.height);
       const ctx = canvas.getContext('2d');
       ctx.drawImage(bmp, 0, 0);
       const scale = rec.scale;
       const data = ctx.getImageData(Math.round(20 * scale), 0, 1, bmp.height).data;

       let matched = 0, mismatched = 0;
       const bands = [];
       let band = null;
       const rows = Math.floor(bmp.height / scale);
       for (let y = 0; y < rows; y += 1) {
         const dy = Math.min(bmp.height - 1, Math.round(y * scale + scale / 2));
         const i = dy * 4;
         const decoded = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
         if (Math.abs(decoded - y) <= 1) {
           matched += 1;
           if (band) { bands.push(band); band = null; }
         } else {
           mismatched += 1;
           if (band) band.end = y; else band = { start: y, end: y };
         }
       }
       if (band) bands.push(band);

       const buf = new Uint8Array(await rec.blob.arrayBuffer());
       let b64 = '';
       for (let i = 0; i < buf.length; i += 1) b64 += String.fromCharCode(buf[i]);
       return {
         width: bmp.width, height: bmp.height, scale, rows, tiles: rec.tiles,
         matched, mismatched,
         bands: bands.map((b) => [b.start, b.end - b.start + 1]),
         png: btoa(b64)
       };`
    )
  );

  const { png, ...summary } = report;
  console.log('decode:', JSON.stringify(summary));
  fs.writeFileSync('/tmp/fullshot-capture.png', Buffer.from(png, 'base64'));
  console.log('wrote /tmp/fullshot-capture.png');

  check(
    'image height equals document height',
    Math.abs(report.height - Math.round(metrics.h * report.scale)) <= 2,
    `${report.height} vs ${Math.round(metrics.h * report.scale)}`
  );
  check(
    'image width equals viewport width (scrollbar cropped)',
    Math.abs(report.width - Math.round(metrics.vw * report.scale)) <= 2,
    `${report.width} vs ${Math.round(metrics.vw * report.scale)}`
  );
  check('more than one tile was stitched', report.tiles > 3, `${report.tiles} tiles`);

  // Exactly three regions may legitimately fail to decode: the sticky header
  // (top 50px), the fixed widget (last 40px of the first viewport) and the 50px
  // of page below the probe strip. Anything else is a duplicated or missing band.
  const allowed = (y) =>
    y < 55 || (y >= metrics.vh - 45 && y <= metrics.vh + 2) || y >= PROBE_HEIGHT - 1;
  check(
    'no duplicated or missing band',
    report.bands.every(([start, length]) => allowed(start) && allowed(start + length - 1)),
    `bands=${JSON.stringify(report.bands)}`
  );
  check(
    'sticky header and floating widget each appear once',
    report.bands.length === 3,
    JSON.stringify(report.bands)
  );
  check(
    'every other row decodes to its true document offset',
    report.matched >= PROBE_HEIGHT - 140,
    `${report.matched} rows aligned`
  );

  /* ---- result page: preview, annotation, export ------------------------- */

  const resultTarget = await waitForTarget(
    PORT,
    (t) => t.url.includes('result/result.html'),
    'result page'
  );
  const resultClient = connect(resultTarget.webSocketDebuggerUrl);
  await resultClient.ready;
  await resultClient.send('Runtime.enable');

  let info = null;
  for (let i = 0; i < 30; i += 1) {
    await sleep(300);
    info = await evaluate(
      resultClient,
      `({ canvas: document.getElementById('preview').width,
          size: document.getElementById('stat-size').textContent,
          tiles: document.getElementById('stat-tiles').textContent })`
    ).catch(() => null);
    if (info && info.canvas > 1 && info.size !== '—') break;
  }
  check(
    'result page renders the capture',
    info?.canvas > 1 && info.size === `${report.width} × ${report.height}`,
    JSON.stringify(info)
  );

  const exported = await evaluate(
    resultClient,
    `(async () => {
       document.querySelector('.tool[data-tool="arrow"]').click();
       const c = document.getElementById('preview');
       const r = c.getBoundingClientRect();
       const at = (type, x, y) =>
         c.dispatchEvent(new PointerEvent(type, {
           clientX: r.left + x, clientY: r.top + y, button: 0,
           buttons: type === 'pointerup' ? 0 : 1, bubbles: true, pointerId: 1
         }));
       at('pointerdown', 60, 120); at('pointermove', 240, 320); at('pointerup', 240, 320);

       document.querySelector('.seg[data-format="jpg"]').click();
       const footer = document.getElementById('client-footer');
       footer.checked = true;
       footer.dispatchEvent(new Event('change'));
       document.getElementById('download').click();

       for (let i = 0; i < 60; i += 1) {
         await new Promise((done) => setTimeout(done, 250));
         const status = document.getElementById('status');
         if (status.textContent && status.textContent !== 'Preparing…') {
           return { status: status.textContent, tone: status.dataset.tone || '',
                    annotations: document.querySelectorAll('.tool.is-active').length };
         }
       }
       return { status: 'timeout', tone: 'error' };
     })()`
  );
  check(
    'annotated JPG export downloads',
    exported.status.startsWith('Saved') && exported.tone !== 'error',
    JSON.stringify(exported)
  );

  // PDF export, both layouts, checked as real files further down.
  const pdfs = {};
  for (const [mode, label] of [['single', 'single'], ['a4', 'a4']]) {
    pdfs[label] = await evaluate(
      resultClient,
      `(async () => {
         document.querySelector('.seg[data-format="pdf"]').click();
         const select = document.getElementById('pdf-mode');
         select.value = ${JSON.stringify(mode)};
         select.dispatchEvent(new Event('change'));
         document.getElementById('status').textContent = '';
         document.getElementById('download').click();
         for (let i = 0; i < 80; i += 1) {
           await new Promise((done) => setTimeout(done, 250));
           const status = document.getElementById('status');
           if (status.textContent && status.textContent !== 'Preparing…') {
             return { status: status.textContent, tone: status.dataset.tone || '' };
           }
         }
         return { status: 'timeout', tone: 'error' };
       })()`
    );
    check(
      `PDF export (${label}) downloads`,
      pdfs[label].status.startsWith('Saved') && pdfs[label].tone !== 'error',
      JSON.stringify(pdfs[label])
    );
  }

  const preview = await evaluate(
    resultClient,
    `(() => {
       const src = document.getElementById('preview');
       const c = document.createElement('canvas');
       c.width = 400; c.height = 400;
       c.getContext('2d').drawImage(src, 0, 0, 400, 400, 0, 0, 400, 400);
       return c.toDataURL('image/png');
     })()`
  );
  fs.writeFileSync('/tmp/fullshot-annotated.png', Buffer.from(preview.split(',')[1], 'base64'));
  resultClient.close();

  /* ---- visible area mode ------------------------------------------------ */

  // The result tab is the active one now; put the captured page back in front.
  await evaluate(
    worker,
    `(async () => {
       const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:${HTTP_PORT}/*' });
       await chrome.tabs.update(t.id, { active: true });
       await chrome.windows.update(t.windowId, { focused: true });
     })()`
  );
  await sleep(600);

  const visible = await evaluate(worker, "fullshot.startCapture('visible')");
  check('visible area capture completes', visible?.ok === true, JSON.stringify(visible));

  const visibleSize = await evaluate(
    worker,
    readCapture(visible.id, 'return { w: rec.width, h: rec.height, tiles: rec.tiles };')
  );
  check(
    'visible capture equals one viewport',
    Math.abs(visibleSize.h - Math.round(metrics.vh * report.scale)) <= 2 && visibleSize.tiles === 1,
    JSON.stringify(visibleSize)
  );

  worker.close();
  page.close();
} catch (error) {
  console.error('ERROR:', error.message);
  check('harness', false, error.message);
} finally {
  clearTimeout(watchdog);
  cleanDownloads('/tmp/fullshot-exports');
  chrome.kill();
  server.close();
  await sleep(300);
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {
    /* Chrome may still be releasing the profile */
  }
}

finish();
