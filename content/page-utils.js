/**
 * FullShot — page geometry helpers.
 *
 * Content scripts cannot use ES modules, so every file hangs its exports off a
 * single namespace and guards against double injection (the worker re-injects
 * on every capture).
 */
(() => {
  const FS = (window.__FullShot = window.__FullShot || {});
  if (FS.utils) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Resolve after the browser has actually painted.
   *
   * The timeout is not belt-and-braces: requestAnimationFrame stops firing
   * entirely while a window is occluded or minimised, and without a fallback
   * the capture loop would wait forever the moment the user switches app.
   */
  const nextFrame = () =>
    new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 250);
    });

  /**
   * Find the element that really scrolls.
   *
   * Most pages scroll the document, but full-height app shells (and plenty of
   * Elementor / one-page templates) put `overflow: auto` on an inner wrapper.
   * Capturing those with window.scrollTo silently produces one duplicated tile,
   * so detect the tallest scrollable container instead.
   */
  function findScroller() {
    const doc = document.scrollingElement || document.documentElement;
    if (doc.scrollHeight > doc.clientHeight + 4) return doc;

    let best = null;
    let bestOverflow = 0;
    const candidates = document.querySelectorAll('body *');
    // A page can have thousands of nodes; only the first few hundred blocks are
    // plausible scroll roots, and scanning them all would stall the capture.
    const max = Math.min(candidates.length, 400);
    for (let i = 0; i < max; i += 1) {
      const element = candidates[i];
      const overflow = element.scrollHeight - element.clientHeight;
      if (overflow < 200 || element.clientHeight < window.innerHeight * 0.5) continue;
      const style = getComputedStyle(element);
      if (!/(auto|scroll|overlay)/.test(style.overflowY)) continue;
      if (overflow > bestOverflow) {
        bestOverflow = overflow;
        best = element;
      }
    }
    return best || doc;
  }

  /** Everything the capture algorithm needs to know about the page right now. */
  function metrics(scroller) {
    const element = scroller || findScroller();
    const isDocument = element === (document.scrollingElement || document.documentElement);

    // clientWidth/Height exclude the scrollbars; innerWidth/Height do not.
    // The screenshot covers innerWidth/Height, so we keep both: one to place
    // pixels, the other to crop the scrollbar gutters away.
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const contentWidth = isDocument
      ? document.documentElement.clientWidth
      : element.clientWidth;
    const contentHeight = isDocument
      ? document.documentElement.clientHeight
      : element.clientHeight;

    const totalHeight = isDocument
      ? Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement.scrollHeight,
          document.body ? document.body.offsetHeight : 0,
          document.documentElement.offsetHeight
        )
      : element.scrollHeight;

    return {
      isDocument,
      viewportWidth,
      viewportHeight,
      contentWidth,
      contentHeight,
      totalHeight,
      scrollTop: isDocument ? window.scrollY : element.scrollTop,
      scrollLeft: isDocument ? window.scrollX : element.scrollLeft,
      maxScroll: Math.max(0, totalHeight - contentHeight),
      dpr: window.devicePixelRatio || 1
    };
  }

  /**
   * Jump the scroll, never animate it.
   *
   * `behavior: 'instant'` is not optional politeness: plenty of sites set
   * `scroll-behavior: smooth` on <html> (MDN and most documentation themes do),
   * and CSS wins over both `behavior: 'auto'` and a plain `scrollTop = n`. Every
   * tile would then be captured part-way through an animation.
   */
  function scrollTo(scroller, top, left = 0) {
    const isDocument = scroller === (document.scrollingElement || document.documentElement);
    if (isDocument) {
      window.scrollTo({ top, left, behavior: 'instant' });
    } else {
      scroller.scrollTo({ top, left, behavior: 'instant' });
    }
  }

  /**
   * Wait until the page is visually settled after a scroll.
   * Two animation frames cover layout + paint; the configurable delay covers
   * lazy images and IntersectionObserver-driven sections. Deliberately short —
   * long sleeps are the main reason competing tools feel slow.
   */
  async function settle(delayMs) {
    await nextFrame();
    if (delayMs > 0) await sleep(delayMs);
    await nextFrame();
  }

  /**
   * Nudge lazy-loading images inside the current viewport into eagerly loading
   * and wait briefly for the ones already decoding.
   */
  async function primeLazyMedia(timeoutMs = 400) {
    const pending = [];
    for (const img of document.images) {
      const rect = img.getBoundingClientRect();
      if (rect.bottom < -200 || rect.top > window.innerHeight + 200) continue;
      if (img.loading === 'lazy') img.loading = 'eager';
      if (!img.complete && img.src) {
        pending.push(
          img.decode().catch(() => {})
        );
      }
    }
    if (!pending.length) return;
    await Promise.race([Promise.all(pending), sleep(timeoutMs)]);
  }

  FS.utils = { sleep, nextFrame, findScroller, metrics, scrollTo, settle, primeLazyMedia };
})();
