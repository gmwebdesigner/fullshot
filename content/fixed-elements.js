/**
 * FullShot — fixed / sticky element handling.
 *
 * Why this exists: a sticky header, a cookie bar or a floating chat bubble sits
 * still while the page scrolls under it, so it lands in *every* tile and the
 * stitched image shows it a dozen times.
 *
 * Strategy: capture the first tile with the page untouched (so the header is
 * shown exactly once, where it belongs), then neutralise those elements for the
 * remaining tiles and restore the original inline styles afterwards — always,
 * including on error or cancel.
 */
(() => {
  const FS = (window.__FullShot = window.__FullShot || {});
  if (FS.fixedElements) return;

  const MARKER = 'data-fullshot-ignore';

  /**
   * A fixed element that covers nearly the whole viewport is a background
   * layer, not a floating widget. Hiding it would leave white bands, and
   * repeating it per tile actually looks correct, so leave it alone.
   */
  function isBackdrop(rect, view) {
    return rect.width >= view.innerWidth * 0.85 && rect.height >= view.innerHeight * 0.85;
  }

  /**
   * Every DOM root worth scanning: the document, plus open shadow roots, plus
   * same-origin iframe documents.
   *
   * This matters more than it sounds. Third-party widgets — accessibility
   * toolbars, chat bubbles, consent bars — are routinely rendered inside a
   * shadow root so the host site's CSS cannot reach them, and
   * `querySelectorAll` does not cross that boundary. Elementor's own
   * accessibility button (`div.ea11y-widget`) is exactly this: a
   * `position: fixed` button in an open shadow root, which repeats in every
   * single section unless it is followed in there.
   *
   * Closed shadow roots and cross-origin iframes stay out of reach by design;
   * nothing can be done about those from an extension content script.
   */
  function* eachRoot(root, depth = 0) {
    if (depth > 4) return; // widgets nest a level or two, never more
    yield root;
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot && !element.hasAttribute(MARKER)) {
        yield* eachRoot(element.shadowRoot, depth + 1);
      }
      if (element.tagName === 'IFRAME') {
        let doc = null;
        try {
          doc = element.contentDocument;
        } catch {
          // cross-origin: not reachable, and not our business
        }
        if (doc) yield* eachRoot(doc, depth + 1);
      }
    }
  }

  function collect() {
    const entries = [];
    for (const root of eachRoot(document)) {
      for (const element of root.querySelectorAll('*')) {
        const tag = element.tagName;
        // Never touch the page's own root boxes: hiding those hides everything.
        if (tag === 'HTML' || tag === 'HEAD' || tag === 'BODY' || tag === 'SCRIPT') continue;
        if (element.hasAttribute(MARKER) || element.closest(`[${MARKER}]`)) continue;

        const style = getComputedStyle(element);
        const position = style.position;
        if (position !== 'fixed' && position !== 'sticky') continue;
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        const rect = element.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        const view = element.ownerDocument?.defaultView || window;
        if (position === 'fixed' && isBackdrop(rect, view)) continue;

        entries.push({
          element,
          position,
          // Restoring the whole cssText is the only way to be byte-exact: the
          // page may have set the very properties we are about to override.
          originalCssText: element.style.cssText,
          hadStyleAttribute: element.hasAttribute('style')
        });
      }
    }
    return entries;
  }

  /**
   * Neutralise the collected elements.
   *  - fixed  → hidden (it was already captured in the first tile)
   *  - sticky → static, so it scrolls away with its own section instead of
   *             following the viewport
   * `visibility` keeps the layout intact; `display: none` would reflow the page
   * and invalidate every measurement taken so far.
   */
  function neutralise(entries) {
    for (const entry of entries) {
      if (entry.position === 'fixed') {
        entry.element.style.setProperty('visibility', 'hidden', 'important');
      } else {
        entry.element.style.setProperty('position', 'static', 'important');
      }
    }
  }

  function restore(entries) {
    if (!entries) return;
    for (const entry of entries) {
      try {
        if (entry.hadStyleAttribute) {
          entry.element.style.cssText = entry.originalCssText;
        } else {
          entry.element.removeAttribute('style');
        }
      } catch {
        // The node may have been removed by the page in the meantime.
      }
    }
  }

  FS.fixedElements = { collect, neutralise, restore, MARKER };
})();
