# Changelog

What changed in each version of FullShot, newest first. The version number is
the one in `manifest.json`, which is what `chrome://extensions` shows.

## 1.1.0 — 2026-10-12

### Added

- **WebP export.** A fourth format next to PNG, JPG and PDF, in the result page
  and in Settings, with the same quality steps as JPG. Files come out at
  roughly half the size of the equivalent JPG.

### Fixed

- **Headers that turn fixed only after scrolling no longer repeat.** Google's
  results bar and any "shrink on scroll" navbar are not fixed when the capture
  starts, so they were missed and showed up again further down the image. The
  page is now re-checked at every scroll stop.
- **Switching tab during a capture stops it.** Chrome photographs whichever tab
  is in front, so the rest of the image used to be stitched from the other
  tab. The capture now stops with a plain message instead.
- **An expired capture shows its message** rather than a blank result page.
- **A page is no longer locked out of later captures** after one that failed
  while starting.
- **Pages with `.pdf` in their query string can be captured.** Only the path
  is checked now, so `page.html?file=x.pdf` is no longer refused.
- **Accented page titles are correct in exported PDFs.**

### Changed

- The *JPG quality* setting is now *Quality*: it drives JPG, WebP and PDF.
  Saved settings carry over untouched.
- A WebP export larger than 16 383 px on a side is refused with a message,
  because Chrome would otherwise squash the image to fit without saying so.
  Use PNG or JPG for those captures.
- A capture can only be started from the popup, the settings page or the
  keyboard shortcut, never by a web page.
- Settings read back from storage are validated before use.

## 1.0.0 — 2026-08-12

First version.

- Full page, visible area and selected area capture.
- Fixed and sticky elements captured once, including those inside open shadow
  roots and same-origin iframes.
- Annotation: arrow, box, blur and text, with undo.
- Export to PNG, JPG and PDF (single page or A4), copy to clipboard, and
  *Copy for client* with URL, date and viewport.
- Settings, dark mode, and the `⌘⇧Y` / `Ctrl+Shift+Y` shortcut.
