// inkpad-sw-test.mjs — verify the Inkpad service worker's precache list.
//
// Run:  node inkpad-sw-test.mjs
//
// WHY: the precache list in sw.js is a hand-maintained list of ~230 files, so
// it drifts the moment somebody adds a module to src/. This test walks the
// REAL repo, works out every file the app needs in order to open offline,
// and compares that against the list inside sw.js. It also checks the
// subpath safety of the URLs (the app is served from /inkpad/, so no
// absolute paths are allowed) and the shape of manifest.json.

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO = 'C:\\AI Projects\\chatability';
const SW_PATH = join(REPO, 'sw.js');
const MANIFEST_PATH = join(REPO, 'manifest.json');

// Directory trees that ARE the app and must be precached, recursively.
const APP_DIRS = ['src', 'assets', 'icons', 'vendor/pdfjs'];
// Root files that ARE the app.
const APP_FILES = ['index.html', 'manifest.json', 'theme.css'];
// Root entries that are NOT shipped to the browser: sources, docs, policy
// files. Note this is a ROOT-level exclusion: the nested LICENSE files
// inside vendor/pdfjs/ are part of the vendored tree and stay precached.
const SKIP_ROOT = new Set([
  '.git',
  '.github',
  '.gitignore',
  'design',
  'tools',
  'node_modules',
  'README.md',
  'AGENTS.md',
  'LICENSE',
  'robots.txt',
  'sw.js',
]);

let checks = 0;
let failures = 0;

function check(name, ok, detail = '') {
  checks += 1;
  if (ok) {
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(relative(REPO, full).split(sep).join('/'));
  }
  return out;
}

// --- 1. what the app needs --------------------------------------------------
const allFiles = walk(REPO);
const expected = new Set();
for (const file of allFiles) {
  const top = file.includes('/') ? file.split('/')[0] : file;
  if (SKIP_ROOT.has(top)) continue;
  const isAppFile = APP_FILES.includes(file);
  const isAppDir = APP_DIRS.some((dir) => file.startsWith(`${dir}/`));
  if (isAppFile || isAppDir) expected.add(file);
}

// --- 2. what sw.js says -----------------------------------------------------
const swSource = existsSync(SW_PATH) ? readFileSync(SW_PATH, 'utf8') : '';

function extractPrecachePaths(source) {
  const marker = 'PRECACHE_PATHS';
  const at = source.indexOf(marker);
  if (at < 0) return null;
  const open = source.indexOf('[', at);
  const close = source.indexOf('];', open);
  if (open < 0 || close < 0) return null;
  const body = source.slice(open + 1, close);
  return [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

const precache = extractPrecachePaths(swSource) || [];
const precacheSet = new Set(precache);

// Strip comments so the source checks only look at real code.
const code = swSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

console.log('Inkpad service worker — precache check');
console.log(`repo: ${REPO}`);
console.log(`app files expected: ${expected.size}`);
console.log(`precache entries:   ${precache.length}`);
console.log('');

// --- 3. the checks ----------------------------------------------------------
check('sw.js exists', existsSync(SW_PATH));
check('sw.js declares a PRECACHE_PATHS array', precache.length > 0, `${precache.length} entries`);

// sw.js is a classic worker script: it must parse as a plain script body.
let swParses = true;
let swParseError = '';
try {
  new Function(swSource);
} catch (err) {
  swParses = false;
  swParseError = err.message;
}
check('sw.js parses as a classic worker script', swParses, swParseError);

const missing = [...expected].filter((p) => !precacheSet.has(p)).sort();
check(
  'every app file is precached',
  missing.length === 0,
  missing.length ? `${missing.length} missing` : `${expected.size} files covered`,
);
if (missing.length) {
  for (const path of missing) console.log(`          missing: ${path}`);
}

// './' is the app root (a directory request); every other entry is a file.
const extras = precache.filter((p) => p !== './' && !expected.has(p)).sort();
check(
  'every precache entry exists in the repo',
  extras.length === 0,
  extras.length ? `${extras.length} unknown` : 'no unknown entries',
);
if (extras.length) {
  for (const path of extras) console.log(`          unknown: ${path}`);
}

const absolute = precache.filter((p) => p.startsWith('/'));
check(
  'no precache path is absolute',
  absolute.length === 0,
  absolute.length ? absolute.join(', ') : 'all paths are relative',
);

const escaping = precache.filter((p) => p.includes('..') || p.includes('\\'));
check(
  'no precache path escapes the scope',
  escaping.length === 0,
  escaping.length ? escaping.join(', ') : 'no ".." and no backslashes',
);

const dupes = precache.filter((p, i) => precache.indexOf(p) !== i);
check('no duplicate precache entries', dupes.length === 0, dupes.join(', ') || 'none');

// Subpath safety in the code itself: no new URL('/...', base), no absolute
// http(s) URL baked into the worker.
check(
  'no absolute URL is built in the worker',
  !/new URL\(\s*['"]\//.test(code) && !/['"]https?:\/\//.test(code),
  'every URL comes from the registration scope',
);
check(
  'the worker resolves URLs against the registration scope',
  code.includes('registration.scope'),
  'self.registration.scope',
);
check(
  'the worker never caches robots.txt',
  code.includes('robots.txt'),
  'robots.txt is skipped',
);
check(
  'the worker answers SKIP_WAITING',
  code.includes('SKIP_WAITING') && code.includes('skipWaiting'),
  'message handler present',
);
check(
  'the worker only handles same-origin GETs',
  code.includes("request.method !== 'GET'") && code.includes('url.origin !== self.location.origin'),
  'GET + same origin only',
);

// --- 4. the registration module --------------------------------------------
const regPath = join(REPO, 'src', 'sw-register.js');
const regSource = existsSync(regPath) ? readFileSync(regPath, 'utf8') : '';
check('src/sw-register.js exists', existsSync(regPath));
check(
  'src/sw-register.js exports registerServiceWorker',
  /export function registerServiceWorker\b/.test(regSource),
);
check(
  'src/sw-register.js derives the sw URL from import.meta.url',
  regSource.includes("new URL('../sw.js', import.meta.url)"),
);
check(
  'src/sw-register.js only registers in a secure context',
  regSource.includes('isSecureContext'),
);
check(
  'src/sw-register.js is itself precached',
  precacheSet.has('src/sw-register.js'),
);

// --- 5. the manifest --------------------------------------------------------
let manifest = null;
let manifestError = '';
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
} catch (err) {
  manifestError = err.message;
}
check('manifest.json parses', manifest !== null, manifestError);
if (manifest) {
  for (const key of [
    'id',
    'name',
    'short_name',
    'description',
    'start_url',
    'scope',
    'display',
    'orientation',
    'background_color',
    'theme_color',
    'icons',
    'categories',
  ]) {
    check(`manifest.json has "${key}"`, manifest[key] !== undefined);
  }
  check('manifest.json display is standalone', manifest.display === 'standalone');
  const relativeKeys = ['id', 'start_url', 'scope'];
  const absoluteKeys = relativeKeys.filter((k) => String(manifest[k]).startsWith('/'));
  check(
    'manifest.json id/start_url/scope are relative',
    absoluteKeys.length === 0,
    absoluteKeys.join(', ') || 'relative to the manifest URL',
  );
  const sizes = (manifest.icons || []).map((i) => i.sizes);
  check(
    'manifest.json ships 192, 512 and a maskable 512',
    sizes.includes('192x192') && sizes.includes('512x512') && (manifest.icons || []).some((i) => i.purpose === 'maskable'),
    sizes.join(' '),
  );
  const iconFiles = (manifest.icons || []).map((i) => i.src);
  const missingIcons = iconFiles.filter((src) => !existsSync(join(REPO, src)));
  check('every manifest icon exists', missingIcons.length === 0, missingIcons.join(', ') || 'all present');
}

// --- 6. size budget ---------------------------------------------------------
const swLines = swSource.split('\n').length;
check('sw.js stays under 300 lines', swLines <= 300, `${swLines} lines`);

console.log('');
if (failures === 0) {
  console.log(`ALL ${checks} CHECKS PASSED`);
  process.exit(0);
} else {
  console.log(`${failures} of ${checks} CHECKS FAILED`);
  process.exit(1);
}
