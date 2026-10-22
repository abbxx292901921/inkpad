// pdf.js — import a PDF into the document.
//
// WHAT HAPPENS: every page of the PDF is rasterised to a PNG and becomes a
// PAGE of the note, with the rasterised page as that page's background
// layer. So importing "hw3.pdf" gives you one notebook page per PDF page,
// and you write on top of them. That is exactly what Notability does.
//
// pdf.js is VENDORED under vendor/pdfjs/ and loaded as a plain ES module.
// There is no build step, no npm at runtime, and no network call — the
// worker, the CMaps, the standard fonts and the WASM decoders all come from
// our own origin.
//
// Licence: Apache-2.0 (vendor/pdfjs/LICENSE). Third-party licences for the
// WASM codecs are in vendor/pdfjs/wasm/.

import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';

// The worker must be served from our own origin. Resolve it relative to this
// module so the app works under the /inkpad/ subpath.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  '../vendor/pdfjs/pdf.worker.min.mjs',
  import.meta.url,
).href;

const CMAP_URL = new URL('../vendor/pdfjs/cmaps/', import.meta.url).href;
const FONT_URL = new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href;
const WASM_URL = new URL('../vendor/pdfjs/wasm/', import.meta.url).href;

// Longest edge of a rasterised PDF page, in pixels. A letter page at this
// size is ~1.3M pixels, which is safe on every iPad and keeps the PNG small
// enough to persist later.
const MAX_RASTER_EDGE = 1600;

export class PdfImportError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PdfImportError';
    this.cause = cause;
  }
}

function assetUrl(base, name) {
  return new URL(name, base).href;
}

// Read a PDF and return one entry per page:
//   { pageNumber, width, height, blob, url }
// `blob` is a PNG so IndexedDB can store it later; `url` is the object URL
// used to display it now.
export async function rasterizePdf(file, { onProgress } = {}) {
  let loadingTask;
  let doc;
  try {
    const buffer = await file.arrayBuffer();
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: FONT_URL,
      wasmUrl: WASM_URL,
      // Keep everything offline: no remote fetches for anything.
      useSystemFonts: false,
      disableAutoFetch: true,
      disableStream: false,
    });
    doc = await loadingTask.promise;
  } catch (err) {
    throw new PdfImportError(
      'That PDF could not be opened. It may be encrypted or damaged.',
      err,
    );
  }

  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const pdfPage = await doc.getPage(n);
      const base = pdfPage.getViewport({ scale: 1 });
      const longest = Math.max(base.width, base.height);
      const scale = longest > 0 ? Math.min(2, MAX_RASTER_EDGE / longest) : 1;
      const viewport = pdfPage.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const canvasContext = canvas.getContext('2d', { alpha: false });

      // pdf.js renders through a canvas CONTEXT, not the element: passing
      // `{ canvas }` leaves it with nothing to draw into.
      await pdfPage.render({ canvasContext, viewport }).promise;

      const blob = await new Promise((resolve) => {
        canvas.toBlob((b) => resolve(b), 'image/png');
      });
      if (!blob) throw new PdfImportError('Could not rasterise that PDF page.');

      pages.push({
        pageNumber: n,
        width: viewport.width,
        height: viewport.height,
        blob,
        url: URL.createObjectURL(blob),
      });

      // Release the canvas memory as soon as we have the bitmap.
      canvas.width = 0;
      canvas.height = 0;
      pdfPage.cleanup();

      if (onProgress) onProgress(n, doc.numPages);
    }
  } finally {
    // In pdf.js v6 `destroy()` lives on the loading task, not the proxy.
    if (loadingTask) {
      try {
        await loadingTask.destroy();
      } catch {
        // ignore: the worker may already be gone
      }
    }
  }
  return pages;
}

// The PDF.js text layer needs the font files; expose the URL builder so the
// worker can fetch individual standard fonts by name.
export { assetUrl };
