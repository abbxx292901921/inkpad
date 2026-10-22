// sw.js — the offline layer for Inkpad.
//
// WHY: Inkpad is a static site with no backend, and people use it exactly
// where there is no signal — a lecture hall, a train, a basement. The worker
// precaches the whole app shell on install, so a cold start with no network
// still opens the notebook.
//
// Everything the app needs is on our own origin: the vendored pdf.js worker,
// the CMaps, the standard fonts and the WASM decoders live in vendor/pdfjs/
// and pdf.js fetches them BY URL at runtime, so that tree is precached too.
//
// SUBPATH SAFETY: the site is published at https://<user>.github.io/inkpad/, so
// every URL here is RELATIVE and resolved against self.registration.scope: a
// hardcoded "/index.html" would 404 under the subpath.
//
// This is a CLASSIC worker script, not an ES module: module service workers
// are not available everywhere and this one has to install everywhere.

// Bump CACHE_NAME on every deploy: it is what tells the browser that the
// old precache is stale and has to be rebuilt.
const CACHE_NAME = 'inkpad-v2';
const CACHE_PREFIX = 'inkpad-';
const PRECACHE_BATCH = 6;

// The app shell, precached on install. Every path is relative to the scope.
const PRECACHE_PATHS = [
'./', 'assets/logo-maskable.svg', 'assets/logo.svg', 'icons/favicon-32.png', 'icons/icon-180.png', 'icons/icon-192.png',
'icons/icon-512.png', 'icons/icon-maskable-512.png', 'index.html', 'manifest.json', 'src/app.js', 'src/canvas.js', 'src/coord.js',
'src/export.js', 'src/input.js', 'src/pages.js', 'src/pdf.js', 'src/shapes.js', 'src/storage.js', 'src/strokes.js', 'src/sw-register.js',
'src/tools.js', 'src/transform.js', 'src/ui/icons.js', 'src/ui/library.css', 'src/ui/library.js', 'src/ui/palette.js', 'src/ui/popover.js',
'src/ui/prompt.js', 'src/ui/rotation-dial.js', 'src/ui/ruler.css', 'src/ui/ruler.js', 'src/ui/selection.css', 'src/ui/selection.js',
'src/ui/shape-menu.css', 'src/ui/shape-menu.js', 'src/ui/stroke-panel.js', 'src/ui/toolbar.js', 'src/workspace.js', 'theme.css',
'vendor/pdfjs/LICENSE', 'vendor/pdfjs/cmaps/78-EUC-H.bcmap', 'vendor/pdfjs/cmaps/78-EUC-V.bcmap', 'vendor/pdfjs/cmaps/78-H.bcmap',
'vendor/pdfjs/cmaps/78-RKSJ-H.bcmap', 'vendor/pdfjs/cmaps/78-RKSJ-V.bcmap', 'vendor/pdfjs/cmaps/78-V.bcmap',
'vendor/pdfjs/cmaps/78ms-RKSJ-H.bcmap', 'vendor/pdfjs/cmaps/78ms-RKSJ-V.bcmap', 'vendor/pdfjs/cmaps/83pv-RKSJ-H.bcmap',
'vendor/pdfjs/cmaps/90ms-RKSJ-H.bcmap', 'vendor/pdfjs/cmaps/90ms-RKSJ-V.bcmap', 'vendor/pdfjs/cmaps/90msp-RKSJ-H.bcmap',
'vendor/pdfjs/cmaps/90msp-RKSJ-V.bcmap', 'vendor/pdfjs/cmaps/90pv-RKSJ-H.bcmap', 'vendor/pdfjs/cmaps/90pv-RKSJ-V.bcmap',
'vendor/pdfjs/cmaps/Add-H.bcmap', 'vendor/pdfjs/cmaps/Add-RKSJ-H.bcmap', 'vendor/pdfjs/cmaps/Add-RKSJ-V.bcmap',
'vendor/pdfjs/cmaps/Add-V.bcmap', 'vendor/pdfjs/cmaps/Adobe-CNS1-0.bcmap', 'vendor/pdfjs/cmaps/Adobe-CNS1-1.bcmap',
'vendor/pdfjs/cmaps/Adobe-CNS1-2.bcmap', 'vendor/pdfjs/cmaps/Adobe-CNS1-3.bcmap', 'vendor/pdfjs/cmaps/Adobe-CNS1-4.bcmap',
'vendor/pdfjs/cmaps/Adobe-CNS1-5.bcmap', 'vendor/pdfjs/cmaps/Adobe-CNS1-6.bcmap', 'vendor/pdfjs/cmaps/Adobe-CNS1-UCS2.bcmap',
'vendor/pdfjs/cmaps/Adobe-GB1-0.bcmap', 'vendor/pdfjs/cmaps/Adobe-GB1-1.bcmap', 'vendor/pdfjs/cmaps/Adobe-GB1-2.bcmap',
'vendor/pdfjs/cmaps/Adobe-GB1-3.bcmap', 'vendor/pdfjs/cmaps/Adobe-GB1-4.bcmap', 'vendor/pdfjs/cmaps/Adobe-GB1-5.bcmap',
'vendor/pdfjs/cmaps/Adobe-GB1-UCS2.bcmap', 'vendor/pdfjs/cmaps/Adobe-Japan1-0.bcmap', 'vendor/pdfjs/cmaps/Adobe-Japan1-1.bcmap',
'vendor/pdfjs/cmaps/Adobe-Japan1-2.bcmap', 'vendor/pdfjs/cmaps/Adobe-Japan1-3.bcmap', 'vendor/pdfjs/cmaps/Adobe-Japan1-4.bcmap',
'vendor/pdfjs/cmaps/Adobe-Japan1-5.bcmap', 'vendor/pdfjs/cmaps/Adobe-Japan1-6.bcmap', 'vendor/pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap',
'vendor/pdfjs/cmaps/Adobe-Korea1-0.bcmap', 'vendor/pdfjs/cmaps/Adobe-Korea1-1.bcmap', 'vendor/pdfjs/cmaps/Adobe-Korea1-2.bcmap',
'vendor/pdfjs/cmaps/Adobe-Korea1-UCS2.bcmap', 'vendor/pdfjs/cmaps/B5-H.bcmap', 'vendor/pdfjs/cmaps/B5-V.bcmap',
'vendor/pdfjs/cmaps/B5pc-H.bcmap', 'vendor/pdfjs/cmaps/B5pc-V.bcmap', 'vendor/pdfjs/cmaps/CNS-EUC-H.bcmap',
'vendor/pdfjs/cmaps/CNS-EUC-V.bcmap', 'vendor/pdfjs/cmaps/CNS1-H.bcmap', 'vendor/pdfjs/cmaps/CNS1-V.bcmap',
'vendor/pdfjs/cmaps/CNS2-H.bcmap', 'vendor/pdfjs/cmaps/CNS2-V.bcmap', 'vendor/pdfjs/cmaps/ETHK-B5-H.bcmap',
'vendor/pdfjs/cmaps/ETHK-B5-V.bcmap', 'vendor/pdfjs/cmaps/ETen-B5-H.bcmap', 'vendor/pdfjs/cmaps/ETen-B5-V.bcmap',
'vendor/pdfjs/cmaps/ETenms-B5-H.bcmap', 'vendor/pdfjs/cmaps/ETenms-B5-V.bcmap', 'vendor/pdfjs/cmaps/EUC-H.bcmap',
'vendor/pdfjs/cmaps/EUC-V.bcmap', 'vendor/pdfjs/cmaps/Ext-H.bcmap', 'vendor/pdfjs/cmaps/Ext-RKSJ-H.bcmap',
'vendor/pdfjs/cmaps/Ext-RKSJ-V.bcmap', 'vendor/pdfjs/cmaps/Ext-V.bcmap', 'vendor/pdfjs/cmaps/GB-EUC-H.bcmap',
'vendor/pdfjs/cmaps/GB-EUC-V.bcmap', 'vendor/pdfjs/cmaps/GB-H.bcmap', 'vendor/pdfjs/cmaps/GB-V.bcmap', 'vendor/pdfjs/cmaps/GBK-EUC-H.bcmap',
'vendor/pdfjs/cmaps/GBK-EUC-V.bcmap', 'vendor/pdfjs/cmaps/GBK2K-H.bcmap', 'vendor/pdfjs/cmaps/GBK2K-V.bcmap',
'vendor/pdfjs/cmaps/GBKp-EUC-H.bcmap', 'vendor/pdfjs/cmaps/GBKp-EUC-V.bcmap', 'vendor/pdfjs/cmaps/GBT-EUC-H.bcmap',
'vendor/pdfjs/cmaps/GBT-EUC-V.bcmap', 'vendor/pdfjs/cmaps/GBT-H.bcmap', 'vendor/pdfjs/cmaps/GBT-V.bcmap',
'vendor/pdfjs/cmaps/GBTpc-EUC-H.bcmap', 'vendor/pdfjs/cmaps/GBTpc-EUC-V.bcmap', 'vendor/pdfjs/cmaps/GBpc-EUC-H.bcmap',
'vendor/pdfjs/cmaps/GBpc-EUC-V.bcmap', 'vendor/pdfjs/cmaps/H.bcmap', 'vendor/pdfjs/cmaps/HKdla-B5-H.bcmap',
'vendor/pdfjs/cmaps/HKdla-B5-V.bcmap', 'vendor/pdfjs/cmaps/HKdlb-B5-H.bcmap', 'vendor/pdfjs/cmaps/HKdlb-B5-V.bcmap',
'vendor/pdfjs/cmaps/HKgccs-B5-H.bcmap', 'vendor/pdfjs/cmaps/HKgccs-B5-V.bcmap', 'vendor/pdfjs/cmaps/HKm314-B5-H.bcmap',
'vendor/pdfjs/cmaps/HKm314-B5-V.bcmap', 'vendor/pdfjs/cmaps/HKm471-B5-H.bcmap', 'vendor/pdfjs/cmaps/HKm471-B5-V.bcmap',
'vendor/pdfjs/cmaps/HKscs-B5-H.bcmap', 'vendor/pdfjs/cmaps/HKscs-B5-V.bcmap', 'vendor/pdfjs/cmaps/Hankaku.bcmap',
'vendor/pdfjs/cmaps/Hiragana.bcmap', 'vendor/pdfjs/cmaps/KSC-EUC-H.bcmap', 'vendor/pdfjs/cmaps/KSC-EUC-V.bcmap',
'vendor/pdfjs/cmaps/KSC-H.bcmap', 'vendor/pdfjs/cmaps/KSC-Johab-H.bcmap', 'vendor/pdfjs/cmaps/KSC-Johab-V.bcmap',
'vendor/pdfjs/cmaps/KSC-V.bcmap', 'vendor/pdfjs/cmaps/KSCms-UHC-H.bcmap', 'vendor/pdfjs/cmaps/KSCms-UHC-HW-H.bcmap',
'vendor/pdfjs/cmaps/KSCms-UHC-HW-V.bcmap', 'vendor/pdfjs/cmaps/KSCms-UHC-V.bcmap', 'vendor/pdfjs/cmaps/KSCpc-EUC-H.bcmap',
'vendor/pdfjs/cmaps/KSCpc-EUC-V.bcmap', 'vendor/pdfjs/cmaps/Katakana.bcmap', 'vendor/pdfjs/cmaps/LICENSE', 'vendor/pdfjs/cmaps/NWP-H.bcmap',
'vendor/pdfjs/cmaps/NWP-V.bcmap', 'vendor/pdfjs/cmaps/RKSJ-H.bcmap', 'vendor/pdfjs/cmaps/RKSJ-V.bcmap', 'vendor/pdfjs/cmaps/Roman.bcmap',
'vendor/pdfjs/cmaps/UniCNS-UCS2-H.bcmap', 'vendor/pdfjs/cmaps/UniCNS-UCS2-V.bcmap', 'vendor/pdfjs/cmaps/UniCNS-UTF16-H.bcmap',
'vendor/pdfjs/cmaps/UniCNS-UTF16-V.bcmap', 'vendor/pdfjs/cmaps/UniCNS-UTF32-H.bcmap', 'vendor/pdfjs/cmaps/UniCNS-UTF32-V.bcmap',
'vendor/pdfjs/cmaps/UniCNS-UTF8-H.bcmap', 'vendor/pdfjs/cmaps/UniCNS-UTF8-V.bcmap', 'vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap',
'vendor/pdfjs/cmaps/UniGB-UCS2-V.bcmap', 'vendor/pdfjs/cmaps/UniGB-UTF16-H.bcmap', 'vendor/pdfjs/cmaps/UniGB-UTF16-V.bcmap',
'vendor/pdfjs/cmaps/UniGB-UTF32-H.bcmap', 'vendor/pdfjs/cmaps/UniGB-UTF32-V.bcmap', 'vendor/pdfjs/cmaps/UniGB-UTF8-H.bcmap',
'vendor/pdfjs/cmaps/UniGB-UTF8-V.bcmap', 'vendor/pdfjs/cmaps/UniJIS-UCS2-H.bcmap', 'vendor/pdfjs/cmaps/UniJIS-UCS2-HW-H.bcmap',
'vendor/pdfjs/cmaps/UniJIS-UCS2-HW-V.bcmap', 'vendor/pdfjs/cmaps/UniJIS-UCS2-V.bcmap', 'vendor/pdfjs/cmaps/UniJIS-UTF16-H.bcmap',
'vendor/pdfjs/cmaps/UniJIS-UTF16-V.bcmap', 'vendor/pdfjs/cmaps/UniJIS-UTF32-H.bcmap', 'vendor/pdfjs/cmaps/UniJIS-UTF32-V.bcmap',
'vendor/pdfjs/cmaps/UniJIS-UTF8-H.bcmap', 'vendor/pdfjs/cmaps/UniJIS-UTF8-V.bcmap', 'vendor/pdfjs/cmaps/UniJIS2004-UTF16-H.bcmap',
'vendor/pdfjs/cmaps/UniJIS2004-UTF16-V.bcmap', 'vendor/pdfjs/cmaps/UniJIS2004-UTF32-H.bcmap', 'vendor/pdfjs/cmaps/UniJIS2004-UTF32-V.bcmap',
'vendor/pdfjs/cmaps/UniJIS2004-UTF8-H.bcmap', 'vendor/pdfjs/cmaps/UniJIS2004-UTF8-V.bcmap', 'vendor/pdfjs/cmaps/UniJISPro-UCS2-HW-V.bcmap',
'vendor/pdfjs/cmaps/UniJISPro-UCS2-V.bcmap', 'vendor/pdfjs/cmaps/UniJISPro-UTF8-V.bcmap', 'vendor/pdfjs/cmaps/UniJISX0213-UTF32-H.bcmap',
'vendor/pdfjs/cmaps/UniJISX0213-UTF32-V.bcmap', 'vendor/pdfjs/cmaps/UniJISX02132004-UTF32-H.bcmap',
'vendor/pdfjs/cmaps/UniJISX02132004-UTF32-V.bcmap', 'vendor/pdfjs/cmaps/UniKS-UCS2-H.bcmap', 'vendor/pdfjs/cmaps/UniKS-UCS2-V.bcmap',
'vendor/pdfjs/cmaps/UniKS-UTF16-H.bcmap', 'vendor/pdfjs/cmaps/UniKS-UTF16-V.bcmap', 'vendor/pdfjs/cmaps/UniKS-UTF32-H.bcmap',
'vendor/pdfjs/cmaps/UniKS-UTF32-V.bcmap', 'vendor/pdfjs/cmaps/UniKS-UTF8-H.bcmap', 'vendor/pdfjs/cmaps/UniKS-UTF8-V.bcmap',
'vendor/pdfjs/cmaps/V.bcmap', 'vendor/pdfjs/cmaps/WP-Symbol.bcmap', 'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
'vendor/pdfjs/standard_fonts/FoxitDingbats.pfb', 'vendor/pdfjs/standard_fonts/FoxitFixed.pfb',
'vendor/pdfjs/standard_fonts/FoxitFixedBold.pfb', 'vendor/pdfjs/standard_fonts/FoxitFixedBoldItalic.pfb',
'vendor/pdfjs/standard_fonts/FoxitFixedItalic.pfb', 'vendor/pdfjs/standard_fonts/FoxitSerif.pfb',
'vendor/pdfjs/standard_fonts/FoxitSerifBold.pfb', 'vendor/pdfjs/standard_fonts/FoxitSerifBoldItalic.pfb',
'vendor/pdfjs/standard_fonts/FoxitSerifItalic.pfb', 'vendor/pdfjs/standard_fonts/FoxitSymbol.pfb',
'vendor/pdfjs/standard_fonts/LICENSE_FOXIT', 'vendor/pdfjs/standard_fonts/LICENSE_LIBERATION',
'vendor/pdfjs/standard_fonts/LiberationSans-Bold.ttf', 'vendor/pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf',
'vendor/pdfjs/standard_fonts/LiberationSans-Italic.ttf', 'vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf',
'vendor/pdfjs/wasm/LICENSE_JBIG2', 'vendor/pdfjs/wasm/LICENSE_OPENJPEG', 'vendor/pdfjs/wasm/LICENSE_PDFJS_JBIG2',
'vendor/pdfjs/wasm/LICENSE_PDFJS_OPENJPEG', 'vendor/pdfjs/wasm/LICENSE_PDFJS_QCMS', 'vendor/pdfjs/wasm/LICENSE_QCMS',
'vendor/pdfjs/wasm/jbig2.wasm', 'vendor/pdfjs/wasm/jbig2_nowasm_fallback.js', 'vendor/pdfjs/wasm/openjpeg.wasm',
'vendor/pdfjs/wasm/openjpeg_nowasm_fallback.js', 'vendor/pdfjs/wasm/qcms_bg.wasm', 'vendor/pdfjs/wasm/quickjs-eval.js',
'vendor/pdfjs/wasm/quickjs-eval.wasm',
];

// The scope is the app root, e.g. https://host/inkpad/. Every URL is built from it.
const scopeBase = () =>
  (self.registration && self.registration.scope) || new URL('./', self.location).href;
const scopeUrl = (path) => new URL(path, scopeBase()).href;
// The cached shell: the offline fallback for a navigation.
const shellUrl = () => scopeUrl('index.html');

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

// Precache the shell file by file: addAll() is all-or-nothing, so one bad file breaks it.
async function precache() {
  const cache = await caches.open(CACHE_NAME);
  const failed = [];
  for (let i = 0; i < PRECACHE_PATHS.length; i += PRECACHE_BATCH) {
    await Promise.all(
      PRECACHE_PATHS.slice(i, i + PRECACHE_BATCH).map(async (path) => {
        try {
          // cache: 'reload' bypasses the HTTP cache: we want the bytes on
          // the server now, not a stale copy of the last release.
          await cache.add(new Request(scopeUrl(path), { cache: 'reload' }));
        } catch (err) {
          failed.push(path);
          console.warn('[inkpad-sw] precache failed:', path, err && err.message);
        }
      }),
    );
  }
  if (failed.length) console.warn(`[inkpad-sw] ${failed.length} file(s) could not be precached.`);
}

self.addEventListener('activate', (event) => {
  event.waitUntil(activate());
});

async function activate() {
  const names = await caches.keys();
  // Only our own caches are removed: another app on the same origin may have one.
  await Promise.all(
    names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME).map((n) => caches.delete(n)),
  );
  // Take over the pages that are already open: no reload on the first install.
  await self.clients.claim();
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Never touch the user's AI provider calls: those are cross-origin.
  if (url.origin !== self.location.origin) return;
  // blob: and data: URLs (imported images) are not cacheable here.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  // robots.txt is a crawler policy file. Do not cache it.
  if (url.pathname.endsWith('/robots.txt')) return;
  event.respondWith(
    request.mode === 'navigate' ? handleNavigate(event) : handleAsset(event),
  );
});

// Navigations are NETWORK-FIRST: a new deployment must be picked up as soon
// as the device is online. Offline, the cached shell is served instead.
async function handleNavigate(event) {
  const cache = await caches.open(CACHE_NAME);
  const request = event.request;
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      // Keep the cached shell fresh, but only for the app root.
      if (isShellUrl(request.url)) await cache.put(shellUrl(), response.clone());
      return response;
    }
    // A 404 for a navigation is an unknown in-app URL: serve the shell.
    return (await cache.match(shellUrl())) || response;
  } catch (err) {
    const cached = (await cache.match(shellUrl())) || (await cache.match(scopeUrl('./')));
    if (cached) return cached;
    return new Response('Inkpad is offline and the app shell is not cached yet.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

// True for the app root and index.html: the only URLs that may refresh the shell.
function isShellUrl(href) {
  const path = new URL(href).pathname;
  const base = new URL(scopeBase()).pathname;
  return path === base || path === base + 'index.html';
}

// The app's own code: the modules, the stylesheet and the manifest. These
// change on every deploy, so they are fetched from the network first.
function isAppCode(href) {
  const path = new URL(href).pathname;
  const base = new URL(scopeBase()).pathname;
  if (!path.startsWith(base)) return false;
  const rel = path.slice(base.length);
  return (
    rel.startsWith('src/') ||
    rel === 'theme.css' ||
    rel === 'manifest.json'
  );
}

// Network-first for the app's own code, with the cache as the offline
// fallback.
async function handleAppCode(cache, request) {
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic') {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

// Everything else is CACHE-FIRST with a background revalidate: the app opens
// instantly offline and the cache is refreshed for the next launch.
//
// EXCEPT the app's own code, which is NETWORK-FIRST: those files are small,
// they change on every deploy, and serving a stale module means the user is
// one reload behind the deployment. The big immutable things (the vendored
// pdf.js, the icons, the fonts) stay cache-first, so a deploy does not
// re-download five megabytes.
async function handleAsset(event) {
  const cache = await caches.open(CACHE_NAME);
  const request = event.request;
  if (isAppCode(request.url)) return handleAppCode(cache, request);
  const cached = await cache.match(request);
  const revalidate = fetch(request)
    .then(async (response) => {
      if (response && response.ok && response.type === 'basic') {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(revalidate);
    return cached;
  }
  const response = await revalidate;
  return response || new Response('', { status: 504, statusText: 'Offline' });
}

// The app asks the waiting worker to take over ("reload for the new version").
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
