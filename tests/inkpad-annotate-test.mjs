// inkpad-annotate-test.mjs — tests for src/ai/annotate.js.
//
// WHY: the annotation parser is the boundary between a model's free text and
// real shapes on the page. It must accept the ways a model actually answers
// (code fences, a sentence before the JSON, one bad row) and must never throw:
// a bad reply is a normal answer, not a crash. The whitelist is the safety
// boundary, so an invented shape type can never reach createShapeStroke().
//
//   node tests/inkpad-annotate-test.mjs

import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const annotate = await import(pathToFileURL(join(SRC, 'ai', 'annotate.js')).href);

const {
  ANNOTATION_TYPES,
  MAX_ANNOTATIONS,
  MAX_LABEL_CHARS,
  annotationPrompt,
  parseAnnotations,
} = annotate;

let checks = 0;

function ok(cond, label) {
  checks += 1;
  if (!cond) {
    console.error(`FAILED: ${label}`);
    process.exit(1);
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, `${label} (got ${a}, want ${e})`);
}

function rejects(text, label) {
  const result = parseAnnotations(text);
  ok(result && result.ok === false, `${label} returns ok:false`);
  ok(typeof result.error === 'string' && result.error.length > 0, `${label} explains the failure`);
}

// --- the system prompt ------------------------------------------------------

console.log('part 1 — the annotation prompt');

const prompt = annotationPrompt();
ok(typeof prompt === 'string' && prompt.length > 100, 'annotationPrompt returns a system prompt');
for (const type of ANNOTATION_TYPES) {
  ok(prompt.includes(type), `the prompt names the ${type} type`);
}
ok(prompt.includes('0-1000'), 'the prompt explains the normalized grid');
ok(prompt.includes('0, 0'), 'the prompt says where the origin is');
ok(prompt.includes(String(MAX_ANNOTATIONS)), 'the prompt gives the annotation cap');
ok(prompt.includes(String(MAX_LABEL_CHARS)), 'the prompt gives the label cap');
ok(/only a json object/i.test(prompt), 'the prompt asks for JSON only');
ok(/do not wrap it in code fences/i.test(prompt), 'the prompt forbids code fences');

// --- the happy path ---------------------------------------------------------

console.log('part 2 — the happy path');

const happy = parseAnnotations(JSON.stringify({
  annotations: [
    { type: 'rect', x: 100, y: 120, w: 300, h: 80 },
    { type: 'ellipse', x: 10, y: 20, w: 30, h: 40 },
    { type: 'arrow', x: 400, y: 500, w: 100, h: 60 },
    { type: 'callout', x: 600, y: 700, w: 200, h: 50, label: 'Slope is 2' },
  ],
}));
eq(happy.ok, true, 'a valid reply parses');
eq(happy.annotations.length, 4, 'all four annotation types survive');
eq(happy.annotations[0], { type: 'rect', x: 100, y: 120, w: 300, h: 80 }, 'a rect is returned as numbers');
eq(happy.annotations[3].label, 'Slope is 2', 'a callout keeps its label');
eq(happy.annotations.filter((a) => a.type === 'callout').length, 1, 'the callout type is preserved');

const empty = parseAnnotations('{"annotations":[]}');
eq(empty, { ok: true, annotations: [] }, 'an empty annotations list is valid');

// --- tolerant extraction ----------------------------------------------------

console.log('part 3 — tolerant extraction');

const fenced = [
  '```json',
  '{"annotations":[{"type":"rect","x":1,"y":2,"w":3,"h":4,"label":"box"}]}',
  '```',
].join('\n');
eq(parseAnnotations(fenced).annotations[0].label, 'box', 'a fenced JSON block is read');

const prose = 'Here are the marks you asked for:\n{"annotations":[{"type":"arrow","x":5,"y":6,"w":7,"h":8}]}\nHope that helps!';
eq(parseAnnotations(prose).annotations[0].type, 'arrow', 'JSON surrounded by prose is found');

const proseBrace = 'Use {curly braces} in prose, then the answer: {"annotations":[{"type":"ellipse","x":9,"y":9,"w":9,"h":9}]}';
eq(parseAnnotations(proseBrace).annotations[0].type, 'ellipse', 'a stray brace in the prose does not hide the answer');

const arrayReply = '[{"type":"rect","x":1,"y":1,"w":2,"h":2}]';
eq(parseAnnotations(arrayReply).annotations.length, 1, 'a bare array of annotations is accepted');

const escaped = '{"annotations":[{"type":"callout","x":1,"y":1,"w":2,"h":2,"label":"use \\"x\\" and {y}"}]}';
eq(parseAnnotations(escaped).annotations[0].label, 'use "x" and {y}', 'braces and quotes inside a label survive');

// --- validation -------------------------------------------------------------

console.log('part 4 — validation');

const many = { annotations: Array.from({ length: 20 }, (_, i) => ({ type: 'rect', x: i, y: i, w: 10, h: 10 })) };
eq(parseAnnotations(JSON.stringify(many)).annotations.length, MAX_ANNOTATIONS, 'more than 12 annotations are capped at 12');

const clamped = parseAnnotations(JSON.stringify({
  annotations: [{ type: 'rect', x: -40, y: 1400, w: 2500, h: 0.5, label: '  many\nlines\there  ' }],
}));
eq(clamped.annotations[0].x, 0, 'a negative x is clamped to 0');
eq(clamped.annotations[0].y, 1000, 'a y over 1000 is clamped');
eq(clamped.annotations[0].w, 1000, 'a width over 1000 is clamped');
eq(clamped.annotations[0].h, 0.5, 'a small positive height is kept');
eq(clamped.annotations[0].label, 'many lines here', 'a label is flattened to one line');

const badType = parseAnnotations(JSON.stringify({
  annotations: [
    { type: 'circle', x: 1, y: 1, w: 2, h: 2 },
    { type: '', x: 1, y: 1, w: 2, h: 2 },
    { x: 1, y: 1, w: 2, h: 2 },
    { type: 'RECT', x: 1, y: 1, w: 2, h: 2 },
  ],
}));
eq(badType.ok, true, 'a list with invalid types still parses');
eq(badType.annotations.length, 1, 'unknown and missing types are dropped');
eq(badType.annotations[0].type, 'rect', 'a type is normalized to lower case');

const badNumbers = parseAnnotations(JSON.stringify({
  annotations: [
    { type: 'rect', x: 'nope', y: 1, w: 2, h: 2 },
    { type: 'rect', x: null, y: 1, w: 2, h: 2 },
    { type: 'rect', x: 1, y: 1, w: 0, h: 2 },
    { type: 'rect', x: 1, y: 1, w: 2, h: -2 },
    { type: 'rect', x: '10', y: '20', w: '30', h: '40' },
  ],
}));
eq(badNumbers.annotations.length, 1, 'non-finite, null and non-positive sizes are dropped');
eq(badNumbers.annotations[0], { type: 'rect', x: 10, y: 20, w: 30, h: 40 }, 'numeric strings are accepted');

const longLabel = 'x'.repeat(MAX_LABEL_CHARS + 50);
const short = parseAnnotations(JSON.stringify({
  annotations: [{ type: 'callout', x: 1, y: 1, w: 2, h: 2, label: longLabel }],
}));
eq(short.annotations[0].label.length, MAX_LABEL_CHARS, 'a long label is truncated to 80 characters');

const noLabel = parseAnnotations(JSON.stringify({
  annotations: [{ type: 'rect', x: 1, y: 1, w: 2, h: 2, label: '' }],
}));
eq('label' in noLabel.annotations[0], false, 'an empty label is omitted');

const badRows = parseAnnotations(JSON.stringify({
  annotations: [null, 'rect', 42, [], { type: 'rect', x: 1, y: 1, w: 2, h: 2 }],
}));
eq(badRows.annotations.length, 1, 'non-object rows are dropped, not fatal');

// --- failures never throw ---------------------------------------------------

console.log('part 5 — bad input never throws');

rejects('', 'an empty reply');
rejects('not json at all', 'plain garbage');
rejects('{"annotations": "nope"}', 'a non-array annotations field');
rejects('{"something":[]}', 'a missing annotations field');
rejects('{"annotations":[', 'unclosed JSON');
rejects('```json\nnot json\n```', 'a code fence with garbage inside');

for (const value of [null, undefined, 42, {}, [], true]) {
  const result = parseAnnotations(value);
  ok(result && result.ok === false && typeof result.error === 'string', `parseAnnotations(${String(value)}) fails without throwing`);
}

console.log(`ALL ${checks} CHECKS PASSED`);
