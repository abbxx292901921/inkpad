# Inkpad

A static, offline-capable Progressive Web App for handwritten notes
(Notability-style), with Gemini AI help. Vanilla HTML/CSS/JS — no build step,
no backend, no dependencies, no tracking.

> Status: the Notability-style editor UI is in — floating icon toolbar,
> expandable tool island, colour card, stroke card, shapes, lasso + transform
> box, ruler. Notes persist in IndexedDB, the library screen works, PDFs and
> images import, the app runs offline, and there is an "Ask AI" panel.
> iPad input core done: synchronous drawing, palm rejection, squeeze-to-erase,
> Pencil hover ring.

## Run locally

Any static file server works:

```bash
python -m http.server 8000
```

Then open http://localhost:8000 (use `localhost`, not a `file://` URL —
ES modules require http/https).

## Deploy to GitHub Pages

The app is a static folder — no build step, no backend.

1. Push `main` to the repo (the `Deploy to GitHub Pages` workflow publishes it).
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Open the published URL: **https://abbxx292901921.github.io/inkpad/**

The workflow (`.github/workflows/deploy.yml`) publishes the folder as-is minus
`.git` and `.github`. All paths in `index.html` are relative, so the app works
under a subpath like `/inkpad/`.

## Use

- **Toolbar** (top centre, a floating pill): Pen / Marker / Pencil / Shapes /
  Select / Eraser, an import button, and a chevron that expands the island to
  reveal the options row. The pill on the right has Undo / Redo, the
  finger-drawing toggle and a "more" menu.
- **Colours**: tap `+` in the options row for the full colour card (16
  swatches, a colour wheel for custom colours, and a second palette page
  that collects your custom picks).
- **Stroke**: tap the line button in the options row for the thickness slider
  and the four line styles (solid / hairline / dashed / dotted).
- **Shapes**: tap the shape button for the picker — line, rectangle, ellipse,
  triangle, arrow — plus the Freeform/Boxed fill mode. Hold **Shift** while
  dragging to disable the 45°/square snapping.
- **Select**: tap the select button and draw a lasso around your ink. A blue
  dashed box with corner handles and a rotation handle appears; drag the
  handles to scale or rotate, drag the box to move, and Cmd/Ctrl+A to select
  everything.
- **Import a file**: tap `+` in the tool row. An image (a photo of your
  homework) becomes the page background and you write on top of it. A PDF
  becomes one page per PDF page, each with the rasterised page as its
  background.
- **Library**: the grid button at the top left opens the notes screen —
  folders, search, recent notes with thumbnails.
- The more menu has: clear page, add a blank page, reset the view,
  print / save as PDF, download as PNG, the ruler, and the input settings.
- **Ask AI**: the sparkle button in the right pill. Set up a provider first
  (the library screen's gear, or "Add a provider" in the panel). The current
  page — or your selection, cropped to it — is sent as an image, so the model
  can read your handwriting. The choice is yours: Inkpad never switches
  provider on its own and never retries.
- **Print / Save as PDF** and **Download as PNG** are in the more menu.
- Two-finger pinch zooms and pans; ctrl+wheel does the same on a trackpad.
- The Pencil needs no pairing. The moment any Pencil event is seen, fingers
  stop drawing so you can rest your hand on the screen; tap the
  finger-drawing button if you *want* fingers to draw as well. The choice is
  remembered.
- Press `D` for the debug overlay; `__inkpad` in the console exposes
  `{ note, page, strokes, selected, viewport, surface, history, palettes }`.

## Tests

```bash
node tests/run-all.mjs
```

Ten plain Node suites, 494 checks, no framework and no dependencies.

## Offline

A service worker precaches the whole app, so it opens with no network. The
precache list is generated from the repo:

```bash
node tools/gen-precache.mjs
```

Run it after adding a file under `src/`, `assets/`, `icons/` or `vendor/`.
Bump `CACHE_NAME` in `sw.js` on every deploy, or the old precache is reused.

## Add to Home Screen (iPad)

Open the live URL in Safari → **Share → Add to Home Screen**. The app icon is
the silver rocket-pen mark in `assets/logo.svg`; the manifest declares
`display: standalone`, so it launches full-screen without Safari chrome.

The service worker (offline support) is not shipped yet — the icon and the
standalone display are, so the home screen app already works, it just needs
the network for now.

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
- **Settings → Apple Pencil → Draw with Apple Pencil Only.** Optional but
  recommended: fingers then never draw in *any* app, including Safari. Inkpad
  has its own palm rejection, so this is belt and braces.
- **Settings → Safari → "Prefer Page Rendering Updates near 60fps": Off.**
  Gives 120Hz pointer updates, which is what makes strokes smooth.
- Pairing the Pencil with the iPad is **not** required for drawing. Pairing
  only enables double-tap-to-switch and Pencil Pro squeeze/hover gestures.
