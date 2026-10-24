#!/usr/bin/env node
// Run the smoke tests (tests/smoke/*) through the WebAssembly build of SIPNET
// and compare outputs against the committed reference files, mirroring
// tests/smoke/run_smoke.sh. Nothing is written to the smoke test directories.
//
// Usage: node tests/wasm/run_smoke_wasm.mjs [wasm-dir]   (default: web/)

import fs from 'node:fs';
import path from 'node:path';

import { loadSipnet, readInputs, repoRoot, runSipnet } from './sipnet-wasm.mjs';

const smokeDir = path.join(repoRoot, 'tests', 'smoke');
const sipnet = await loadSipnet(process.argv[2]);

// Drop the first line of a config dump, which holds a timestamp
const stripConfigHeader = (s) => s.split('\n').slice(1).join('\n');

const cases = fs.readdirSync(smokeDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

let failures = 0;
for (const name of cases) {
  const dir = path.join(smokeDir, name);
  if (fs.existsSync(path.join(dir, 'skip'))) {
    console.log(`[${name}] skipped (forced pass)`);
    continue;
  }
  const result = await runSipnet(sipnet, readInputs(dir));
  if (result.exitCode !== 0) {
    console.log(`[${name}] ❌ SIPNET exited with code ${result.exitCode}`);
    console.log(result.log);
    failures++;
    continue;
  }

  const checks = [
    ['sipnet.out', (s) => s],
    ['events.out', (s) => s],
    ['sipnet.config', stripConfigHeader],
  ];
  for (const [file, normalize] of checks) {
    const refPath = path.join(dir, file);
    const expected = fs.existsSync(refPath) ? fs.readFileSync(refPath, 'utf8') : undefined;
    const actual = result.outputs[file];
    if (actual === undefined && file === 'events.out') {
      // Event output is only written when events are enabled
      continue;
    }
    if (expected === undefined || actual === undefined ||
        normalize(expected) !== normalize(actual)) {
      console.log(`[${name}] ❌ Differences found in ${file}`);
      failures++;
    } else {
      console.log(`[${name}] ✅ No differences found in ${file}`);
    }
  }
}

console.log(failures === 0 ? '\nAll WASM smoke tests passed'
                           : `\n${failures} WASM smoke check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
