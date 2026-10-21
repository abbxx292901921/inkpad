# Tests

Every suite is a plain Node script — no test framework, no dependencies, no
build step. Run them all:

```bash
node tests/run-all.mjs
```

Or one at a time:

```bash
node tests/inkpad-phaseB-test.mjs
```

Each suite prints `ALL N CHECKS PASSED` and exits non-zero on the first
failure, so they work in CI as-is.

| Suite | Covers |
|---|---|
| `inkpad-phaseB-test.mjs` | the stroke model, the midpoint-forward renderer, history, hit-testing, the tool registry, the page model, line styles |
| `inkpad-phaseB-integration.mjs` | `src/canvas.js` driven with synthetic Pointer Events: palm rejection, squeeze-to-erase, pen hover, the pointer rules |
| `inkpad-storage-test.mjs` | `src/storage.js`: the IndexedDB schema, blobs, the pure record helpers (it fakes IndexedDB in Node) |
| `inkpad-export-test.mjs` | `src/export.js`: PNG export, bounds, the print view |
| `inkpad-library-test.mjs` | the library's pure helpers: sort, filter, the folder tree, date formatting |
| `inkpad-library-dom-test.mjs` | the library's render path, against a stub DOM |
| `inkpad-shapes-test.mjs` | `src/shapes.js`: the geometry, the snapping, the hit tests |
| `inkpad-transform-test.mjs` | `src/transform.js`: bounds, move/scale/rotate, the handles, the lasso |
| `inkpad-ruler-test.mjs` | the ruler's tick maths and the rotation dial's angles |
| `inkpad-sw-test.mjs` | `sw.js`: the precache list covers every app file, subpath safety, the manifest |

The suites locate the repo relative to themselves, so they work from any
checkout. `INKPAD_REPO` / `INKPAD_ROOT` override the location if you need it.

The browser-level checks (drawing, importing, the cards, the library) are
driven through the Chrome DevTools Protocol and are not part of this folder —
they need a browser and a local server.
