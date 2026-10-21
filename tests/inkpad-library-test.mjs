// Node test for the pure helpers in src/ui/library.js.
// No DOM: the module must be import-safe (no `document` at import time).

const LIB_URL = 'file:///C:/AI%20Projects/chatability/src/ui/library.js';

const { filterNotes, sortNotes, buildFolderTree, formatDate } = await import(LIB_URL);

let checks = 0;
const failures = [];

function ok(label, cond, extra = '') {
  checks += 1;
  if (!cond) failures.push(`${label}${extra ? ` — ${extra}` : ''}`);
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(label, a === e, `expected ${e}, got ${a}`);
}

// --- sortNotes --------------------------------------------------------------
const notes = [
  { id: 'a', title: 'Alpha', updatedAt: 100 },
  { id: 'c', title: 'Charlie', updatedAt: 300 },
  { id: 'b', title: 'Bravo', updatedAt: 200 },
];
const sorted = sortNotes(notes);
eq('sortNotes orders newest first', sorted.map((n) => n.id), ['c', 'b', 'a']);
eq('sortNotes does not mutate the input', notes.map((n) => n.id), ['a', 'c', 'b']);
eq('sortNotes tolerates a missing updatedAt', sortNotes([{ id: 'x' }, { id: 'y', updatedAt: 5 }]).map((n) => n.id), ['y', 'x']);
eq('sortNotes on an empty list', sortNotes([]), []);

// --- filterNotes ------------------------------------------------------------
eq('filterNotes with an empty query returns everything', filterNotes(notes, '').map((n) => n.id), ['a', 'c', 'b']);
eq('filterNotes is case-insensitive', filterNotes(notes, 'CHARLIE').map((n) => n.id), ['c']);
eq('filterNotes matches a prefix', filterNotes(notes, 'bra').map((n) => n.id), ['b']);
eq('filterNotes trims the query', filterNotes(notes, '   bra   ').map((n) => n.id), ['b']);
eq('filterNotes returns nothing for a miss', filterNotes(notes, 'zzz'), []);
eq('filterNotes matches the folder name', filterNotes([{ id: 'f', title: 'Notes', folderName: 'Math 220' }], 'math'), [{ id: 'f', title: 'Notes', folderName: 'Math 220' }]);
eq('filterNotes does not mutate the input', notes.length, 3);
eq('filterNotes handles a null query', filterNotes(notes, null).length, 3);

// --- buildFolderTree --------------------------------------------------------
const folders = [
  { id: '1', name: 'Zeta', color: '#ff0000', parentId: null, noteCount: 2 },
  { id: '2', name: 'Alpha', color: '#00ff00', parentId: null, noteCount: 0 },
  { id: '3', name: 'Math 220', color: '#af52de', parentId: '2', noteCount: 36 },
  { id: '4', name: 'Bio 161', color: '#a2845e', parentId: '2', noteCount: 4 },
  { id: '5', name: 'Orphan', color: '#8e8e93', parentId: 'nope', noteCount: 1 },
];
const tree = buildFolderTree(folders);
eq('buildFolderTree root names sorted', tree.map((n) => n.name), ['Alpha', 'Orphan', 'Zeta']);
eq('buildFolderTree nests children', tree[0].children.map((n) => n.name), ['Bio 161', 'Math 220']);
eq('buildFolderTree keeps the colour', tree[0].color, '#00ff00');
eq('buildFolderTree keeps the note count', tree[0].children[1].noteCount, 36);
eq('buildFolderTree node shape', Object.keys(tree[0]).sort(), ['children', 'color', 'id', 'name', 'noteCount']);
eq('buildFolderTree promotes an orphan to a root', tree[1].id, '5');
eq('buildFolderTree leaves a leaf childless', tree[0].children[0].children, []);

// A parent cycle must not hang and must not lose folders.
const cyclic = buildFolderTree([
  { id: 'x', name: 'X', parentId: 'y' },
  { id: 'y', name: 'Y', parentId: 'x' },
]);
eq('buildFolderTree survives a parent cycle', cyclic.map((n) => n.id).sort(), ['x', 'y']);

eq('buildFolderTree on an empty list', buildFolderTree([]), []);

// --- formatDate -------------------------------------------------------------
eq('formatDate formats the current year', formatDate(new Date(2026, 9, 21).getTime()), 'Oct 21, 2026');
eq('formatDate formats an older year', formatDate(new Date(2025, 9, 21).getTime()), 'Oct 21, 2025');
eq('formatDate formats a January date', formatDate(new Date(2026, 0, 5).getTime()), 'Jan 5, 2026');
eq('formatDate on 0', formatDate(0), '');
eq('formatDate on undefined', formatDate(undefined), '');
eq('formatDate on nonsense', formatDate('not a date'), '');

// --- report -----------------------------------------------------------------
if (failures.length) {
  console.error(`FAILED ${failures.length} of ${checks} checks:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`ALL ${checks} CHECKS PASSED`);
