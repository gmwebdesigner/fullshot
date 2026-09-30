/**
 * Shared plumbing for the end-to-end tests: launch Chrome with the unpacked
 * extension, talk to it over the DevTools protocol, serve the test pages.
 *
 * Nothing here knows anything about capturing — that lives in the tests.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const EXT_SRC = path.dirname(TEST_DIR);

// Branded Google Chrome has refused --load-extension since v137, so the suites
// need Chrome for Testing:
//   npx @puppeteer/browsers install chrome@stable --path ~/.cache/fullshot-chrome
// Override the binary with CHROME=/path/to/chrome.
const INSTALL_ROOTS = [path.join(os.homedir(), '.cache/fullshot-chrome'), '/tmp/cft'];

/** Locate the installed binary without hard-coding a version number. */
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const root of INSTALL_ROOTS) {
    const builds = path.join(root, 'chrome');
    let versions = [];
    try {
      versions = fs.readdirSync(builds).sort().reverse();
    } catch {
      continue; // this root is not installed
    }
    for (const version of versions) {
      const candidates = [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-linux64/chrome'
      ].map((tail) => path.join(builds, version, tail));
      const found = candidates.find((file) => fs.existsSync(file));
      if (found) return found;
    }
  }
  return path.join(INSTALL_ROOTS[0], 'chrome');
}

export const CHROME = findChrome();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function requireChrome() {
  if (fs.existsSync(CHROME)) return;
  console.error(
    `Chrome for Testing not found under:\n  ${INSTALL_ROOTS.join('\n  ')}\n` +
      'Install it with: npx @puppeteer/browsers install chrome@stable ' +
      '--path ~/.cache/fullshot-chrome'
  );
  process.exit(1);
}

/**
 * Copy the extension to a scratch directory and patch it for testing only —
 * the working copy is never touched.
 *
 *  - `<all_urls>`: the shipped manifest relies on activeTab, which needs a real
 *    user gesture, and driving the worker over CDP has none.
 *  - `DEBUG = true`: exposes `globalThis.fullshot` in the worker, the only way
 *    into a module service worker (dynamic import() is banned inside one).
 */
export function prepareExtension() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fullshot-e2e-'));
  const ext = path.join(work, 'ext');
  fs.cpSync(EXT_SRC, ext, { recursive: true });

  const manifestPath = path.join(ext, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const constants = path.join(ext, 'shared/constants.js');
  fs.writeFileSync(
    constants,
    fs
      .readFileSync(constants, 'utf8')
      .replace('export const DEBUG = false;', 'export const DEBUG = true;')
  );

  return { work, ext };
}

/** Static server for the test pages. file:// needs an opt-in we cannot toggle. */
export async function serve(dir, port, indexFile) {
  const server = http.createServer((request, response) => {
    const name = request.url.split('?')[0];
    const file = path.join(dir, path.basename(name === '/' ? `/${indexFile}` : name));
    try {
      const body = fs.readFileSync(file);
      response.writeHead(200, {
        'content-type': name.endsWith('.js') ? 'text/javascript' : 'text/html'
      });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

export function launchChrome({ ext, profile, port, url, windowSize = '900,700' }) {
  const chrome = spawn(
    CHROME,
    [
      ...(process.env.HEADED ? [] : ['--headless=new']),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--load-extension=${ext}`,
      `--disable-extensions-except=${ext}`,
      // Without these the compositor stops painting an occluded headless window
      // and captureVisibleTab hands back stale frames.
      '--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--force-device-scale-factor=1',
      '--use-mock-keychain',
      '--password-store=basic',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${windowSize}`,
      url
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  chrome.stderr.on('data', () => {}); // Chrome is noisy about keychains and GCM
  return chrome;
}

export async function listTargets(port) {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

export async function waitForTarget(port, predicate, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const found = (await listTargets(port)).find(predicate);
      if (found) return found;
    } catch {
      /* the devtools endpoint is not up yet */
    }
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Minimal CDP client over the native WebSocket. */
export function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const resolver = pending.get(message.id);
    if (!resolver) return;
    pending.delete(message.id);
    if (message.error) resolver.reject(new Error(JSON.stringify(message.error)));
    else resolver.resolve(message.result);
  });
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => socket.close()
  };
}

export async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails)
    );
  }
  return result.result.value;
}

/**
 * Attach to a page target and navigate it explicitly: the target usually
 * already exists as about:blank, and its default execution context would be
 * the stale one.
 */
export async function openPage(port, port80Url, minHeight = 3000) {
  const target = await waitForTarget(
    port,
    (t) => t.url.startsWith(port80Url.slice(0, port80Url.lastIndexOf('/'))),
    'test page'
  );
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Page.navigate', { url: port80Url });
  for (let i = 0; i < 60; i += 1) {
    await sleep(300);
    const state = await evaluate(
      client,
      `document.readyState + '|' + document.documentElement.scrollHeight`
    ).catch(() => '');
    if (String(state).startsWith('complete') && Number(String(state).split('|')[1]) > minHeight) {
      break;
    }
  }
  return client;
}

/** Attach to the extension's service worker. */
export async function openWorker(port) {
  const target = await waitForTarget(
    port,
    (t) => t.type === 'service_worker' && t.url.includes('service-worker.js'),
    'extension service worker'
  );
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');
  return client;
}

/** Read one capture record out of the extension's IndexedDB, inside the worker. */
export const readCapture = (id, body) => `(async () => {
  const db = await new Promise((res) => {
    const r = indexedDB.open('fullshot', 1);
    r.onsuccess = () => res(r.result);
  });
  const rec = await new Promise((res) => {
    const r = db.transaction('captures').objectStore('captures').get(${JSON.stringify(id)});
    r.onsuccess = () => res(r.result);
  });
  ${body}
})()`;

export function reporter() {
  const failures = [];
  return {
    failures,
    check(label, ok, detail = '') {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
      if (!ok) failures.push(label);
    },
    finish() {
      console.log(
        failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nALL CHECKS PASSED'
      );
      process.exit(failures.length ? 1 : 0);
    }
  };
}

/**
 * The export checks write real files through chrome.downloads. Copy them
 * somewhere inspectable, then take them out of the download folder.
 */
export function cleanDownloads(keepIn = null) {
  try {
    const downloads = path.join(os.homedir(), 'Downloads');
    for (const name of fs.readdirSync(downloads)) {
      if (/^fullshot-127-0-0-1-.*\.(jpg|png|pdf)$/.test(name)) {
        const file = path.join(downloads, name);
        if (keepIn) {
          fs.mkdirSync(keepIn, { recursive: true });
          fs.copyFileSync(file, path.join(keepIn, name));
        }
        fs.rmSync(file, { force: true });
      }
    }
  } catch {
    /* nothing to clean */
  }
}
