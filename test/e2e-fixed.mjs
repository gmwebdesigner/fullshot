/**
 * Fixed and sticky element test.
 *
 * Captures test/test-page.html — sticky header, fixed chat bubble, fixed cookie
 * bar, fixed full-screen background — and scans the stitched image for each
 * piece of furniture. Every one of them must appear exactly once, inside the
 * first viewport, where it belongs.
 *
 *   node test/e2e-fixed.mjs
 *   HEADED=1 node test/e2e-fixed.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  sleep, requireChrome, prepareExtension, serve, launchChrome, evaluate,
  openPage, openWorker, readCapture, reporter
} from './harness.mjs';

const PORT = 9700 + Math.floor(Math.random() * 200);
const HTTP_PORT = PORT + 200;

requireChrome();

const { work, ext } = prepareExtension();
const server = await serve(path.join(ext, 'test'), HTTP_PORT, 'test-page.html');
const pageUrl = `http://127.0.0.1:${HTTP_PORT}/test-page.html`;
const chrome = launchChrome({
  ext,
  profile: path.join(work, 'profile'),
  port: PORT,
  url: pageUrl,
  windowSize: '1200,800'
});

const { check, finish } = reporter();
const watchdog = setTimeout(() => {
  console.error('watchdog: hard timeout');
  process.exit(2);
}, 180000);

try {
  const worker = await openWorker(PORT);
  const page = await openPage(PORT, pageUrl, 3000);

  const metrics = await evaluate(
    page,
    `({ h: document.documentElement.scrollHeight, vw: document.documentElement.clientWidth,
        vh: document.documentElement.clientHeight, dpr: devicePixelRatio })`
  );
  console.log('page:', metrics);

  await evaluate(page, 'window.scrollTo(0, 900); scrollY');

  const started = Date.now();
  const result = await evaluate(worker, "fullshot.startCapture('full')");
  console.log('capture:', result, `${Date.now() - started}ms`);
  check('capture completes', result?.ok === true, JSON.stringify(result));

  check('scroll position restored', Math.abs((await evaluate(page, 'scrollY')) - 900) < 3);
  check(
    'inline styles restored on header and floating button',
    (await evaluate(
      page,
      `[...document.querySelectorAll('[data-fullshot-ignore]')].length + '/' +
       (document.querySelector('header').getAttribute('style') || 'none') + '/' +
       (document.querySelector('.floating').getAttribute('style') || 'none')`
    )) === '0/none/none'
  );

  // Scan the composite row by row for each marker.
  const scan = await evaluate(
    worker,
    readCapture(
      result.id,
      `const bmp = await createImageBitmap(rec.blob);
       const canvas = new OffscreenCanvas(bmp.width, bmp.height);
       const ctx = canvas.getContext('2d');
       ctx.drawImage(bmp, 0, 0);
       const all = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
       const scale = rec.scale;
       const near = (i, r, g, b, tol) =>
         Math.abs(all[i] - r) <= tol && Math.abs(all[i + 1] - g) <= tol && Math.abs(all[i + 2] - b) <= tol;

       //  green     the fixed chat bubble (#16a34a)
       //  cookie    the fixed cookie bar: a SOLID dark run, not stray dark text
       //  footer    the dark page footer, which spans the full width
       //  navText   dark pixels in the far right column ON A LIGHT ROW, which on
       //            this page only ever come from the sticky header's nav links
       //  shadow    the magenta widget living in an open shadow root
       const rowsGreen = [], rowsCookie = [], rowsFooter = [], rowsNav = [], rowsShadow = [];
       for (let y = 0; y < bmp.height; y += 1) {
         let green = 0, magenta = 0, wide = 0, run = 0, bestRun = 0, rightDark = 0, luma = 0, n = 0;
         for (let x = 0; x < bmp.width; x += 4) {
           const i = (y * bmp.width + x) * 4;
           if (near(i, 22, 163, 74, 12)) green += 1;
           if (near(i, 255, 0, 255, 12)) magenta += 1;
           const dark = near(i, 24, 24, 27, 6);
           if (dark) {
             wide += 1;
             if (x < bmp.width * 0.45) { run += 1; if (run > bestRun) bestRun = run; }
           } else if (x < bmp.width * 0.45) {
             run = 0;
           }
           const l = 0.299 * all[i] + 0.587 * all[i + 1] + 0.114 * all[i + 2];
           luma += l; n += 1;
           if (x > bmp.width * 0.92 && l < 120 && !near(i, 22, 163, 74, 40)) rightDark += 1;
         }
         const samples = bmp.width / 4;
         if (green > 3) rowsGreen.push(y);
         if (magenta > 3) rowsShadow.push(y);
         if (bestRun * 4 > 200 && wide < samples * 0.5) rowsCookie.push(y);
         if (wide > samples * 0.8) rowsFooter.push(y);
         if (rightDark > 0 && luma / n > 200) rowsNav.push(y);
       }

       // White text inside a dark box breaks the solid run, so the cookie bar
       // needs a wider merge gap than the others.
       const bands = (rows, gap = 3) => {
         const out = [];
         for (const y of rows) {
           const last = out[out.length - 1];
           if (last && y - last.end <= gap) last.end = y;
           else out.push({ start: y, end: y });
         }
         return out.map((b) => [Math.round(b.start / scale), Math.round((b.end - b.start + 1) / scale)]);
       };

       const crop = async (top, height, width) => {
         const s = width / bmp.width;
         const c = new OffscreenCanvas(width, Math.round(height * s));
         c.getContext('2d').drawImage(bmp, 0, top, bmp.width, height, 0, 0, width, Math.round(height * s));
         const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
         let out = '';
         for (let i = 0; i < buf.length; i += 1) out += String.fromCharCode(buf[i]);
         return btoa(out);
       };

       return {
         width: bmp.width, height: bmp.height, scale, tiles: rec.tiles,
         green: bands(rowsGreen), cookie: bands(rowsCookie, 40),
         footer: bands(rowsFooter), nav: bands(rowsNav), shadow: bands(rowsShadow),
         crops: {
           top: await crop(0, Math.min(900, bmp.height), 700),
           mid: await crop(Math.round(bmp.height * 0.42), 900, 700),
           bottom: await crop(Math.max(0, bmp.height - 900), 900, 700)
         }
       };`
    )
  );

  const { crops, ...report } = scan;
  console.log('scan:', JSON.stringify(report));
  for (const [name, b64] of Object.entries(crops)) {
    fs.writeFileSync(`/tmp/fullshot-testpage-${name}.png`, Buffer.from(b64, 'base64'));
  }
  console.log('wrote /tmp/fullshot-testpage-{top,mid,bottom}.png');

  check(
    'image height equals document height',
    Math.abs(report.height - Math.round(metrics.h * report.scale)) <= 2,
    `${report.height} vs ${Math.round(metrics.h * report.scale)}`
  );
  check('several tiles stitched', report.tiles >= 8, `${report.tiles} tiles`);
  check('floating chat bubble appears once', report.green.length === 1, JSON.stringify(report.green));
  check('cookie banner appears once', report.cookie.length === 1, JSON.stringify(report.cookie));
  check(
    'both sit inside the first viewport',
    report.green[0]?.[0] < metrics.vh && report.cookie[0]?.[0] < metrics.vh,
    `green=${JSON.stringify(report.green)} cookie=${JSON.stringify(report.cookie)} vh=${metrics.vh}`
  );
  check(
    'sticky header appears only at the top',
    report.nav.length > 0 && report.nav.every(([start]) => start < 60),
    `nav-text bands at y=${JSON.stringify(report.nav)}`
  );
  check(
    'shadow-DOM widget appears once',
    report.shadow.length === 1 && report.shadow[0][0] < metrics.vh,
    JSON.stringify(report.shadow)
  );
  check(
    'footer reaches the bottom of the image',
    report.footer.length >= 1 &&
      report.footer.at(-1)[0] + report.footer.at(-1)[1] >= metrics.h - 5,
    JSON.stringify(report.footer)
  );

  worker.close();
  page.close();
} catch (error) {
  console.error('ERROR:', error.message);
  check('harness', false, error.message);
} finally {
  clearTimeout(watchdog);
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
