/**
 * FullShot — service worker.
 *
 * Role: dumb, fast compositor + orchestrator.
 *   - validates the tab and injects the content scripts
 *   - captures the visible viewport on demand
 *   - draws each tile onto one OffscreenCanvas (never keeps a list of images)
 *   - stores the finished Blob in IndexedDB and opens the result page
 *
 * The *content script* owns all page geometry: it scrolls, measures, decides
 * the crop of every tile and tells the worker exactly where to paint it.
 * Keeping the brain in one place is what makes the overlap maths trivial.
 */

import { MSG, MODE, LIMITS, DEBUG } from '../shared/constants.js';
import { getSettings } from '../shared/storage.js';
import { putCapture, pruneCaptures } from '../shared/db.js';
import { log, sleep, tabBlockReason, clampCanvasHeight } from '../shared/utils.js';

/** Live capture sessions, keyed by tab id. Only one per tab. */
const sessions = new Map();

const CONTENT_FILES = [
  'content/page-utils.js',
  'content/fixed-elements.js',
  'content/progress-ui.js',
  'content/select-area.js',
  'content/capture.js'
];

/* -------------------------------------------------------------------------- */
/* Session lifecycle                                                          */
/* -------------------------------------------------------------------------- */

function createSession(tab, mode) {
  const session = {
    tabId: tab.id,
    windowId: tab.windowId,
    mode,
    url: tab.url,
    title: tab.title,
    canvas: null,
    ctx: null,
    scaleX: 1,
    scaleY: 1,
    tiles: 0,
    startedAt: Date.now(),
    clamped: false
  };
  sessions.set(tab.id, session);
  return session;
}

/** Release every heavy reference held by a session. */
function disposeSession(tabId) {
  const session = sessions.get(tabId);
  if (!session) return;
  if (session.canvas) {
    // Zero-sizing frees the backing store immediately instead of waiting for GC.
    session.canvas.width = 1;
    session.canvas.height = 1;
  }
  session.canvas = null;
  session.ctx = null;
  sessions.delete(tabId);
}

// The page went away mid-capture: drop the canvas, nothing to restore remotely.
chrome.tabs.onRemoved.addListener((tabId) => disposeSession(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Navigating away takes the content script with it; the canvas is orphaned.
  if (changeInfo.status === 'loading') disposeSession(tabId);
});

// A capture only ever outlives the browser session as dead weight in IndexedDB.
chrome.runtime.onStartup.addListener(() => pruneCaptures(0).catch(() => {}));

/* -------------------------------------------------------------------------- */
/* Capture primitives                                                         */
/* -------------------------------------------------------------------------- */

/**
 * chrome.tabs.captureVisibleTab is rate limited (roughly two calls per second).
 * Exceeding it rejects instead of queueing, so back off and retry.
 */
async function captureVisible(windowId) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(message)) throw error;
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastError;
}

async function dataUrlToBitmap(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

/**
 * captureVisibleTab photographs whichever tab is active in the window — not
 * the tab that asked. If the user switches tab mid-capture, the remaining
 * tiles would be pixels from a page FullShot was never granted access to, and
 * they would be stitched into the image without a trace. Refuse instead.
 *
 * Switching to another *window* is fine: our tab is still the active one in
 * its own window, which is what captureVisibleTab reads.
 */
async function assertStillFrontmost(session) {
  const tab = await chrome.tabs.get(session.tabId).catch(() => null);
  if (!tab || !tab.active || tab.windowId !== session.windowId) {
    throw new Error(
      'The tab stopped being the active one, so the capture was stopped. ' +
        'Leave the tab in front while FullShot works.'
    );
  }
}

/**
 * Paint one tile.
 *
 * @param session          live session
 * @param payload.viewport {w,h} CSS size of the visible viewport (innerWidth/innerHeight)
 * @param payload.canvas   {w,h} CSS size of the final image — read on the first tile only
 * @param payload.frame    {x,y,w,h} CSS rect *inside the viewport* to copy
 * @param payload.dest     {x,y} CSS position inside the final image
 */
async function paintTile(session, payload) {
  const { viewport, canvas: canvasSize, frame, dest } = payload;

  await assertStillFrontmost(session);
  const dataUrl = await captureVisible(session.windowId);
  const bitmap = await dataUrlToBitmap(dataUrl);

  try {
    if (!session.canvas) {
      // Derive the CSS→device scale from the real screenshot instead of trusting
      // devicePixelRatio: this stays correct under browser zoom, on Retina, on
      // Windows display scaling and when Chrome rounds the capture size.
      session.scaleX = bitmap.width / viewport.w;
      session.scaleY = bitmap.height / viewport.h;

      const width = Math.max(1, Math.round(canvasSize.w * session.scaleX));
      const rawHeight = Math.max(1, Math.round(canvasSize.h * session.scaleY));
      const { height, clamped } = clampCanvasHeight(width, rawHeight);
      session.clamped = clamped;

      try {
        session.canvas = new OffscreenCanvas(width, height);
        session.ctx = session.canvas.getContext('2d', { alpha: false });
        if (!session.ctx) throw new Error('no 2d context');
      } catch (error) {
        throw new Error(
          'This page is too large to fit in a single image. Try capturing a shorter section.'
        );
      }
      // White base: JPG has no alpha and transparent page backgrounds would
      // otherwise turn black.
      session.ctx.fillStyle = '#ffffff';
      session.ctx.fillRect(0, 0, width, height);
      log('canvas', width, 'x', height, 'scale', session.scaleX, session.scaleY);
    }

    const sx = Math.round(frame.x * session.scaleX);
    const sy = Math.round(frame.y * session.scaleY);
    let sw = Math.round(frame.w * session.scaleX);
    let sh = Math.round(frame.h * session.scaleY);
    const dx = Math.round(dest.x * session.scaleX);
    const dy = Math.round(dest.y * session.scaleY);

    // Never read outside the screenshot or write outside the canvas.
    sw = Math.min(sw, bitmap.width - sx, session.canvas.width - dx);
    sh = Math.min(sh, bitmap.height - sy, session.canvas.height - dy);

    if (sw > 0 && sh > 0) {
      session.ctx.drawImage(bitmap, sx, sy, sw, sh, dx, dy, sw, sh);
    }
    session.tiles += 1;

    return {
      ok: true,
      painted: sh / session.scaleY,
      // Tell the page to stop early when the canvas had to be clamped.
      full: !session.clamped,
      maxCssHeight: session.canvas.height / session.scaleY
    };
  } finally {
    bitmap.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Finalisation                                                               */
/* -------------------------------------------------------------------------- */

async function finishCapture(session, meta) {
  if (!session.canvas) throw new Error('Nothing was captured.');

  const blob = await session.canvas.convertToBlob({ type: 'image/png' });
  const id = `cap_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  await putCapture({
    id,
    createdAt: Date.now(),
    blob,
    width: session.canvas.width,
    height: session.canvas.height,
    scale: session.scaleY,
    tiles: session.tiles,
    durationMs: Date.now() - session.startedAt,
    clamped: session.clamped,
    mode: session.mode,
    url: session.url,
    title: session.title,
    viewport: meta?.viewport || null,
    truncatedReason: meta?.truncatedReason || null
  });

  // Old captures are dead weight the moment their tab is closed.
  pruneCaptures(30 * 60 * 1000, id).catch(() => {});

  disposeSession(session.tabId);
  await chrome.tabs.create({ url: chrome.runtime.getURL(`result/result.html?id=${id}`) });
  return { ok: true, id };
}

/* -------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* -------------------------------------------------------------------------- */

async function ensureContentScripts(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: CONTENT_FILES
    });
  } catch (error) {
    throw new Error(
      "This page can't be captured because Chrome doesn't allow extensions to run on it."
    );
  }
}

/**
 * With DEBUG on, the entry point is reachable from the worker console and from
 * the end-to-end harness (`fullshot.startCapture('full')`). Service workers
 * cannot use dynamic import(), so this is the only way in.
 */
export async function startCapture(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const reason = tabBlockReason(tab);
  if (reason) throw new Error(reason);

  // Local files work, but only once the user ticks the box themselves.
  const url = tab.url || tab.pendingUrl || '';
  if (url.startsWith('file:') && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    throw new Error(
      'To capture local files, enable "Allow access to file URLs" for FullShot in chrome://extensions.'
    );
  }

  if (sessions.has(tab.id)) {
    throw new Error('A capture is already running in this tab.');
  }

  const settings = await getSettings();
  await ensureContentScripts(tab.id);

  const session = createSession(tab, mode);
  try {
    // The page drives the whole run, so this await lasts as long as the
    // capture does. It still needs a ceiling: a content script that dies
    // between "I'll answer later" and answering leaves this pending forever,
    // and the session would block every future capture of that tab.
    const result = await Promise.race([
      chrome.tabs.sendMessage(tab.id, {
        type: MSG.CAPTURE_BEGIN,
        mode,
        settings,
        limits: LIMITS,
        debug: DEBUG
      }),
      sleep(LIMITS.MAX_CAPTURE_DURATION + 30000).then(() => {
        throw new Error('The page stopped responding during the capture.');
      })
    ]);
    if (!result) throw new Error('The page stopped responding during the capture.');
    if (result.error) throw new Error(result.error);
    return result;
  } finally {
    // finishCapture already disposed on success; this covers cancel and errors.
    disposeSession(tab.id);
  }
}

if (DEBUG) globalThis.fullshot = { startCapture, sessions };

/* -------------------------------------------------------------------------- */
/* Messaging                                                                  */
/* -------------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case MSG.CAPTURE_START: {
          // Only the popup, the options page or a keyboard command may start a
          // capture. A content script has a `sender.tab`, and must never be
          // able to make the extension photograph whatever tab is in front.
          if (sender.tab) throw new Error('Unknown message.');
          const mode = Object.values(MODE).includes(message.mode) ? message.mode : MODE.FULL;
          sendResponse(await startCapture(mode));
          break;
        }

        case MSG.CAPTURE_TILE: {
          const session = sessions.get(sender.tab?.id);
          if (!session) throw new Error('The capture was interrupted.');
          if (Date.now() - session.startedAt > LIMITS.MAX_CAPTURE_DURATION) {
            throw new Error('The capture took too long and was stopped.');
          }
          sendResponse(await paintTile(session, message));
          break;
        }

        case MSG.CAPTURE_FINISH: {
          const session = sessions.get(sender.tab?.id);
          if (!session) throw new Error('The capture was interrupted.');
          sendResponse(await finishCapture(session, message));
          break;
        }

        case MSG.CAPTURE_CANCEL: {
          disposeSession(sender.tab?.id);
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'Unknown message.' });
      }
    } catch (error) {
      log('error', error);
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();
  return true; // keep the channel open for the async work above
});

chrome.commands.onCommand.addListener(async (command) => {
  const mode = command === 'capture-visible' ? MODE.VISIBLE : MODE.FULL;
  try {
    await startCapture(mode);
  } catch (error) {
    log('command failed', error);
    // No popup is open on a keyboard shortcut, so surface it on the badge.
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
  }
});
