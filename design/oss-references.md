# Open-source reference projects

Surveyed 21 Oct 2026. Facts below were checked against GitHub's API, npm's
registry, and the projects' own source files — not just their READMEs.
Anything I could not verify is marked **unverified**.

Purpose: find code and techniques worth *studying* for Inkpad, and avoid
copying anything whose licence would contaminate this repo.

---

## 0. Licence blockers — READ THIS FIRST

Inkpad is a public, permissive, no-dependency project. These projects are
**off limits for copying** (reading them for ideas is fine):

| Project | Licence | Why it blocks |
|---|---|---|
| **tldraw** | Custom "tldraw licence" (`SPDX: NOASSERTION`) | The licence states *"Not to use the Software in Production Environments."* Production use requires a paid commercial/trial licence **plus a licence key**, and the SDK ships *"technical measures to verify License Key validity, detect deployment environments, enforce usage restrictions"* and *"may collect and transmit usage data to tldraw for license compliance purposes."* **Hard blocker.** |
| **whitebophir (WBO)** | AGPL-3.0 | Copyleft + network clause. A modified deployment must publish source. |
| **Xournal++** | GPL-2.0 | Copyleft. |
| **Rnote** | GPL-3.0 | Copyleft. |
| **Saber** | GPL-3.0 | Copyleft. |
| **SpeedyNote** | GPL-3.0 | Copyleft. |
| **AbelNotes** | AGPL-3.0 + **separate trademark terms** | Copyleft, *and* the name/logo are excluded — *"if you redistribute publicly, use a different name and icon."* |
| **NexaNote** | MPL-2.0 | Weak copyleft (file-level). |
| **svg2notability** | **No LICENSE file** | Unlicensed = all rights reserved. Do not copy code. |
| **notability-notes-converter** | **No LICENSE file** | Unlicensed. |
| **notability-to-svg** | GPL-3.0 | Copyleft. |
| **MyScript iink** | Proprietary | Client libs are free but recognition runs on MyScript Cloud. Not offline, not self-hosted. |

**Safe to borrow (permissive):** perfect-freehand (MIT), atrament (MIT),
signature_pad (MIT), js-draw (MIT), Quickdraw (MIT), Excalidraw (MIT),
Konva (MIT), Paper.js (MIT), Fabric.js (MIT), rough.js (MIT), weavejs
(Apache-2.0), pdf.js (Apache-2.0), pdf-lib (MIT), jsPDF (MIT), pdfme (MIT),
martinez-polygon-clipping (MIT), rbush (MIT), d3-zoom/d3-brush (ISC),
hotkeys-js (MIT), nanoid (MIT), immer (MIT), zundo (MIT).

---

## 1. Pressure ink

| Project | URL | Licence | No-build? | Notes |
|---|---|---|---|---|
| **perfect-freehand** | github.com/steveruizok/perfect-freehand | MIT | Yes — npm ships `dist/esm/index.mjs` | ★5.7k; npm 1.2.3 (2026-02-01). **The** reference for pressure→outline. `getStroke()` returns a closed **polygon** to fill, not a stroked polyline. Options: `size`, `thinning`, `smoothing`, `streamline`, `simulatePressure: false` + real per-point `pressure`, `start`/`end` taper. **Caveat for Inkpad:** its filled-polygon model lets translucent highlighter strokes double-composite. Inkpad's existing *"paint each piece exactly once"* rule in `strokes.js` is **safer**. Use it for pressure→width maths only, not as a drop-in renderer. |
| **atrament** | github.com/jakubfiala/atrament | MIT | Yes — ESM only in v5 | ★1.8k; npm 5.1.0 (2025-09-26). Smallest complete pointer→canvas pipeline (2.4 kB gzip). Paints **pixels, no vector model** — cannot support zoom/undo properly. **Its v4.0.0 (Feb 2024) migrated from Touch Events to Pointer Events specifically to fix the iPad wrist bug.** |
| **signature_pad** | github.com/szimek/signature_pad | MIT | **Yes — best no-build fit**, ships `dist/signature_pad.umd.min.js` | ★12k; npm 5.1.4 (2026-07-31). Velocity-based width, `minWidth`/`maxWidth` taper, `dotSize`, and a `getPoint` hook to inject **real stylus pressure** (it does *not* use `PointerEvent.pressure` by default). |
| **js-draw** | github.com/personalizedrefrigerator/js-draw | MIT | No (bundler needed) | ★299; npm 1.33.0 (2025-12-26). **The most complete notebook-grade ink reference.** Verified in source: `toStrokePoint()` reads `pointer.pressure` (clamps to ≥0.3, falls back 0.5), and stores **width per stroke point** rather than a global `lineWidth`. Also has input stabilization, `StationaryPenDetector` → `autocorrectShape()`, partial-stroke eraser, SVG serialise/deserialise. |
| **Quickdraw** | github.com/quickdrawjs/quickdraw | MIT | Yes — plain ESM | ★561; npm 0.3.0 (2026-10-12). Pressure ink that *"breathes with stylus pressure, or with velocity for mouse users"*. **Palm rejection: "once a stylus is seen, fingers steer the camera and the pen draws."** |
| **rough.js** | github.com/rough-stuff/rough | MIT | Yes (UMD shipped) | ★21k; npm 4.6.6 (2023-11-20), last push 2024-07-28 — **stale**. Sketchy shape rendering. |

> **Note:** the **Web Ink API** (`navigator.ink`) is used by js-draw v1.30 but per
> its own CHANGELOG it *"only seems to be available in Chromium-based
> browsers"* — **not Safari/iPadOS**. Do not plan around it.

---

## 2. Infinite-canvas / whiteboard apps

| Project | URL | Licence | No-build? | Notes |
|---|---|---|---|---|
| **Excalidraw** | github.com/excalidraw/excalidraw | **MIT** | App needs a build; npm ships prebuilt `dist/prod/index.js` | ★134k; last push 2026-10-21. **The single best reference — and fully permissive.** Files worth reading: `snapping.ts` (`SnapCache`, `snapNewElement`, `getSnapLinesAtPointer`), `lasso.ts` (`LassoTrail`), `eraser.ts` (`EraserTrail`), `history.ts`. |
| **tldraw** | github.com/tldraw/tldraw | ⚠️ custom | No | ★51k. **Blocked** — see §0. |
| **drawnix** | github.com/plait-board/drawnix | MIT | No | ★15k; push 2026-09-08. |
| **weavejs** | github.com/InditexTech/weavejs | Apache-2.0 | No | ★249; push 2026-10-21. Has a `_penActive` palm-rejection flag. |
| **Quickdraw** | github.com/quickdrawjs/quickdraw | MIT | **Yes** | ★561. Explicitly positioned as *"an open-source tldraw alternative with no license fee"*. Closest thing to Inkpad's constraints. |
| **WBO** | github.com/lovasoa/whitebophir | AGPL-3.0 | Yes | ★2.7k. Read, don't copy. |
| **Konva** | github.com/konvajs/konva | MIT | **Yes** — `konva.min.js` UMD | ★15k; npm 10.9.0 (2026-10-15). Scene graph with transforms/anchors/hit detection. |
| **Paper.js** | github.com/paperjs/paper.js | MIT | **Yes** — `dist/paper-full.js` UMD | ★15k; npm 0.15.0 (2026-10-21). Best-in-class **vector hit-testing / boolean geometry** — the lasso primitive. |
| **Fabric.js** | github.com/fabricjs/fabric.js | MIT | ESM `dist/index.mjs`; **UMD unverified for v7** | ★31k; npm 7.4.0 (2026-05-18). |

### Excalidraw `history.ts` — verified source
Not snapshot-based. It is **delta + inverse**: `History` holds `undoStack`/`redoStack`
of `HistoryDelta`; `record(delta)` pushes `HistoryDelta.inverse(delta)`;
`undo()`/`redo()` pop one stack and push onto the other. It also **only clears
the redo stack on element changes**, not on app-state changes ("a simple click
(unselect) could lead to losing all the redo entries").

Inkpad's `createHistory()` + inverse-op design is structurally the same idea —
this is the production-scale confirmation of that approach, plus a good source
for the "coalesce a whole gesture into one history entry" nuance.

---

## 3. Note-taking apps with handwriting / PDF import

Almost all are copyleft (read for ideas only) or native.

| Project | URL | Licence | Notes |
|---|---|---|---|
| **Saber** | github.com/saber-notes/saber | GPL-3.0 | **Best reference for the highlighter compositing problem**: *"Its highlighter has no such issues. It utilizes canvas compositing to render the highlighter in a way that is consistent with/better than traditional paper, where it handles overlaps and maintains color consistency."* Also dark-mode ink inversion. |
| **SpeedyNote** | github.com/alpha-liu-01/SpeedyNote | GPL-3.0 | Closest analogue to Inkpad's goals: pressure-sensitive pen/marker/highlighter, **vector-based strokes**, stroke eraser with undo/redo, **two-finger pan, pinch-to-zoom, palm rejection**, paged notebooks + edgeless canvas + PDF backgrounds. |
| **Rnote** | github.com/flxzt/rnote | GPL-3.0 | xournal-style paper model (backgrounds, PDF import) with infinite canvas. |
| **Notate** | github.com/alexdremov/notate | **MIT** | ★55. The most permissively-licensed feature checklist: shape recognition with hold-to-snap (line/triangle/rect/circle/pentagon/hexagon), scribble-to-erase, three eraser modes (stroke/partial/lasso), rectangle+lasso selection with move/copy, unlimited undo/redo, **PDF export in vector or raster**, minimap, angle snapping. |
| **mobile-ink** | github.com/mathnotes-app/mobile-ink | Apache-2.0 | Production RN ink engine w/ "continuous canvas primitives". |
| **OpenNotes** | github.com/mathnotes-app/OpenNotes | Apache-2.0 | RN note app. |
| **OwlLuna** | github.com/owaisazmal/OwlLuna | MIT | Native iPad PencilKit app — UX reference only (toolbar, page management). |
| **NoteBerg** | github.com/thomasleuthold/NoteBerg | MIT | Lasso selection with move/resize/rotate/copy; unlimited undo/redo. |
| **AbelNotes** | github.com/abelnotes/abelnotes | AGPL-3.0 | AGPL + trademark restrictions. |
| **GoodNote clone** | github.com/trmviet0801/GoodNote | MIT | ★11; push 2025-06-03 — mostly stale. |
| **ink-away** (KOReader) | github.com/EmirErtorer/ink-away.koplugin | MIT | Stylus support with palm rejection on e-ink; its palm heuristic is readable. |

---

## 4. Shapes / snap / selection / undo

| Need | Project | Licence | Note |
|---|---|---|---|
| Shape snapping | **Excalidraw** `snapping.ts` | MIT | `SnapCache`, `getSnapLinesAtPointer`, `getReferenceSnapPoints`. |
| Shape autocorrect | **js-draw** `StationaryPenDetector` | MIT | Detects a stationary pen at stroke end → snaps to a shape. |
| Lasso | **Excalidraw** `lasso.ts` + **Paper.js** | MIT | |
| Lasso geometry | **martinez-polygon-clipping** | MIT | Boolean polygon ops → point-in-lasso. |
| Fast hit-testing | **rbush** | MIT | Spatial index for stroke/bbox queries. |
| Marquee select | **d3-brush** | ISC | UMD `dist/*.min.js`. |
| Pan/zoom | **d3-zoom** | ISC | Optional — Inkpad's `src/coord.js` already owns the viewport. |
| Sketchy shapes | **rough.js** | MIT | Stale but fine. |
| Arrows | **perfect-arrows** | MIT | ★2.8k; push 2023-01-08 — stale. |
| Undo/redo | **Excalidraw** `history.ts` / **immer** / **zundo** | MIT | Inkpad's own inverse-op history is already the right shape. |
| Hotkeys | **hotkeys-js** | MIT | `dist/hotkeys.min.js`. |
| Ids | **nanoid** | MIT | |
| Gesture arbitration | **fngr** | MIT | Modern PointerEvent gesture recogniser (tap/pan/pinch/longpress) with priority arbitration — a clean model for separating one-finger draw from two-finger pan. |
| Pointer capture hardening | **lite-pointer-tracker** | MIT | Single-file tracker with `lostpointercapture` recovery, macOS ghost-drag detection, stylus pressure/tilt passthrough. |

**Recommendation:** Excalidraw's `snapping.ts` + `lasso.ts` + `history.ts` and
js-draw's `Pen.ts` cover ~80% of a Notability-grade lasso/snap. `martinez` +
`rbush` are the two small MIT utilities that make a lasso fast.

---

## 5. PDF import / export (no-build)

| Need | Project | Licence | Artifact | Note |
|---|---|---|---|---|
| **PDF import** | **pdf.js** (`pdfjs-dist`) | **Apache-2.0** | `build/pdf.mjs` + `build/pdf.worker.mjs` + `cmaps/` + `standard_fonts/` + `wasm/` | ★54k; push 2026-10-21; **v6.4.299 (2026-10-03)**. The only viable PDF import path for a no-build app: page rasterization, the **text layer** (for searchable/annotated PDFs like Xournal++/AbelNotes), zoom/rotation — no bundler needed. The worker must be served from your own origin (fine) **and added to the service-worker precache list**. |
| **Vector PDF export** | **pdf-lib** | MIT | UMD `dist/pdf-lib.min.js` | ★8.7k; push 2024-07-17; npm 1.17.1 (2022-05-12) — dormant but stable. `PDFPage.drawSvgPath(path, { borderColor, borderWidth, borderOpacity, opacity, scale, x, y })` is **verified in the official API docs**. Perfect fit for Inkpad's vector model: emit each stroke as an SVG path. `PDFDocument.load()` + `embedPdf()` + `page.drawPage()` to *annotate* an imported PDF. |
| PDF export (alt) | **jsPDF** | MIT | UMD `dist/jspdf.umd.min.js` | ★31k; npm 4.2.1 (2026-03-17). More actively maintained, but raster/line-oriented. |
| Templates | **pdfme** | MIT | React-first | ★4.9k. |

**Gotchas:**
- PDF origin is **bottom-left**, canvas is **top-left** — flip Y, and compose
  with Inkpad's page↔screen mapping + zoom/pan.
- pdf.js v6's exact worker path and whether a `legacy/` build is needed for
  iPad Safari is **unverified**.
- martinez / rbush / rough.js v4.6.6 single-file UMD paths are **unverified**.
- `fabric` v7 UMD availability is **unverified** (npm `main` is empty).

---

## 6. Palm rejection / pen-vs-touch — the important section

**There is no reusable open-source palm-rejection library for the web.** I
searched "palm rejection web", "pointerType pen touch safari ipad", "apple
pencil palm rejection javascript" and GitHub code/repo search — nothing
shippable. The technique is ~20 lines. The value is in the reference
implementations.

### The three layers

1. **OS/hardware layer (best, but not web-controllable).**
   The W3C Pointer Events spec says: *"Some devices, operating systems and user
   agents may ignore the concurrent use of more than one type of pointer input
   to avoid accidental interactions… (a feature commonly referred to as 'palm
   rejection'). Currently, it is not possible for authors to suppress this
   behavior."* On iPad, `pointerType === 'touch'` events **are** suppressed by
   iPadOS while the Pencil is in contact — so iPad does some of the work. But
   it is not reliable during hover, and it is **not reliable for the hand that
   is already resting when the Pencil first touches down**.

2. **`isPrimary` filter.** Per the spec, a touch pointer is primary if the
   user touched the screen when no other touches were active. atrament's
   maintainer (jakubfiala) on issue #53: *"according to the Pointer Events
   spec, the `isPrimary` property is expected to be true only for pen inputs
   in devices which support palm rejection… It seems like the iPad does support
   this."* Fixed in **atrament v4.0.0 (Feb 2024)**.

3. **App-layer "pen mode" gate** — the pattern every serious app uses.

### Reference implementations (source-verified)

| Project | URL | Licence | What to copy |
|---|---|---|---|
| **Excalidraw `penMode`** | github.com/excalidraw/excalidraw/pull/4657 · issue #4202 | MIT | **The reference implementation.** Verified in current `master` `packages/excalidraw/components/App.tsx`:<br>• Auto-arm on first pen event: `if (!this.state.penDetected && event.pointerType === "pen") { penMode: true; penDetected: true; … }`<br>• Gate: `const allowOnPointerDown = !this.state.penMode \|\| event.pointerType !== "touch" \|\| activeTool is selection/lasso/text/image; if (!allowOnPointerDown) return;`<br>• **Blocks pinch-zoom while penMode is on**, because *"Often, I start to draw, my hand touches the screen first causing excalidraw to zoom in or out… the relative stroke width of the drawing is impacted."* Panning is kept.<br>• PR merged 2022-02-02. |
| **tldraw `isDirectDisplayPen`** | github.com/tldraw/tldraw/blob/main/packages/editor/src/lib/utils/pointer.ts | ⚠️ custom | Source verified: `if (e.pointerType !== 'pen') return false; return tlenv.isTouchDevice` — comment: *"implicit pointer capture… isn't reliably observable across browsers (notably WebKit/iPad). Instead we key off the device."* Useful pattern for telling an Apple Pencil from a desktop Wacom. |
| **inkandswitch/wrapper** | github.com/inkandswitch/wrapper | Unlicense | The definitive statement of the web limitation: *"On iPad, however, you can't get simultaneous input from fingers and Apple Pencil in the browser. It just doesn't work."* A native WKWebView wrapper that captures native touch+pencil and forwards it to JS (120 Hz finger / 240 Hz pencil). **Use as a diagnostic to compare native vs browser input latency.** |
| **weavejs** | github.com/InditexTech/weavejs/issues/1040 | Apache-2.0 | *"When drawing with Apple Pencil, the palm resting on the screen can generate `pointerdown` events with `pointerType: 'touch'`. These create unwanted dots or strokes. While iPadOS has built-in palm rejection, it's not 100% reliable in web views — this provides a defensive layer."* Plus `touch-action: none`. |
| **fieldnotes** | github.com/IrakliDevelop/fieldnotes | MIT | A dedicated `InputFilter` middleware: *"When a pen pointer is active, all touch events are suppressed"*, plus **deferred touch** (held until a move threshold is exceeded or `pointerUp` confirms a tap). |
| **Quickdraw** | github.com/quickdrawjs/quickdraw | MIT | *"**Palm rejection** — once a stylus is seen, fingers steer the camera and the pen draws."* |
| **atrament** | github.com/jakubfiala/atrament.js/issues/53 | MIT | The iPad "wrist-down causes 10 straight strokes" bug + the Pointer-Events/`isPrimary` fix in v4.0.0. |
| **ink-away** | github.com/EmirErtorer/ink-away.koplugin | MIT | Palm-rejection heuristic on e-ink. |
| **fngr** | npmjs.com/package/fngr | MIT | Modern PointerEvent gesture recogniser with priority arbitration — clean model for one-finger-draw vs two-finger-pan. |
| **lite-pointer-tracker** | npmjs.com/package/lite-pointer-tracker | MIT | Single-file tracker: `setPointerCapture`, `lostpointercapture` recovery, stylus pressure/tilt passthrough. |

### What does NOT work in Safari/iPadOS

- **`pointerrawupdate`** — spec-restricted to a **secure context** and **not
  implemented in Safari/iPadOS**. (Inkpad's `AGENTS.md` already encodes this.)
- **Web Ink API (`navigator.ink`)** — Chromium only.

### iPadOS system setting worth knowing
**Settings → Apple Pencil → Draw with Apple Pencil Only.** When ON, fingers
never draw in *any* app — including Safari. It is a global safety net that
complements (and does not replace) app-level palm rejection, because it also
stops the Pencil being used for UI navigation.

---

## 7. Is there an open-source Notability?

**No.** Notability is closed-source and proprietary. Its `.note` format is
proprietary and has only been reverse-engineered by third parties. There is no
open-source client component, SDK or renderer, and nothing in Notability can be
borrowed as source.

Reverse-engineering / format tools exist, but they are research tools, not
implementations — and most are unlicensed or copyleft:

| Project | URL | Licence |
|---|---|---|
| svg2notability | github.com/jvns/svg2notability | **No LICENSE file** — do not copy |
| notability-to-svg | github.com/HuyNguyenAu/notability-to-svg | GPL-3.0 |
| notability-notes-converter | github.com/dvdblk/notability-notes-converter | **No LICENSE file** |
| notability2pdf | github.com/steventango/notability2pdf | MIT |
| NotabilityViewer | github.com/GZhonghui/NotabilityViewer | MIT |
| Notability-Viewer | github.com/richardkrikler/Notability-Viewer | BSD-2-Clause |

**No notable open-source "Notability clone" exists.** Repos literally named
`NotabilityClone` have 0 stars and no verifiable licence. The only repo
self-describing as a web Notability clone is `github.com/ndunl075/freenote`
(MIT, 0 stars) — not worth studying.

The credible Notability-alikes (Saber, Rnote, Xournal++, SpeedyNote, Notate,
OpenNotes, OwlLuna, AbelNotes) are all copyleft or native. **None is a
permissively-licensed web/PWA Notability clone.** That gap is exactly why
Inkpad is not redundant.
