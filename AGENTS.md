# AGENTS.md — Inkpad contributor notes

## What this is
Inkpad: a static, offline-capable PWA for handwritten notes (Notability-style).
Vanilla HTML/CSS/JS (ES modules), no build step, no backend, no dependencies.
Runs as a static folder (GitHub Pages compatible).

## Architecture (step 2 + phase B)
- `index.html` — app shell: `<canvas id="page">`, toolbar container, debug overlay, pen ring, module entry.
- `theme.css` — styling. Only the toolbar BAR is interactive; its full-width
  container stays click-through (`pointer-events: none`) so strokes can start
  anywhere. Debug overlay and pen ring are `pointer-events: none` always.
- `src/app.js` — owns strokes array + history, wires canvas/ui hooks, pen ring.
- `src/canvas.js` — Pointer Events handling + SYNCHRONOUS incremental drawing.
  Ink tools paint inside the pointermove handler; the eraser collects a path
  and calls `erasePath()`.
- `src/strokes.js` — stroke data model (vector) + render helpers + undo/redo
  history + eraser hit-testing.
- `src/tools.js` — tool registry: pen, highlighter, eraser. Per-tool options
  (`{ color, width, opacity }` for ink, `{ radius }` for eraser).
- `src/ui.js` — stateless toolbar renderer (`buildToolbar()` →
  `update(state)`). All behavior lives in app.js callbacks.
- `src/coord.js` — the ONLY screen<->page conversion. Nothing else touches zoom/pan/dpr.

Planned (later steps): `lasso.js`, `storage.js` (IndexedDB), `config.js`,
`markdown.js`, and `src/ai/` (see "AI providers" below).

## AI providers (planned, phase I1)
Multi-provider BYOK. `src/ai/` replaces the single `gemini.js`:
- `providers.js` — 5 request/response kinds: `openai` (OpenAI Chat Completions:
  Groq, OpenRouter, NVIDIA NIM, Mistral, Cerebras, Together, OVH, Z.ai, Workers
  AI, LM Studio, Ollama), `gemini-generate`, `gemini-interactions`,
  `anthropic`, and `raw` (user-supplied body template + response path).
- `client.js` — one call path, typed errors (InvalidKey / RateLimited /
  OutOfCredits / Network / Server / Parse). NO auto-rotation: the user picks the
  provider manually.
- `presets.js` — provider presets in `localStorage` (`inkpad.presets.v1`).
  Preset = `{ id, label, kind, endpoint, modelsUrl, apiKey, model, auth,
  extraHeaders, vision, requestTemplate, responseTextPath }`. Pure config, no
  runtime state.
- `models.js` — best-effort model list fetch; failure is non-fatal.

**NEVER** scrape or reuse the Google AI Studio web UI's session credentials
(`SAPISIDHASH`, cookies, the `alkalimakersuite-pa.clients6.google.com` RPC
endpoint, or the public key embedded in Studio's JS). Those are undocumented
internal endpoints and Google explicitly prohibits reverse-engineering the
Services; use a normal API key from AI Studio instead.

## Coordinate system
One page-coordinate space. `screenToPage()` / `pageToScreen()` in `src/coord.js`
convert between CSS pixels (relative to canvas top-left) and page coords using
`viewport = { zoom, panX, panY, dpr }`. devicePixelRatio is applied ONLY in
`applyTransform()` (canvas backing-store scale). Step 1: zoom=1, pan=(0,0).
Step 3 adds pan/zoom by mutating the viewport — no call-site changes.

## Data model
- Stroke = `{ id, tool, color, width, opacity, pointerType, points[] }`
- Point = `{ x, y, pressure, t }` (x/y in page coords)
- Vector data, never pixels → enables undo/redo, erase, move, re-render at any zoom.
- History: `createHistory()` + `addEntry`/`deleteEntry` inverse ops on the
  strokes array (in-memory only, never persisted). Undo/redo restore original
  z-order via recorded indices.
- Highlighter strokes are translucent (`opacity < 1`) and render with
  `destination-over` so they always sit behind ink.
- Eraser is a stroke eraser (whole-stroke delete via segment hit-test +
  bbox reject), radius 14 page units. Pixel eraser is out of scope.
- `pointerType` is stored per stroke (palm rejection needs it).
- Pressure: `pressureOf()` treats `0`/undefined as "no data" → fallback `0.5`.

## Rendering model (do not regress)
`strokes.js` renders a stroke as a chain of quadratic PIECES (the
"midpoint-forward" scheme) over the point list:
- piece 1: `p0` --(control p1)--> `mid(p1,p2)`
- piece i: `mid(p[i-1],p[i])` --(control p[i])--> `mid(p[i],p[i+1])`
- tail: `mid(p[n-2],p[n-1])` --> `p[n-1]`
Rules:
- Piece i becomes drawable only when `p[i+1]` arrives, so every piece is
  painted EXACTLY ONCE. Consecutive pieces share an endpoint → the stroke is
  continuous with NO gap at the tip. (The old scheme repainted the tip segment
  and left a half-segment gap, which showed as dashes at speed.)
- Nothing is ever repainted, so a translucent stroke cannot stack its own
  alpha and darken.
- Translucent strokes batch a whole pointermove batch into ONE path with butt
  caps (a single `stroke()` call applies the alpha once; butt caps mean
  consecutive batches meet exactly, with no double-composited joint disc).
- Opaque strokes may use round caps and a per-piece width (pressure taper).
- `renderStroke()` is the full-redraw path (resize, undo, redo).

## Pointer rules (do not regress)
- Pointer Events only (`pointerdown/move/up/cancel`). Never mouse/touch events or drag-and-drop.
- `touch-action: none` on the canvas (else the browser steals touch gestures).
- `getCoalescedEvents()` in `pointermove` for smooth fast strokes.
- `setPointerCapture()` on `pointerdown`; `pointercancel`/`lostpointercapture` finish or discard.
- Mouse: only button 0 draws. One active stroke per pointerId.
- `drawStrokeRange(ctx, stroke, drawnChunks)` draws only segments AFTER
  `drawnChunks` (segment i joins point i-1 to point i) and returns the new
  count. Re-drawing an already-painted segment would stack a translucent
  stroke's alpha and make the highlighter darker on every repaint.

## iPad / Apple Pencil rules (phase B)
- **Draw SYNCHRONOUSLY inside the pointermove handler.** iPadOS Safari drops
  pointer events when the main thread is busy on a slow animation frame, so
  deferring the paint to rAF loses points and produces angular strokes. The
  handler must stay cheap: one small path per event.
- `pointerrawupdate` is NOT supported in Safari/iPadOS — do not rely on it.
  `getCoalescedEvents()` is used when available, raw event as fallback.
- **Palm rejection**: a pen event (contact OR hover) marks the pen active for
  `PEN_GRACE_MS` (1500ms). While active, `pointerType === 'touch'` never draws.
  Touch is reserved for pan/zoom (phase C).
- **Squeeze / eraser end**: `buttons & 32` (or `button === 5`) = the pen's
  eraser end → erases whatever tool is selected. `buttons & 2` = barrel button
  → also erases. Switching mid-stroke commits the ink drawn so far.
- **Pen hover**: `pointerType === 'pen'` with `buttons === 0` moves the cursor
  ring (`#penring`) and never draws.
- `desynchronized: true` on the 2D context asks for a low-latency surface.
- Never commit local IP addresses to this repo.

## Secrets
- Provider API keys are entered in Settings and stored in browser
  `localStorage` only (`inkpad.presets.v1`). Never hardcode, commit, or log a
  key. `.gitignore` covers `.env*`, `*.key`, `*.pem`, `secrets/`.
- The app makes NO network calls other than to the provider endpoint the user
  configures. No CDN, no analytics, no telemetry, no fonts from a server.
- Keys are sent in a header (`Authorization: Bearer`, `x-api-key`,
  `x-goog-api-key`), not in a query string, unless the user's own `raw` preset
  template explicitly puts it in the body.

## Deployment
- Live URL: `https://abbxx292901921.github.io/inkpad/` (repo `abbxx292901921/inkpad`).
- `.github/workflows/deploy.yml` publishes the folder as-is minus `.git`/`.github`.
  All paths in `index.html` are relative so the app works under the `/inkpad/`
  subpath. No build step.
- `robots.txt` (Disallow: /) + `<meta name="robots" content="noindex, nofollow">`
  keep the site out of search engines and web archives. Do not remove them
  unless the user asks.
- Commit identity for this repo is the GitHub noreply address of the alt
  account (`git config --local`). Do not commit personal names or emails.

## Testing on iPad
- **Deployed**: open the live URL in iPad Safari. HTTPS, so the service worker,
  install prompt and `navigator.storage.persist()` are all testable there.
- **LAN (fastest)**: `python -m http.server 8000` on the dev machine, then open
  `http://<LAN-IP>:8000` in iPad Safari on the same Wi-Fi. Pencil/touch/drawing
  all work. No service worker, no install prompt, no `navigator.storage.persist()`
  (http is not a secure context).
- **Tailscale** (if installed on both devices): `tailscale serve` gives an
  HTTPS URL for testing without deploying. Never commit local IP addresses to
  this repo.
- iPad gotchas: Settings → Apple Pencil → **Scribble: Off** (it steals Pencil
  strokes); Settings → Safari → **"Prefer Page Rendering Updates near 60fps":
  Off** (enables 120Hz pointer updates).

## Debugging
- Press `D` for the debug overlay: phase, pointerType, screen vs page coords, pressure, coalesced count.
- `window.__inkpad` exposes `{ strokes, viewport, surface }` in the console.
- Diagnose first (logging, overlay) before changing code.

## Known issues
- (phase B) Strokes are in-memory only; reload loses them (IndexedDB autosave lands in step 4).
- (phase B) No pan/zoom yet (step 3). Erase radius is in page units, tuned for zoom=1.
- (phase B) Highlighter color is fixed yellow; swatches/widths apply to the pen.
  Widths are per-tool (pen 2/3/5, highlighter 10/14/20).
- (phase B) No keyboard shortcuts yet (step 11). Touch still draws (palm
  rejection only blocks touch while a pen is active); pan/zoom is step 3.
- (phase B) `pointerrawupdate` is not available in Safari/iPadOS, so latency on
  iPad relies on synchronous painting rather than raw pointer updates.
- (phase B) No PWA/service worker/manifest yet, so the app cannot be added to the
  Home Screen and Safari's 7-day storage eviction applies to any data we store.
  Until phase E, treat the app as scratchpad only.
