#!/usr/bin/env node
// Benchmark the native SIPNET executable against the WebAssembly build.
//
// Cases cover the main model configurations exercised by the smoke tests, plus
// two long synthetic runs (climate and events tiled forward in time) that
// measure steady-state throughput with less startup noise.
//
// Native variants:
//   native -O0  the default `make` build (CFLAGS has -g and no -O flag)
//   native -O3  the same sources built with gcc -O3 (built here, in a temp dir)
// Native times are wall-clock for the whole process (spawn, file I/O, model).
// WASM times are measured in-process: "instantiate" (fresh module from an
// already-compiled .wasm) and "run" (writing inputs to MEMFS, main(), exit).
// Every WASM run's sipnet.out is checked against the native -O0 output.
//
// Usage: node tests/wasm/bench.mjs [--reps N] [--tiles N] [--markdown]

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadSipnet, readInputs, repoRoot, runSipnet } from './sipnet-wasm.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const reps = opt('--reps', 10);
const tiles = opt('--tiles', 10);
const markdown = argv.includes('--markdown');

const smokeDir = path.join(repoRoot, 'tests', 'smoke');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sipnet-bench-'));

// ---------------------------------------------------------------------------
// Benchmark cases

const smoke = (name, desc) => ({ name, desc, files: readInputs(path.join(smokeDir, name)) });

// Repeat climate + events `n` times, shifting years so the run is continuous
function tile(base, n) {
  const yearCol = (fields) => (fields.length >= 14 ? 1 : 0);  // optional location column
  const lines = (buf) => buf.toString().split('\n').filter((l) => l.trim() !== '');
  const climLines = lines(base.files['sipnet.clim']);
  const years = climLines.map((l) => {
    const f = l.trim().split(/\s+/);
    return Number(f[yearCol(f)]);
  });
  const span = Math.max(...years) - Math.min(...years) + 1;

  const shift = (srcLines, k, colFn) => srcLines.map((l) => {
    const f = l.trim().split(/\s+/);
    const c = colFn(f);
    f[c] = String(Number(f[c]) + k * span);
    return f.join('\t');
  });

  const clim = [];
  const events = [];
  const evLines = base.files['events.in'] ? lines(base.files['events.in']) : [];
  for (let k = 0; k < n; k++) {
    clim.push(...shift(climLines, k, yearCol));
    events.push(...shift(evLines, k, () => 0));
  }
  return {
    name: `${base.name} x${n}`,
    desc: `${base.desc}; ${n * span} years`,
    files: {
      ...base.files,
      'sipnet.clim': clim.join('\n') + '\n',
      'events.in': events.join('\n') + (events.length ? '\n' : ''),
    },
  };
}

const niwot = smoke('niwot', 'default model; 2 climate steps/day, 1998-2005');
const r1 = smoke('russell_1', 'events (irrigation, planting, harvest, tillage); 8 steps/day, 2016-2017');
const r2 = smoke('russell_2', 'nitrogen cycle + litter pool + fertilization');
const r3 = smoke('russell_3', 'growth resp + leaf water + litter pool, no water-hresp');
const r4 = smoke('russell_4', 'microbes + soil-temp phenology, no snow/GDD/events');
const cases = [niwot, r1, r2, r3, r4, tile(niwot, tiles), tile(r2, tiles)];

// ---------------------------------------------------------------------------
// Builds

function nativeO0() {
  const exe = path.join(repoRoot, 'sipnet');
  if (!fs.existsSync(exe)) {
    throw new Error("native ./sipnet not found; run 'make sipnet' first");
  }
  return exe;
}

function nativeO3() {
  const exe = path.join(tmp, 'sipnet-O3');
  const srcs = ['common', 'sipnet'].flatMap((d) => fs.readdirSync(path.join(repoRoot, 'src', d))
    .filter((f) => f.endsWith('.c'))
    .map((f) => path.join(repoRoot, 'src', d, f)));
  execFileSync(process.env.CC || 'gcc',
    ['-O3', '-Wno-c2x-extensions', `-I${path.join(repoRoot, 'src')}`, ...srcs, '-lm', '-o', exe]);
  return exe;
}

// ---------------------------------------------------------------------------
// Runners

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function prepareDir(c) {
  const dir = path.join(tmp, c.name.replace(/\W+/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(c.files)) fs.writeFileSync(path.join(dir, name), data);
  return dir;
}

function timeNative(exe, dir) {
  const times = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    const r = spawnSync(exe, ['-i', 'sipnet.in'], { cwd: dir, stdio: 'ignore' });
    times.push(performance.now() - t0);
    if (r.status !== 0) throw new Error(`${exe} failed in ${dir} (exit ${r.status})`);
  }
  return median(times);
}

async function timeWasm(sipnet, c, expectedOut) {
  const inst = [];
  const run = [];
  for (let i = 0; i < reps; i++) {
    const r = await runSipnet(sipnet, c.files);
    if (r.exitCode !== 0) throw new Error(`wasm run of ${c.name} failed:\n${r.log}`);
    if (r.outputs['sipnet.out'] !== expectedOut) {
      throw new Error(`wasm output for ${c.name} differs from native`);
    }
    inst.push(r.instantiateMs);
    run.push(r.runMs);
  }
  return { inst: median(inst), run: median(run) };
}

// ---------------------------------------------------------------------------

const sipnet = await loadSipnet();
const o0 = nativeO0();
const o3 = nativeO3();

// Warm up V8's tiers on the wasm module before timing anything
for (let i = 0; i < 3; i++) await runSipnet(sipnet, niwot.files);

const rows = [];
for (const c of cases) {
  const dir = prepareDir(c);
  const steps = c.files['sipnet.clim'].toString().split('\n').filter((l) => l.trim()).length;
  const tO0 = timeNative(o0, dir);
  const expectedOut = fs.readFileSync(path.join(dir, 'sipnet.out'), 'utf8');
  const tO3 = timeNative(o3, dir);
  const w = await timeWasm(sipnet, c, expectedOut);
  rows.push({ ...c, steps, tO0, tO3, ...w });
  if (!markdown) {
    console.error(`${c.name}: O0 ${tO0.toFixed(1)} ms, O3 ${tO3.toFixed(1)} ms, `
      + `wasm ${w.run.toFixed(1)} ms (+${w.inst.toFixed(1)} ms instantiate)`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Report

const cmd = (c, a) => {
  try { return execFileSync(c, a, { encoding: 'utf8' }).split('\n')[0].trim(); } catch { return 'n/a'; }
};
const cpu = os.cpus()[0]?.model ?? 'unknown CPU';
const env = [
  `CPU: ${cpu} (${os.cpus().length} threads), ${os.platform()} ${os.release()}`,
  `Native: ${cmd(process.env.CC || 'gcc', ['--version'])}`,
  `WASM: emcc ${cmd('emcc', ['--version']).match(/\) ([\d.]+)/)?.[1] ?? 'n/a'} (-O3); Node ${process.version}`,
  `Median of ${reps} runs per case`,
];

const f = (x) => x.toFixed(1);
const ratio = (r) => (r.run / r.tO3).toFixed(2);
console.log(env.map((l) => (markdown ? `- ${l}` : l)).join('\n'));
console.log('');
console.log('| Case | Configuration | Steps | Native -O0 (ms) | Native -O3 (ms) '
  + '| WASM run (ms) | WASM instantiate (ms) | WASM / native -O3 |');
console.log('|---|---|---:|---:|---:|---:|---:|---:|');
for (const r of rows) {
  console.log(`| ${r.name} | ${r.desc} | ${r.steps} | ${f(r.tO0)} | ${f(r.tO3)} `
    + `| ${f(r.run)} | ${f(r.inst)} | ${ratio(r)} |`);
}
