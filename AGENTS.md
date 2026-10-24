# AGENTS.md — Inkpad contributor notes

## What this is
Inkpad: a static, offline-capable PWA for handwritten notes (Notability-style).
Vanilla HTML/CSS/JS (ES modules), no build step, no backend.
Runs as a static folder (GitHub Pages compatible).

## Dependencies (the rule)
**Permissive-licensed code may be VENDORED.** The rules that actually matter:
- **No build step.** The repo IS the artifact: `git push` deploys it. No npm
  install, no bundler, no node_modules in git.
- **No runtime network calls.** Nothing is fetched from a CDN at runtime. The
  app works with the network off, and no key or request ever leaves the device
  except to the AI provider the user configures.
- **Vendored code must be permissive** (MIT / Apache-2.0 / BSD / ISC). No
  copyleft, no source-available licences. See design/oss-references.md for the
  licence blockers — tldraw's custom licence in particular forbids production
  use without a paid key.
- Vendored code keeps its own LICENSE file next to it.

This replaced an earlier blanket "no dependencies" rule, which was over-strict:
it cost us PDF import (pdf.js) for no benefit. The build-step and
network rules are the ones worth protecting.

Currently vendored: `vendor/pdfjs/` (pdf.js 6.4.299, Apache-2.0) — the
ESM build, the worker, the CMaps, the standard fonts and the WASM decoders.
Regenerate the service worker's precache list after adding a file:
`node tools/gen-precache.mjs`.

## Architecture
- `index.html` — app shell: the editor section (canvas + toolbar) and the
  library section, the file input, the toast, the debug overlay, the pen ring.
- `theme.css` — the design system: floating pills, the expandable tool island,
  popover cards, colour/line-style controls. Only the pills take pointer
  events; the full-width container stays click-through so strokes can start
  anywhere. Debug overlay and pen ring are `pointer-events: none` always.
- `src/app.js` — wires everything: the toolbar, the popovers, the file
  importer, the selection overlay, the screens. It does NOT own the document.
- `src/workspace.js` — the document store: which notes exist, which one is
  open, autosave, thumbnails. Owns the persistence policy.
- `src/storage.js` — IndexedDB. Notes, pages, layers (blobs stored natively),
  strokes, folders, settings. Layer object URLs are regenerated on load.
- `src/canvas.js` — Pointer Events handling + SYNCHRONOUS incremental drawing.
  Ink tools paint inside the pointermove handler; the eraser collects a path
  and calls `erasePath()`; the shape tool draws a preview; the select tool
  collects a lasso path (or a marquee, in `boxed` mode); the text tool collects
  a box. Multi-page: a gesture is PINNED to the page it started on and every
  point is converted to that page's LOCAL coordinates. `createDrawingSurface`
  takes an optional `{ paper }` canvas (see "Rendering model").
- `src/layout.js` — the geometry of the scrollable document: page stacking,
  document space, viewport culling, pan clamping, and the sheet painter.
  DOM-free. `DEFAULT_PAGE_W=794`, `DEFAULT_PAGE_H=1123`, `PAGE_GAP=28`,
  `PAGE_MARGIN=24`; `pageSize`, `pageOffsets`, `pageRect`, `docSize`,
  `resolvePageAt`, `visiblePages`, `clampPan`, `drawPageSheet`.
- `src/strokes.js` — stroke data model (vector) + render helpers + undo/redo
  history + eraser hit-testing + transform snapshots + `cloneStroke` (used
  when a page is duplicated).
- `src/shapes.js` — shape geometry. A shape IS a stroke: its points are the
  VERTICES, so undo, persistence, export and hit-testing work on it for
  free. Two DRAW modes: `boxed` (drag a rectangle, the shape is fitted into
  it) and `freeform` (the shape IS the outline you draw). `setVertex`,
  `snapVertex` (snaps a dragged vertex to a nearby vertex or EDGE of another
  shape) and `toSquare` (the square/regular-polygon preset) live here too.
- `src/text.js` — text objects. A text object is a stroke-like object with
  `kind: 'text'` and a BOX (`x, y, w, h`): the text tool drags out a
  rectangle and the text is typed inside it, wrapped to the box, with the
  font size fitted to it. Rich fields live on the object: `family`, `size`,
  `bold`, `italic`, `underline`, `align` (left/center/right) and `list`
  (none/bullet/number). `measured` is a memo of the wrapped lines; set it to
  `null` after changing any field so the next paint re-wraps. Font families
  are SYSTEM stacks (`TEXT_FONT_FAMILIES`) — no webfont is ever fetched.
- `src/transform.js` — bounds, move/scale/rotate maths for the selection.
  `strokeBounds()` understands text boxes, so `strokesInRect` and
  `strokesInPolygon` select text like any other object.
- `src/tools.js` — tool registry: pen, marker, pencil, shape, select, eraser.
  Per-tool options (`{ color, width, opacity, lineStyle, pressureTaper }` for
  ink, `{ shape, mode, fill }` for shapes, `{ mode: 'freeform'|'boxed' }` for
  select, `{ radius }` for the eraser).
  `supportsLineStyle(id)` is false for the translucent marker.
- `src/pages.js` — the document model. A note owns pages; a page owns
  `layers` (imported files, drawn UNDER the ink) and `strokes` (the ink).
  A page also carries `w`, `h` and `template` (its own sheet size and ruling).
- `src/pdf.js` — PDF import via the vendored pdf.js. Each PDF page is
  rasterised to a PNG and becomes a page of the note.
- `src/export.js` — PNG export and the print view (Save as PDF).
- `src/input.js` — pointer arbitration (pen vs finger). Owns the palm-rejection
  policy: `createInputPolicy()` for an isolated instance, `defaultInput` for the
  app. Choice persisted in `localStorage` (`inkpad.input.v1`).
- `src/sw-register.js` — service worker registration.
- `src/ui/` — the UI layer. `icons.js` (inline SVG icon set), `popover.js`
  (floating panel primitive + colour wheel), `toolbar.js` (the pill + island),
  `palette.js` (the "Colors" card), `stroke-panel.js` (the "Stroke" card),
  `shape-menu.js` (the shape picker), `select-menu.js` (the lasso/boxed
  picker), `selection.js` (the transform box + Duplicate/Delete row),
  `shape-editor.js` (the draggable vertex handles),
  `library.js` (the notes screen), `pages-panel.js` (the page sidebar:
  thumbnails, search, add/duplicate/delete/clear), `text-bar.js` (the rich
  text formatting bar), `tool-menu.js` (the per-tool quick menu: colour and
  thickness presets behind a re-tap of the active pen/marker/pencil, or
  sizes for the eraser), `ruler.js` + `rotation-dial.js`,
  `settings.js` (the AI providers sheet), `ask-ai.js` (the Ask AI panel),
  `text-input.js` (the on-canvas text field), `prompt.js` (text and list
  prompts).
  UI-only CSS lives beside its module and is injected at runtime — there is no
  bundler to bundle it.
- `worker/inkpad-proxy.js` — a Cloudflare Worker that proxies AI API calls
  so providers that block browser calls (OpenAI, Anthropic, NVIDIA NIM) can
  be used. The key lives in the worker's bindings, never in the app. See
  `worker/README.md`; `worker/wrangler.toml` is the ready-to-deploy config
  (the NVIDIA key is a `wrangler secret`, not a file).
- `src/ai/` — the AI layer: `providers.js`, `client.js`, `presets.js`,
  `models.js`, `annotate.js`. See "AI providers" below.
- `src/coord.js` — the ONLY screen<->page conversion. Nothing else touches zoom/pan/dpr.
- `sw.js` — the service worker (classic script, at the repo root).
- `tools/gen-precache.mjs` — regenerates the service worker's precache list.
- `tests/` — the test suite. Plain Node scripts, no framework, no
  dependencies: `node tests/run-all.mjs` runs all eighteen suites (1216 checks).
  Every suite prints `ALL N CHECKS PASSED` and exits non-zero on the first
  failure, so they work in CI as-is.
- `design/notability-ui-spec.md` — the Notability UI rebuild spec, transcribed
  from the user's screenshots. Source of truth for the toolbar/palette/library
  work.
- `design/oss-references.md` — survey of open-source reference projects with
  their licences, and which ones are off limits.

## Document model
- Note = `{ id, title, folderId, template, createdAt, updatedAt, pages[] }`
- Page = `{ id, name, template, w, h, layers[], strokes[] }`
- `w`/`h` are the page's OWN sheet size (a PDF page keeps its aspect ratio);
  `template` is `blank | lined | grid | dotted`. Both are optional on old
  records — `layout.pageSize()` falls back to A4 and the painter to blank.
- Layer = an imported file drawn UNDER the ink: `{ id, kind: 'image'|'pdf',
  name, blob, url, img, naturalWidth, naturalHeight, loaded, rect }`. The blob
  is kept so IndexedDB can store it later. `rect` is the layer's PAGE-LOCAL
  rectangle, so it pans and zooms WITH the ink.
- Render order is **layers -> strokes**. That is the whole point: importing
  your homework and writing on top of it is the normal case.
- A layer is placed at the visible area of the ACTIVE page at import time,
  contain-fitted. A layer with no rect falls back to being fitted to its page.

## Selection and rich text (phase B)
- The select tool has two DRAW modes, picked in `select-menu.js`:
  `freeform` (the lasso outline you draw, the default) and `boxed` (a
  marquee rectangle). Both select STROKES and TEXT OBJECTS.
- A selection owns a transform box (`ui/selection.js`) with move, scale and
  rotate handles plus a Duplicate / Delete action row. All transform maths
  are in `src/transform.js`; the box's `bounds` stay page-local so a
  selection survives panning and zooming. A scale handle can never drag its
  edge past the opposite edge: the new size is floored at 8 page units, so
  the scale factor stays positive and the box can never invert (an inverted
  box once exploded the bounds and blacked out the screen on an iPad).
  Text objects scale their BOX and font size with the selection.
- Text objects are stroked, selected and moved like ink because their box is
  their bounds (`strokeBounds()`). The rich formatting bar (`ui/text-bar.js`)
  is visible while the text tool is active OR text objects are selected, and
  patches the objects in place (`measured = null` forces a re-wrap).
- The bar and the page nav both live at the bottom; `syncTextChrome()` adds
  `body.text-bar-on` so CSS lifts `#bottomnav` above the bar instead of
  stacking the two.

## Multi-page document (phase A contracts)
The editor is ONE scrollable document: pages stacked vertically on a table.
- **Page coordinates are LOCAL to their page.** A stroke at (10, 20) is 10pt
  from the left edge of ITS page. Inserting, deleting or reordering a page
  never rewrites ink. All tools, history, hit-testing and export keep working
  in page units.
- **Document space** is what the viewport pans/zooms. `layout.js` maps a page
  index to its document rect; `coord.js` stays doc<->screen only.
- `createDrawingSurface(canvas, viewport, hooks, { paper })` hooks:
  `getPages()`, `onActivePage(index)`, `commitStroke(stroke, pageIndex)`,
  `erasePath(path, pageIndex)`, `onLasso(path, pageIndex)`,
  `onSelectBox(box, pageIndex)`, `onTextBox(box, pageIndex)`,
  `onPenHover({ x, y, pressure, pageIndex })`, `onViewportChange()`.
  `getStrokes()`/`getLayers()` are the LEGACY single-page fallback, used only
  when `getPages` is absent (the integration suite).
- A new gesture resolves the page under the pointer ONCE and pins the rest of
  the gesture to it; points outside the sheet are clipped by the page clip.
  A pointerdown on the table or in a gap starts nothing (one-finger pan and
  pinch still work).
- **Auto-append**: committing a stroke that reaches within
  `AUTO_APPEND_MARGIN` (56pt) of the bottom of the LAST page appends a blank
  page below, so writing never hits a wall. The active page does not change.
- Page chrome: `#bottomnav` (prev / "N / M" / next) scrolls to a page with
  `surface.panTo()`; `#scrollbar` (drag the thumb) and `fitPage()` use the same
  path. `workspace.addPage({ select })`, `duplicatePage(index)`,
  `removePage(index)` (clearing instead when it is the last page).
- History entries are bound to the page's strokes array (`onPage()` in
  app.js), so Undo after scrolling to another sheet still reverses the edit
  that was actually made.

## File import
- `<input id="file-input" type="file" accept="image/*,application/pdf">`,
  hidden, opened by the `+` button in the tool island.
- **An import is ALWAYS a fresh note**: `importFile()` calls
  `workspace.newNote()` first, opens the editor, and then lays the file in —
  an image as a contain-fitted layer on page 1, a PDF as the note's pages.
  Nothing is ever merged into the note that happens to be open. The note is
  named from the file, and a decode failure (a broken/unsupported file)
  removes the layer and toasts instead of sitting invisible on the page.
- PDFs are rasterised page by page with the vendored pdf.js; each PDF page
  becomes a notebook page at the A4 width, keeping its own aspect ratio, with
  the raster as a full-sheet layer. pdf.js renders through a canvas CONTEXT
  (`render({ canvasContext, viewport })`), not the canvas element.

## AI providers (phase I1)
Multi-provider BYOK, in `src/ai/`. The user picks the provider; the app
NEVER rotates between providers on its own, and never retries.
- `providers.js` — 5 request/response kinds: `openai` (OpenAI Chat Completions:
  Groq, OpenRouter, NVIDIA NIM, Mistral, Cerebras, Together, OVH, Z.ai, Workers
  AI, LM Studio, Ollama), `gemini-generate`, `gemini-interactions`,
  `anthropic`, and `raw` (user-supplied body template + response path).
  Also `describeKind(kind)`, which the settings UI uses for the defaults and
  the help text.
- `client.js` — one call path, typed errors (InvalidKey / RateLimited /
  OutOfCredits / Network / Server / Parse / Cors / Aborted).
- `presets.js` — provider presets in `localStorage` (`inkpad.presets.v1`, and
  the active id in `inkpad.presets.active`). Preset = `{ id, label, kind,
  endpoint, modelsUrl, apiKey, model, auth, extraHeaders, vision,
  requestTemplate, responseTextPath }`. Pure config, no runtime state.
  `providerTemplates()` returns the one-tap TEMPLATES the settings sheet
  offers ("Quick fill"): each one writes the endpoint, models URL, model,
  auth style and vision flag into the form — and NEVER a key, which stays
  in the preset the user types. The relay templates point at the user's own
  "polyglot" Cloudflare Worker (`RELAY_HOST`): the worker's address in
  front of the real host in the PATH
  (`https://<worker>/integrate.api.nvidia.com/v1`), so a browser can reach
  a provider that sends no CORS headers, the key stays in localStorage,
  and switching provider is a new preset — never a worker edit.
- `models.js` — best-effort model list fetch; failure is non-fatal (the user
  types the model name instead).
- `annotate.js` — the AI annotation contract: `annotationPrompt()` asks for
  JSON on a 0-1000 grid, `parseAnnotations()` validates it (max 12,
  types rect/ellipse/arrow/callout, labels capped at 80 chars).
- `src/ui/settings.js` — the provider settings sheet. `src/ui/ask-ai.js` — the
  "Ask AI" panel (the sparkle button in the right pill).

**AI annotations.** The Annotate button sends a JPEG of the page (or of the
selection) plus a system prompt; the reply is parsed into page objects: rect
/ellipse/arrow become boxed shape strokes and a callout becomes a text
object, all in `AI_ANNOTATION_COLOR`. Coordinates are multiplied by the
page's own `w/h`, so the same answer lands correctly on an A4 sheet and on a
PDF page of a different aspect ratio. The whole batch is ONE history entry,
so a single Undo removes it. A model that ignores the JSON contract yields
zero objects and an error in the panel — never a half-applied batch.

**CORS IS THE REAL LIMIT.** Most hosted provider APIs send no
`Access-Control-Allow-Origin`, so a browser cannot call them with a key. The
client turns that into an explicit `cors` error ("<Provider> blocks browser
calls, so it needs a proxy") rather than a generic network failure. Gemini's
`generativelanguage.googleapis.com` does allow browser calls; OpenAI and
Anthropic do not. A small proxy (a Cloudflare Worker) is the fix if the user
wants those.

**NEVER** scrape or reuse the Google AI Studio web UI's session credentials
(`SAPISIDHASH`, cookies, the `alkalimakersuite-pa.clients6.google.com` RPC
endpoint, or the public key embedded in Studio's JS). Those are undocumented
internal endpoints and Google explicitly prohibits reverse-engineering the
Services; use a normal API key from AI Studio instead.

## Coordinate system
Two spaces, one conversion module:
- **Document space** — the table the pages sit on. `coord.js` converts CSS
  pixels (relative to the canvas top-left) <-> document coords via
  `viewport = { zoom, panX, panY, dpr }`. `layout.js` maps pages into this
  space.
- **Page-local space** — where all ink lives. `layout.resolvePageAt()` returns
  the local point, and `canvas.js` subtracts the page origin once at input.
  The UI modules that speak screen pixels (selection, shape editor, pen ring)
  are handed `pageViewport(index)` — the live viewport shifted by the page's
  origin — so `pageToScreen(local)` lands correctly.
devicePixelRatio is applied ONLY in `applyTransform()` (canvas backing-store
scale). Pan and zoom MUTATE the viewport; `zoomAt`, `panBy` and `applyPinch`
in coord.js are the only places that change it. Zoom is clamped to 0.25-8x.
Pan is clamped by `layout.clampPan()` against the whole document, and a
document smaller than the screen is centred.

Pan/zoom gestures:
- Two-finger pinch/pan on touch. The transform is computed from the gesture
  BASELINE (the zoom and pan at the moment the gesture started), NOT from the
  live viewport — otherwise every pointermove multiplies the zoom again and
  the gesture runs away to the limit.
- ONE finger pans the page when the finger policy says 'pan' (the default
  once the Pencil has been used). It is a pan, not a draw, so it can never
  leave ink.
- Wheel pans; ctrl+wheel (the trackpad pinch gesture) zooms about the cursor.
- A resting hand is dropped from a 3+ touch gesture, so it cannot drag the
  page around.

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
**Two canvases.** `#paper` underneath carries the sheets, their ruling and the
imported layers; `#page` on top is transparent and carries only ink.
`createDrawingSurface(canvas, viewport, hooks, { paper })` wires both. The
split is REQUIRED: translucent ink is drawn with `destination-over`, so a
sheet painted on the same canvas would hide the marker. Never draw the paper
on the ink canvas.

Per repaint, in order: clear both -> visible sheets (`drawPageSheet`) + layers
per visible page on the paper canvas -> committed ink per visible page on the
ink canvas (clipped to the sheet) -> in-progress strokes.
`visiblePages()` culls, so a 200-page PDF costs only the pages on screen.

**The two cheap repaint paths (do not regress).** A full repaint per frame is
what made pinch-zoom and the select/shape previews feel heavy on an iPad, so
`afterViewChange()` and the preview handlers use two shortcuts:
- **The snapshot replay.** While pan/zoom input is still arriving (< 90ms
  apart) the surface replays a bitmap of the last full paint (`drawImage` of
  the captured canvases in doc space) instead of re-stroking every visible
  stroke. A settle timer re-renders vector-crisp ~140ms after input stops.
  `redraw()` (content changed) sets the snapshot invalid, so a stale bitmap
  is never replayed after a commit, an undo or a resize.
- **The region repaint.** The shape draft and the select marquee/lasso move
  every pointermove; each move clears and re-renders only the UNION of the
  previous and the new preview footprint (`repaintRegion()`), not the whole
  sheet. A preview can therefore never leave a trail, and never costs a
  full repaint either.

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
- Gestures are pinned to a page: `entry.rect` is resolved at pointerdown, and
  every point is converted into that page's local space. Drawing is clipped to
  the sheet, so ink never spills onto the table or the next page.

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
  - The finger policy has THREE states. `auto` (the default): a finger DRAWS
    until the Pencil is seen, and after that a finger PANS the page — one
    finger is enough to scroll, and a resting hand cannot leave ink. The user
    can override with `on` (a finger always draws) or `off` (a finger is
    ignored). The explicit choice wins forever after it is made. Persisted in
    `localStorage` under `inkpad.input.v1`.
  - `pointercancel` **DISCARDS** the stroke; it never commits. iPadOS cancels a
    finger pointer when a pen takes over the digitizer, so a cancelled finger
    is a hand, not ink. The old code committed on cancel — that was the main
    source of phantom palm strokes.
  - A finger stroke that is already in flight when the pen lands is thrown
    away (`discardTouchStrokes()`).
  - A touch contact whose ellipse is bigger than `PALM_CONTACT_PX` (70 CSS px)
    is a resting palm, not a fingertip, and is ignored. iOS reports 0 when the
    geometry is unknown; then this filter stays quiet.
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
- (phase Z) A committed text object can be re-styled (select it, the text bar
  patches `family`/`size`/weight/align/list) but its CONTENT cannot be
  re-edited: there is no tap-to-reopen on a text object yet.
- (phase Z) The pages panel adds, duplicates, deletes and clears pages, but
  pages cannot be reordered by dragging a thumbnail.
- (phase C) The library's "Record a lecture", "Find a template" and Gallery
  are placeholders. The bell and the "Daily Brain Break" card are decoration.
- (phase C) Audio recording and templates are not built.
- (phase C) Folders can be created, renamed and deleted; a note can be moved
  to a folder from its row menu (library) or the more menu (editor), but not
  by dragging it in the library.
- (phase C) No keyboard shortcut for the tools yet (undo/redo are bound to
  Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z).
- (phase C) OpenAI, Anthropic and NVIDIA NIM cannot be called from a browser
  at all (no CORS headers). Gemini, Groq, OpenRouter and any local server
  can. `worker/inkpad-proxy.js` is the fix — it is written and tested, but
  it has to be DEPLOYED by the user (a Cloudflare account is needed).
- (phase C) The `gemini-interactions` provider kind is implemented against an
  UNVERIFIED upstream shape. `responseTextPath` can override where the answer
  is read.
- (phase B) `pointerrawupdate` is not available in Safari/iPadOS, so latency on
  iPad relies on synchronous painting rather than raw pointer updates.
- (phase B) The service worker is shipped, but the cache name must be bumped
  on every deploy or the old precache is reused.
