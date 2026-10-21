// tools/gen-precache.mjs
//
// Regenerates the PRECACHE_PATHS array in sw.js from the files that are
// actually in the repo.
//
// WHY: the service worker must precache every app file, or the app breaks
// when it is opened offline. Hand-maintaining that list is a trap: add a
// module and forget to update sw.js and offline start fails silently.
//
//   node tools/gen-precache.mjs
//
// Run it after adding or removing a file under src/, assets/, icons/ or
// vendor/. The test suite fails if the list is stale.

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SW = join(root, 'sw.js');

// Directories whose contents are part of the app and must be precached.
const INCLUDE_DIRS = ['src', 'assets', 'icons', 'vendor'];
// Files at the repo root that are part of the app.
const INCLUDE_ROOT_FILES = ['index.html', 'manifest.json', 'theme.css'];
// Never precached: docs, policies, VCS, and the worker itself.
const EXCLUDE = new Set(['sw.js', 'robots.txt', 'README.md', 'AGENTS.md', 'LICENSE']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'design') {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = [];
for (const name of INCLUDE_ROOT_FILES) {
  const full = join(root, name);
  try {
    if (statSync(full).isFile()) files.push(full);
  } catch {
    // missing root file: skip
  }
}
for (const dir of INCLUDE_DIRS) {
  const full = join(root, dir);
  try {
    if (statSync(full).isDirectory()) walk(full, files);
  } catch {
    // directory not present: skip
  }
}

const paths = files
  .map((f) => relative(root, f).split(sep).join('/'))
  .filter((p) => !EXCLUDE.has(p))
  .sort();

const list = ['./', ...paths];

const source = readFileSync(SW, 'utf8');
const start = source.indexOf('const PRECACHE_PATHS = [');
const end = source.indexOf('];', start);
if (start < 0 || end < 0) {
  console.error('Could not find PRECACHE_PATHS in sw.js');
  process.exit(1);
}

// Pack the list onto long lines: 231 one-per-line entries would triple the
// size of sw.js, and the service worker should stay readable.
const lines = [];
let line = '';
for (const p of list) {
  const piece = `'${p}',`;
  if (line.length + piece.length > 140) {
    lines.push(line);
    line = '';
  }
  line += (line ? ' ' : '') + piece;
}
if (line) lines.push(line);

const replacement = `const PRECACHE_PATHS = [\n${lines.join('\n')}\n`;
const next = source.slice(0, start) + replacement + source.slice(end);

if (next === source) {
  console.log(`precache list is already up to date (${list.length} entries)`);
} else {
  writeFileSync(SW, next, 'utf8');
  console.log(`wrote ${list.length} precache entries to sw.js`);
}
