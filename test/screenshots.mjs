/**
 * Regenerate the README screenshots from the extension actually running:
 * the result page with annotations, the popup in both themes, the in-page
 * progress overlay and the settings page. Everything is shot at DPR 2.
 *
 *   node test/screenshots.mjs
 *
 * Output goes to assets/screenshots/, overwriting what is there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  CHROME, EXT_SRC, sleep, requireChrome, prepareExtension, serve, evaluate,
  connect, waitForTarget, openPage, openWorker
} from './harness.mjs';

const OUT = path.join(EXT_SRC, 'assets/screenshots');
const PORT = 9820;
const HTTP_PORT = 9821;
const DPR = 2;

requireChrome();
fs.mkdirSync(OUT, { recursive: true });

const { work, ext } = prepareExtension();
const server = await serve(path.join(ext, 'test'), HTTP_PORT, 'test-page.html');
const pageUrl = `http://127.0.0.1:${HTTP_PORT}/test-page.html`;

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(work, 'profile')}`,
    `--load-extension=${ext}`,
    `--disable-extensions-except=${ext}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    `--force-device-scale-factor=${DPR}`,
    '--use-mock-keychain',
    '--password-store=basic',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--window-size=1280,860',
    pageUrl
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] }
);
chrome.stderr.on('data', () => {});

const watchdog = setTimeout(() => {
  console.error('watchdog');
  process.exit(2);
}, 180000);

/** Open a URL in a fresh tab and return a CDP client attached to it. */
async function openTab(url) {
  const created = await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' }
  ).then((r) => r.json());
  const target = await waitForTarget(PORT, (t) => t.id === created.id, url);
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Page.navigate', { url });
  await sleep(1200);
  return client;
}

async function shoot(client, file, { width, height, scheme, clip } = {}) {
  if (scheme) {
    await client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme }]
    });
  }
  if (width) {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: height || 800,
      deviceScaleFactor: DPR,
      mobile: false
    });
  }
  await sleep(500);
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: Boolean(height),
    ...(clip ? { clip: { ...clip, scale: DPR } } : {})
  });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(shot.data, 'base64'));
  console.log('wrote', file);
}

/** One clipped PNG, returned rather than written. */
async function grab(client, clip) {
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png',
    clip: { ...clip, scale: DPR }
  });
  return Buffer.from(shot.data, 'base64');
}

try {
  const worker = await openWorker(PORT);
  // Chrome ships its own component extensions with service workers; match on
  // the file name so this is FullShot's worker and not Hangouts'.
  const extensionId = new URL(
    (await waitForTarget(
      PORT,
      (t) => t.type === 'service_worker' && t.url.includes('background/service-worker.js'),
      'fullshot worker'
    )).url
  ).host;
  console.log('extension id', extensionId);

  const page = await openPage(PORT, pageUrl, 3000);

  /* ---- 1. progress overlay, caught during a real capture ---------------- */

  // The panel sits 16px from the top right corner and is 236px wide. Read the
  // viewport from the page: with a device scale factor the CSS viewport is not
  // the --window-size.
  const viewportWidth = await evaluate(page, 'window.innerWidth');
  const clip = { x: viewportWidth - 268, y: 8, width: 260, height: 104 };

  const captured = await evaluate(worker, "fullshot.startCapture('full')");
  console.log('capture', captured);

  // Racing a live capture for this shot is hopeless: the overlay blanks itself
  // for the instant each tile is taken. Mount the real component instead —
  // same file, same styles, same page — and photograph it standing still.
  await evaluate(
    worker,
    `(async () => {
       const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:${HTTP_PORT}/*' });
       await chrome.scripting.executeScript({
         target: { tabId: tab.id },
         func: () => {
           window.__shotUI = window.__FullShot.progressUI.create({ onCancel() {} });
           window.__shotUI.update(14, 19);
         }
       });
     })()`
  );
  await sleep(500);
  fs.writeFileSync(path.join(OUT, 'progress.png'), await grab(page, clip));
  console.log('wrote progress.png');
  await evaluate(
    worker,
    `(async () => {
       const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:${HTTP_PORT}/*' });
       await chrome.scripting.executeScript({
         target: { tabId: tab.id },
         func: () => { window.__shotUI?.destroy(); delete window.__shotUI; }
       });
     })()`
  );

  /* ---- 2. result page, with annotations --------------------------------- */

  const resultTarget = await waitForTarget(
    PORT,
    (t) => t.url.includes('result/result.html'),
    'result page'
  );
  const result = connect(resultTarget.webSocketDebuggerUrl);
  await result.ready;
  await result.send('Runtime.enable');
  await result.send('Page.enable');

  for (let i = 0; i < 30; i += 1) {
    await sleep(300);
    const ready = await evaluate(result, `document.getElementById('preview').width > 1`).catch(
      () => false
    );
    if (ready) break;
  }

  await evaluate(
    result,
    `(() => {
       const c = document.getElementById('preview');
       const r = c.getBoundingClientRect();
       const drag = (x1, y1, x2, y2) => {
         const at = (type, x, y) =>
           c.dispatchEvent(new PointerEvent(type, {
             clientX: r.left + x, clientY: r.top + y, button: 0,
             buttons: type === 'pointerup' ? 0 : 1, bubbles: true, pointerId: 1
           }));
         at('pointerdown', x1, y1); at('pointermove', x2, y2); at('pointerup', x2, y2);
       };
       document.querySelector('.tool[data-tool="rect"]').click();
       drag(150, 190, 470, 300);
       document.querySelector('.swatch[data-color="#3b82f6"]').click();
       document.querySelector('.tool[data-tool="arrow"]').click();
       drag(560, 120, 420, 235);
       document.getElementById('client-footer').checked = true;
       document.getElementById('client-footer').dispatchEvent(new Event('change'));
     })()`
  );
  await sleep(600);
  await shoot(result, 'result.png', { width: 1280, height: 780, scheme: 'light' });

  /* ---- 3. popup, light and dark ----------------------------------------- */

  const popup = await openTab(`chrome-extension://${extensionId}/popup/popup.html`);
  // Opened as a standalone tab, the popup's own tab is the active one, so its
  // chrome.tabs query correctly reports "no capturable page". Put it back into
  // the state it has when opened from the toolbar on a real site.
  await evaluate(
    popup,
    `(() => {
       document.getElementById('page-host').textContent = 'example.com';
       const button = document.getElementById('capture');
       button.disabled = false;
       const status = document.getElementById('status');
       status.textContent = '';
       delete status.dataset.tone;
     })()`
  );
  const popupHeight = await evaluate(popup, 'document.body.scrollHeight');
  await shoot(popup, 'popup.png', { width: 288, height: popupHeight, scheme: 'light' });
  await shoot(popup, 'popup-dark.png', { width: 288, height: popupHeight, scheme: 'dark' });

  /* ---- 4. settings ------------------------------------------------------ */

  const settings = await openTab(`chrome-extension://${extensionId}/settings/settings.html`);
  const settingsHeight = await evaluate(settings, 'document.body.scrollHeight');
  await shoot(settings, 'settings.png', {
    width: 900,
    height: Math.min(settingsHeight + 40, 1400),
    scheme: 'light'
  });

  worker.close();
  page.close();
  result.close();
  popup.close();
  settings.close();
} catch (error) {
  console.error('ERROR:', error.message, error.stack?.split('\n')[1] || '');
} finally {
  clearTimeout(watchdog);
  chrome.kill();
  server.close();
  await sleep(300);
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {}
}
