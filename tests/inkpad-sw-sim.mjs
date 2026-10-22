// inkpad-sw-sim.mjs — run sw.js against a mocked ServiceWorkerGlobalScope.
//
// WHY: the precache list can be checked by reading the file, but the fetch
// rules (network-first for navigations, cache-first for assets, no caching
// for cross-origin or robots.txt) can only be trusted if they actually run.
// This harness loads sw.js with mocked `self`, `caches` and `fetch`, fires
// the events and checks what the worker would really do.

import { readFileSync } from 'node:fs';

const SW = 'C:\\AI Projects\\chatability\\sw.js';
const SCOPE = 'https://example.test/inkpad/';
const SOURCE = readFileSync(SW, 'utf8');

// --- mock world -------------------------------------------------------------
const listeners = new Map();
const cacheStores = new Map();
let offline = false;
const networkHits = [];

class MockCache {
  constructor(name) {
    this.name = name;
    this.store = new Map();
    cacheStores.set(name, this);
  }
  async add(request) {
    const url = typeof request === 'string' ? request : request.url;
    const response = await mockFetch(url);
    if (!response.ok) throw new TypeError(`bad response for ${url}`);
    this.store.set(url, response);
  }
  async put(request, response) {
    const url = typeof request === 'string' ? request : request.url;
    this.store.set(url, response);
  }
  async match(request) {
    const url = typeof request === 'string' ? request : request.url;
    return this.store.get(url);
  }
}

const caches = {
  async open(name) {
    if (!cacheStores.has(name)) cacheStores.set(name, new MockCache(name));
    return cacheStores.get(name);
  },
  async keys() {
    return [...cacheStores.keys()];
  },
  async delete(name) {
    return cacheStores.delete(name);
  },
};

const self = {
  registration: { scope: SCOPE },
  location: new URL(`${SCOPE}sw.js`),
  clients: { claim: async () => true },
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  },
  skipWaiting() {
    self.skipped = true;
  },
  skipped: false,
};

async function mockFetch(url) {
  const href = typeof url === 'string' ? url : url.url;
  networkHits.push(href);
  if (offline) throw new TypeError('offline');
  const body = href.endsWith('.js') || href.endsWith('.mjs') ? '/* js */' : 'body';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

const mockConsole = { warn: () => {}, log: () => {}, error: () => {} };

// --- load sw.js -------------------------------------------------------------
new Function('self', 'caches', 'fetch', 'console', 'Request', 'Response', SOURCE)(
  self,
  caches,
  mockFetch,
  mockConsole,
  Request,
  Response,
);

function fire(type, event) {
  const handlers = listeners.get(type) || [];
  for (const fn of handlers) fn(event);
}

let checks = 0;
let failures = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// --- install ----------------------------------------------------------------
let waited = null;
fire('install', {
  waitUntil: (p) => {
    waited = p;
  },
});
await waited;

const CACHE_NAME = /const CACHE_NAME = '([^']+)'/.exec(SOURCE)[1];
const PRECACHE_COUNT = ((SOURCE.match(/const PRECACHE_PATHS = \[([\s\S]*?)\];/) || ['', ''])[1].match(/'[^']*'/g) || []).length;
const cache = cacheStores.get(CACHE_NAME);
check('install created the versioned cache', !!cache, CACHE_NAME);
check('install precached every file', cache.store.size === PRECACHE_COUNT, cache.store.size + ' of ' + PRECACHE_COUNT + ' entries');
check(
  'install stored the shell under the scope',
  cache.store.has(`${SCOPE}index.html`) && cache.store.has(`${SCOPE}`),
  'index.html + the app root',
);
check(
  'install stored the pdf.js worker',
  cache.store.has(`${SCOPE}vendor/pdfjs/pdf.worker.min.mjs`),
  'pdf.worker.min.mjs',
);
check(
  'every cached URL is under the scope',
  [...cache.store.keys()].every((u) => u.startsWith(SCOPE)),
  'no URL escapes /inkpad/',
);

// --- activate ---------------------------------------------------------------
let activated = null;
fire('activate', {
  waitUntil: (p) => {
    activated = p;
  },
});
await activated;
check('activate kept the current cache', cacheStores.has(CACHE_NAME));
check('activate deleted a stale cache', (await caches.keys()).length === 1);

// --- fetch: navigation, offline ---------------------------------------------
offline = true;
let responded = null;
fire('fetch', {
  request: new Request(`${SCOPE}`, { method: 'GET' }),
  respondWith: (p) => {
    responded = p;
  },
  waitUntil: () => {},
});
const navResponse = await responded;
check(
  'an offline navigation falls back to the cached shell',
  navResponse.status === 200 && (await navResponse.text()) === 'body',
  `status ${navResponse.status}`,
);

// --- fetch: asset, offline --------------------------------------------------
responded = null;
fire('fetch', {
  request: new Request(`${SCOPE}src/app.js`, { method: 'GET' }),
  respondWith: (p) => {
    responded = p;
  },
  waitUntil: () => {},
});
const assetResponse = await responded;
check(
  'an offline asset is served from the cache',
  assetResponse.status === 200 && (await assetResponse.text()) === '/* js */',
  `status ${assetResponse.status}`,
);

// --- fetch: asset, online (cache-first + revalidate) ------------------------
offline = false;
networkHits.length = 0;
responded = null;
let revalidated = null;
fire('fetch', {
  request: new Request(`${SCOPE}src/app.js`, { method: 'GET' }),
  respondWith: (p) => {
    responded = p;
  },
  waitUntil: (p) => {
    revalidated = p;
  },
});
await responded;
await revalidated;
check(
  'an online asset is served from the cache and revalidated',
  networkHits.includes(`${SCOPE}src/app.js`),
  `network hits: ${networkHits.length}`,
);

// --- fetch: navigation, online (network-first) -------------------------------
networkHits.length = 0;
responded = null;
fire('fetch', {
  request: new Request(`${SCOPE}`, { method: 'GET' }),
  respondWith: (p) => {
    responded = p;
  },
  waitUntil: () => {},
});
await responded;
check('an online navigation goes to the network', networkHits.includes(`${SCOPE}`));

// --- fetch: things the worker must NOT touch --------------------------------
const ignored = [
  ['a cross-origin request (the AI provider)', 'https://api.example.com/v1/chat'],
  ['a non-GET request', `${SCOPE}src/app.js`],
  ['robots.txt', `${SCOPE}robots.txt`],
  ['a blob: URL', 'blob:https://example.test/1234'],
];
for (const [label, url] of ignored) {
  responded = null;
  networkHits.length = 0;
  fire('fetch', {
    request: new Request(url, { method: label.startsWith('a non-GET') ? 'POST' : 'GET' }),
    respondWith: (p) => {
      responded = p;
    },
    waitUntil: () => {},
  });
  check(`the worker ignores ${label}`, responded === null);
}

// --- message ----------------------------------------------------------------
fire('message', { data: { type: 'SKIP_WAITING' } });
check('a SKIP_WAITING message wakes the waiting worker', self.skipped === true);

console.log('');
if (failures === 0) {
  console.log(`ALL ${checks} SIMULATION CHECKS PASSED`);
} else {
  console.log(`${failures} of ${checks} SIMULATION CHECKS FAILED`);
  process.exit(1);
}
