/**
 * FullShot — capture driver (runs in the page).
 *
 * This file owns the algorithm. The service worker only screenshots the
 * viewport and paints the rect it is told to paint.
 *
 * The core idea is a single cumulative cursor, `paintedTo`, expressed in CSS
 * pixels from the top of the document:
 *
 *   scroll to `paintedTo` → read the scroll position the browser *actually*
 *   reached → crop away whatever was already painted → paint the rest.
 *
 * That one rule replaces every special case people usually hand-write:
 *   - the last viewport (the browser clamps the scroll, the crop absorbs it,
 *     so the tail is never duplicated),
 *   - short pages, pages shorter than one viewport,
 *   - pages that grow while scrolling (the canvas is fixed at the height the
 *     page had when the capture started),
 *   - scroll anchoring or smooth-scroll overshoot.
 */
(() => {
  const FS = (window.__FullShot = window.__FullShot || {});
  if (FS.captureBound) return;
  FS.captureBound = true;

  // Mirrors shared/constants.js — content scripts cannot import ES modules.
  const MSG = {
    CAPTURE_BEGIN: 'CAPTURE_BEGIN',
    CAPTURE_TILE: 'CAPTURE_TILE',
    CAPTURE_FINISH: 'CAPTURE_FINISH',
    CAPTURE_CANCEL: 'CAPTURE_CANCEL'
  };

  const DELAY_PRESETS = { fast: 120, normal: 250, safe: 550 };

  // Mirrors DEBUG in shared/constants.js: the worker sends its value with every
  // capture, so the flag lives in exactly one place.
  let debugEnabled = false;
  const debug = (...args) => {
    if (debugEnabled) console.log('[FullShot/page]', ...args);
  };

  /** Milliseconds to wait for the worker before giving up on a step. */
  const STEP_TIMEOUT = 30000;

  /** Send to the worker and turn its `{ok:false,error}` shape into a throw. */
  async function ask(message) {
    let response;
    try {
      response = await Promise.race([
        chrome.runtime.sendMessage(message),
        // If the worker is torn down mid-call the promise above never settles,
        // and the whole capture would hang with the overlay stuck on screen.
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('The extension stopped responding.')), STEP_TIMEOUT)
        )
      ]);
    } catch (error) {
      if (error?.message === 'The extension stopped responding.') throw error;
      throw new Error('FullShot lost contact with the extension. Please try again.');
    }
    if (!response) throw new Error('The capture was interrupted.');
    if (response.ok === false) throw new Error(response.error || 'The capture failed.');
    return response;
  }

  /* ---------------------------------------------------------------------- */

  async function run({ mode, settings, limits, debug: debugFlag }) {
    if (FS.running) return { error: 'A capture is already running on this page.' };
    FS.running = true;
    debugEnabled = Boolean(debugFlag);

    const { utils, fixedElements, progressUI, selectArea } = FS;
    const scroller = utils.findScroller();
    const start = utils.metrics(scroller);
    const originalScroll = { top: start.scrollTop, left: start.scrollLeft };
    const delay = DELAY_PRESETS[settings.delay] ?? DELAY_PRESETS.normal;

    let ui = null;
    let fixedEntries = null;
    let cancelled = false;
    FS.cancel = () => {
      cancelled = true;
      ui?.setTitle('Cancelling…');
    };

    const viewport = { w: start.viewportWidth, h: start.viewportHeight };
    const meta = {
      viewport: {
        w: start.contentWidth,
        h: start.contentHeight,
        dpr: start.dpr
      }
    };

    try {
      /* ---- Visible area: one tile, nothing to scroll or hide ------------- */
      if (mode === 'visible') {
        await ask({
          type: MSG.CAPTURE_TILE,
          viewport,
          canvas: { w: start.contentWidth, h: start.contentHeight },
          frame: { x: 0, y: 0, w: start.contentWidth, h: start.contentHeight },
          dest: { x: 0, y: 0 }
        });
        return await ask({ type: MSG.CAPTURE_FINISH, ...meta });
      }

      /* ---- Selected area: pick a rect, then one cropped tile ------------- */
      if (mode === 'area') {
        const rect = await selectArea.select();
        if (!rect) {
          await ask({ type: MSG.CAPTURE_CANCEL });
          return { cancelled: true };
        }
        // Let the overlay disappear from the compositor before screenshotting.
        await utils.nextFrame();
        await ask({
          type: MSG.CAPTURE_TILE,
          viewport,
          canvas: { w: rect.w, h: rect.h },
          frame: rect,
          dest: { x: 0, y: 0 }
        });
        return await ask({
          type: MSG.CAPTURE_FINISH,
          ...meta,
          viewport: { ...meta.viewport, selection: { w: Math.round(rect.w), h: Math.round(rect.h) } }
        });
      }

      /* ---- Full page ----------------------------------------------------- */
      ui = progressUI.create({ onCancel: () => FS.cancel() });

      if (settings.hideFixed) fixedEntries = fixedElements.collect();

      utils.scrollTo(scroller, 0);
      await utils.settle(delay);

      // The canvas is sized once, from the height the page has right now.
      // Anything appended later by infinite scroll is out of scope by design —
      // that is also what stops this loop from running forever.
      const canvasHeight = Math.min(
        Math.max(utils.metrics(scroller).totalHeight, start.contentHeight),
        limits.MAX_CAPTURE_HEIGHT
      );
      const contentWidth = start.contentWidth;
      const contentHeight = start.contentHeight;
      const estimatedTiles = Math.max(1, Math.ceil(canvasHeight / contentHeight));

      debug('doc', canvasHeight, 'viewport', contentWidth, contentHeight, 'dpr', start.dpr);

      let paintedTo = 0;
      let index = 0;
      let truncatedReason = null;
      const startedAt = Date.now();

      ui.update(0, estimatedTiles);

      while (paintedTo < canvasHeight - 0.5) {
        if (cancelled) break;
        if (index >= limits.MAX_NUMBER_OF_CAPTURES) {
          truncatedReason = `Stopped after ${limits.MAX_NUMBER_OF_CAPTURES} sections.`;
          break;
        }
        if (Date.now() - startedAt > limits.MAX_CAPTURE_DURATION) {
          truncatedReason = 'Stopped after two minutes — the page kept growing.';
          break;
        }

        utils.scrollTo(scroller, paintedTo);
        await utils.settle(delay);
        if (index === 0) await utils.primeLazyMedia();
        if (cancelled) break;

        // Where the browser actually landed. Near the bottom it clamps the
        // scroll, which is exactly the case that produces duplicated tails in
        // naive tools; `cropTop` absorbs it. `destY` covers the opposite, rarer
        // case of the page overshooting (scroll anchoring).
        const now = utils.metrics(scroller);
        const actualTop = now.scrollTop;
        const cropTop = Math.max(0, paintedTo - actualTop);
        const destY = Math.max(paintedTo, actualTop);
        const height = Math.min(contentHeight - cropTop, canvasHeight - destY);

        if (height <= 0.5) {
          truncatedReason = truncatedReason || 'The page stopped scrolling before the end.';
          break;
        }

        ui.hide();
        await utils.nextFrame(); // make sure the overlay is off-screen when Chrome grabs the frame
        let response;
        try {
          response = await ask({
            type: MSG.CAPTURE_TILE,
            viewport: { w: now.viewportWidth, h: now.viewportHeight },
            canvas: { w: contentWidth, h: canvasHeight },
            frame: { x: 0, y: cropTop, w: contentWidth, h: height },
            dest: { x: 0, y: destY }
          });
        } finally {
          ui.show();
        }

        const painted = response.painted ?? height;
        if (painted <= 0.5) {
          truncatedReason = truncatedReason || 'The page could not be scrolled any further.';
          break;
        }
        paintedTo = destY + painted;
        index += 1;
        ui.update(index, estimatedTiles);
        debug('tile', index, 'scrollTop', actualTop, 'crop', cropTop, 'paintedTo', paintedTo);

        // Only now: the first tile has the sticky header exactly where it
        // belongs, so from here on those elements must stop following us.
        if (index === 1 && fixedEntries) fixedElements.neutralise(fixedEntries);

        // The worker clamped the canvas: everything beyond is unreachable.
        if (response.full === false && paintedTo >= response.maxCssHeight - 0.5) {
          truncatedReason =
            'The page was too tall for a single image and was cut off at the maximum size.';
          break;
        }
      }

      if (cancelled) {
        await ask({ type: MSG.CAPTURE_CANCEL });
        return { cancelled: true };
      }
      if (index === 0) throw new Error('Nothing could be captured on this page.');

      debug('done', index, 'tiles in', Date.now() - startedAt, 'ms');
      ui.setTitle('Building image…');
      return await ask({ type: MSG.CAPTURE_FINISH, ...meta, truncatedReason });
    } catch (error) {
      const message = String(error?.message || error);
      if (ui) {
        ui.error(message);
        // Leave it up briefly so the user sees why nothing happened.
        setTimeout(() => ui.destroy(), 4000);
        ui = null;
      }
      chrome.runtime.sendMessage({ type: MSG.CAPTURE_CANCEL }).catch(() => {});
      return { error: message };
    } finally {
      // Runs on success, on error, on cancel. The page must always be left
      // exactly as it was found.
      FS.fixedElements.restore(fixedEntries);
      FS.utils.scrollTo(scroller, originalScroll.top, originalScroll.left);
      ui?.destroy();
      FS.running = false;
      FS.cancel = null;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== MSG.CAPTURE_BEGIN) return undefined;
    run(message).then(sendResponse);
    return true;
  });
})();
