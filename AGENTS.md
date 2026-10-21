# AGENTS.md — Inkpad contributor notes

## What this is
Inkpad: a static, offline-capable PWA for handwritten notes (Notability-style).
Vanilla HTML/CSS/JS (ES modules), no build step, no backend, no dependencies.
Runs as a static folder (GitHub Pages compatible).

## Architecture (phase C1)
- `index.html` — app shell: `<canvas id="page">`, toolbar container, file
  input, toast, debug overlay, pen ring, module entry.
- `theme.css` — the Notability-style design system: floating pills, the
  expandable tool island, popover cards, colour/line-style controls. Only the
  pills take pointer events; the full-width container stays click-through so
  strokes can start anywhere. Debug overlay and pen ring are
  `pointer-events: none` always.
- `src/app.js` — owns the document (note -> pages), the undo/redo history,
  the popovers, the file importer and the toolbar state.
- `src/canvas.js` — Pointer Events handling + SYNCHRONOUS incremental drawing.
  Ink tools paint inside the pointermove handler; the eraser collects a path
  and calls `erasePath()`.
- `src/strokes.js` — stroke data model (vector) + render helpers + undo/redo
  history + eraser hit-testing.
- `src/tools.js` — tool registry: pen, marker, pencil, eraser. Per-tool
  options (`{ color, width, opacity, lineStyle, pressureTaper }` for ink,
  `{ radius }` for eraser). `supportsLineStyle(id)` is false for the
  translucent marker.
- `src/pages.js` — the document model. A note owns pages; a page owns
  `layers` (imported files, drawn UNDER the ink) and `strokes` (the ink).
- `src/input.js` — pointer arbitration (pen vs finger). Owns the palm-rejection
  policy: `createInputPolicy()` for an isolated instance, `defaultInput` for the
  app. Choice persisted in `localStorage` (`inkpad.input.v1`).
- `src/ui/` — the UI layer. `icons.js` (inline SVG icon set), `popover.js`
  (floating panel primitive + colour wheel), `toolbar.js` (the pill + island),
  `palette.js` (the "Colors" card), `stroke-panel.js` (the "Stroke" card).
- `src/coord.js` — the ONLY screen<->page conversion. Nothing else touches zoom/pan/dpr.
- `design/notability-ui-spec.md` — the Notability UI rebuild spec, transcribed
  from the user's screenshots. Source of truth for the toolbar/palette/library
  work.
- `design/oss-references.md` — survey of open-source reference projects with
  their licences, and which ones are off limits.

Planned (later steps): `lasso.js`, `storage.js` (IndexedDB), `config.js`,
`markdown.js`, and `src/ai/` (see "AI providers" below).

## Document model
- Note = `{ id, title, folderId, createdAt, updatedAt, pages[] }`
- Page = `{ id, name, layers[], strokes[] }`
- Layer = an imported file drawn UNDER the ink: `{ id, kind: 'image'|'pdf',
  name, url, img, naturalWidth, naturalHeight, loaded }`. The blob is kept so
  IndexedDB can store it later.
- Render order is **layers -> strokes**. That is the whole point: importing
  your homework and writing on top of it is the normal case.
- v1 draws layers in SCREEN space, contain-fitted to the canvas. When
  pan/zoom lands they become page-space objects.

## File import
- `<input id="file-input" type="file" accept="image/*,application/pdf">`,
  hidden, opened by the `+` button in the tool island.
- Images become a page layer immediately. PDFs are detected and refused with
  a toast: PDF import needs **pdf.js** vendored, which needs the user's OK
  (AGENTS.md says "no dependencies").

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
- Stroke = `{ id, tool, color, width, opacity, pointerType, lineStyle,
  pressureTaper, points[] }`
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
- `pressureTaper: false` = constant width (pencil, marker).
- `lineStyle`: `solid | hairline | dashed | dotted`. A textured stroke is
  stroked as ONE path (`drawStrokePath`) so the dash pattern is continuous,
  and it re-strokes that path on every move — safe because it is opaque and
  the path prefix never changes. **A translucent stroke is never textured**,
  or the re-stroke would stack its alpha and darken the marker.

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
- `drawPieces(ctx, stroke, from, to)` paints ONLY pieces `from..to` (1-based) of
  the midpoint-forward chain; `drawTail(ctx, stroke)` paints the final segment.
  `renderStroke(ctx, stroke)` is the full-redraw path for one stroke. Re-drawing
  an already-painted piece would stack a translucent stroke's alpha and make the
  highlighter darker on every repaint.
- `repaintAll()` (inside the surface) redraws committed strokes AND any stroke
  that is still in progress. A committed-only redraw would wipe the line the
  user is drawing right now, so never replace it with a committed-only repaint.

## iPad / Apple Pencil rules (phase B)
- **Draw SYNCHRONOUSLY inside the pointermove handler.** iPadOS Safari drops
  pointer events when the main thread is busy on a slow animation frame, so
  deferring the paint to rAF loses points and produces angular strokes. The
  handler must stay cheap: one small path per event.
- `pointerrawupdate` is NOT supported in Safari/iPadOS — do not rely on it.
  `getCoalescedEvents()` is used when available, raw event as fallback.
- **Palm rejection** (see `src/input.js` — the Excalidraw "pen mode" pattern,
  excalidraw/excalidraw#4657):
  - `pointerType` IS `'pen'` for an Apple Pencil with NO pairing required.
    Pairing only buys double-tap / Pencil Pro gestures.
  - The rule is a **latch, not a timer**: once ANY pen event is seen (contact
    OR hover), a finger never draws again for the rest of the session. The old
    1500ms grace window expired and let the hand back in — that was the bug.
  - `pointercancel` **DISCARDS** the stroke; it never commits. iPadOS cancels a
    finger pointer when a pen takes over the digitizer, so a cancelled finger
    is a hand, not ink. The old code committed on cancel — that was the main
    source of phantom palm strokes.
  - A finger stroke that is already in flight when the pen lands is thrown
    away (`discardTouchStrokes()`).
  - A touch contact whose ellipse is bigger than `PALM_CONTACT_PX` (70 CSS px)
    is a resting palm, not a fingertip, and is ignored. iOS reports 0 when the
    geometry is unknown; then this filter stays quiet.
  - The user can override with the toolbar's finger-drawing toggle. An
    explicit choice wins forever after it is made; until then the auto rule
    applies. Persisted in `localStorage` under `inkpad.input.v1`.
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

## Branding
- `assets/logo.svg` is the source of truth for the mark: a silver pen with a
  four-pointed star (Gemini-style) for fins and a blue thrust flame, drifting
  over a deep-space background with a sun rising in the lower-left corner.
  `assets/logo-maskable.svg` is the same scene with the pen scaled to 80% for
  platform masks.
- The icon deliberately has NO wordmark: an iOS home screen tile is ~60pt, so
  text turns to mush. The "INKPAD" wordmark belongs in the app UI, not the icon.
- `icons/*.png` are generated from those SVGs by `tools/render-icons.ps1`
  (headless Chrome). The script rewrites width/height on the ROOT `<svg>` tag
  only — a naive global replace also hits the background `<rect>` elements and
  leaves the background covering only the top-left corner. The script then
  verifies all four corners of every PNG are fully opaque. Regenerate rather
  than hand-editing the PNGs.
- `manifest.json` declares `display: standalone` — this is what makes an
  iOS Home Screen web app run without Safari chrome and, with the service
  worker (phase E), exempt it from Safari's 7-day storage eviction.

## Known issues
- (phase C) Strokes and imported layers are in-memory only; reload loses them
  (IndexedDB autosave lands in a later phase).
- (phase C) No pan/zoom yet. Layer images are drawn in screen space, so they
  do not pan/zoom with the ink yet.
- (phase C) One page per note, and no library/folders screen yet. The Notability
  library screen is specified in `design/notability-ui-spec.md` §7.
- (phase C) PDF import is not wired: it needs pdf.js vendored (the user has
  not approved a dependency yet). Images work.
- (phase C) Shapes, lasso/transform handles, ruler and rotation dial are not
  built yet — they are specified in `design/notability-ui-spec.md` §5-§6.
- (phase B) No keyboard shortcuts yet.
- (phase B) `pointerrawupdate` is not available in Safari/iPadOS, so latency on
  iPad relies on synchronous painting rather than raw pointer updates.
- (phase B) No service worker yet, so the app is not offline-capable and does
  not yet install as a PWA (the manifest and icons ARE shipped; only the
  service worker is missing). Until phase E, treat it as scratchpad only.
