/**
 * Rasterise assets/icons/icon.svg into the PNG sizes the manifest declares.
 *
 *   node test/icons.mjs
 *
 * Chrome does the rasterising, so the antialiasing is the same engine that will
 * display the result. Also prints a contact sheet to /tmp so the small end can
 * be eyeballed — 16px is where icons actually live.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  CHROME, EXT_SRC, sleep, requireChrome, waitForTarget, connect, evaluate
} from './harness.mjs';

const SIZES = [16, 32, 48, 128];
const ICON_DIR = path.join(EXT_SRC, 'assets/icons');
const PORT = 9930;

requireChrome();

const source = fs.readFileSync(path.join(ICON_DIR, 'icon.svg'), 'utf8');
const profile = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'fullshot-icons-'));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--use-mock-keychain',
    '--password-store=basic',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=1',
    'about:blank'
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] }
);
chrome.stderr.on('data', () => {});

try {
  const target = await waitForTarget(PORT, (t) => t.type === 'page', 'page');
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');
  await sleep(400);

  const rendered = await evaluate(
    client,
    `(async () => {
      const markup = ${JSON.stringify(source)};
      const sizes = ${JSON.stringify(SIZES)};
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
      });

      const draw = (size) => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        canvas.getContext('2d').drawImage(img, 0, 0, size, size);
        return canvas;
      };

      const out = {};
      for (const size of sizes) out[size] = draw(size).toDataURL('image/png');

      // Contact sheet: real sizes on both a light and a dark toolbar, plus the
      // 16px blown up so its pixels can be judged.
      const sheet = document.createElement('canvas');
      sheet.width = 520;
      sheet.height = 200;
      const ctx = sheet.getContext('2d');
      ctx.fillStyle = '#f4f4f5';
      ctx.fillRect(0, 0, 520, 100);
      ctx.fillStyle = '#101012';
      ctx.fillRect(0, 100, 520, 100);
      ctx.imageSmoothingEnabled = false;

      for (const band of [0, 100]) {
        let x = 20;
        for (const size of sizes) {
          ctx.drawImage(img, x, band + (84 - size) / 2 + 8, size, size);
          x += size + 24;
        }
        ctx.drawImage(draw(16), 360, band + 10, 80, 80);
      }
      return { out, sheet: sheet.toDataURL('image/png') };
    })()`
  );

  for (const [size, data] of Object.entries(rendered.out)) {
    const file = path.join(ICON_DIR, `icon-${size}.png`);
    fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
    console.log('wrote', path.relative(EXT_SRC, file));
  }
  fs.writeFileSync('/tmp/fullshot-icons.png', Buffer.from(rendered.sheet.split(',')[1], 'base64'));
  console.log('contact sheet: /tmp/fullshot-icons.png');
  client.close();
} catch (error) {
  console.error('ERROR:', error.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  await sleep(300);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* Chrome may still be releasing the profile */
  }
}
