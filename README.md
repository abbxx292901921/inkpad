# Inkpad

A static, offline-capable Progressive Web App for handwritten notes
(Notability-style), with Gemini AI help. Vanilla HTML/CSS/JS — no build step,
no backend, no dependencies, no tracking.

> Status: step 2 of 11 — pen/highlighter/eraser, colors, widths, undo/redo.

## Run locally

Any static file server works:

```bash
python -m http.server 8000
```

Then open http://localhost:8000 (use `localhost`, not a `file://` URL —
ES modules require http/https).

## Deploy to GitHub Pages

The app is a static folder — no build step, no backend, no dependencies.

1. Push `main` to the repo (the `Deploy to GitHub Pages` workflow publishes it).
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Open the published URL: **https://abbxx292901921.github.io/inkpad/**

The workflow (`.github/workflows/deploy.yml`) publishes the folder as-is minus
`.git` and `.github`. All paths in `index.html` are relative, so the app works
under a subpath like `/inkpad/`.

## Use (step 2)

- Toolbar (top): Pen / Highlighter / Eraser, pen colors (4), stroke widths
  (per-tool), Undo / Redo. The bar is touch-sized (40px targets).
- Eraser deletes whole strokes it touches; everything is undoable.
- Press `D` for the debug overlay; `__inkpad` in the console exposes
  `{ strokes, viewport, surface, history }`.

## Test on an iPad

**Deployed (recommended):** open **https://abbxx292901921.github.io/inkpad/**
in Safari on the iPad. Works over cellular, no laptop needed, and it is the
same URL you can Add to Home Screen once the PWA lands.

**LAN (fastest while developing):** run a static server on the dev machine and
open it from the iPad on the same Wi-Fi:

```bash
python -m http.server 8000
```

Then in iPad Safari, open `http://<your-LAN-IP>:8000`. Find the dev machine's
address with `ipconfig` (Windows) or `ip addr` (macOS/Linux). Pencil, touch and
mouse all work over LAN.

Two caveats while testing over plain HTTP:
- No service worker, so no offline mode and no "Add to Home Screen" install
  prompt yet (the manifest lands in step 5).
- `http://` is not a secure context, so `navigator.storage.persist()` is
  unavailable and Safari's 7-day storage eviction applies to any saved data.

For a full PWA test (install, offline, persistent storage) the app needs to be
served over HTTPS — GitHub Pages already is.

## iPad settings that matter

- **Settings → Apple Pencil → Scribble: Off.** Otherwise Scribble intercepts
  Pencil strokes and page gestures.
- **Settings → Safari → "Prefer Page Rendering Updates near 60fps": Off.**
  Gives 120Hz pointer updates, which is what makes strokes smooth.
