// tests/run-all.mjs — run every suite and report.
//
//   node tests/run-all.mjs
//
// Each suite prints its own "ALL N CHECKS PASSED" line and exits non-zero on
// the first failure. This runner just aggregates them.

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));

const suites = readdirSync(here)
  .filter((f) => f.endsWith('.mjs') && f !== 'run-all.mjs')
  .sort();

let failed = 0;
let total = 0;

for (const suite of suites) {
  const res = spawnSync(process.execPath, [join(here, suite)], { encoding: 'utf8' });
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
  const last = output.split('\n').filter(Boolean).pop() || '(no output)';
  const m = last.match(/ALL (\d+)\s*\w* CHECKS PASSED/);
  if (res.status === 0 && m) {
    total += Number(m[1]);
    console.log(`ok   ${suite.padEnd(32)} ${m[1]} checks`);
  } else {
    failed += 1;
    console.log(`FAIL ${suite}`);
    console.log(output.split('\n').slice(-12).map((l) => `     ${l}`).join('\n'));
  }
}

console.log(`\n${suites.length} suites, ${total} checks, ${failed} failing`);
process.exit(failed > 0 ? 1 : 0);
