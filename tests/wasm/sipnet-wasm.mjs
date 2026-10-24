// Helpers for running the WebAssembly build of SIPNET (web/sipnet.mjs) from
// Node. Used by the wasm smoke tests and the native-vs-wasm benchmark.
//
// SIPNET keeps global state (the run context, event lists, open files) and
// calls exit() on bad input, so every run gets a fresh module instance. The
// .wasm binary is compiled once and re-instantiated, which is cheap.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');
export const defaultWasmDir = path.join(repoRoot, 'web');

// Load the Emscripten factory and compile the .wasm once
export async function loadSipnet(wasmDir = defaultWasmDir) {
  const jsPath = path.join(wasmDir, 'sipnet.mjs');
  const wasmPath = path.join(wasmDir, 'sipnet.wasm');
  if (!fs.existsSync(jsPath) || !fs.existsSync(wasmPath)) {
    throw new Error(`WASM build not found in ${wasmDir}; run 'make wasm' first`);
  }
  const { default: createSipnet } = await import(pathToFileURL(jsPath).href);
  const wasmModule = await WebAssembly.compile(fs.readFileSync(wasmPath));
  return { createSipnet, wasmModule };
}

// Run SIPNET once.
//   files: { name: string | Uint8Array } written to the module's working dir
//   args:  command-line arguments (argv[1..])
// Returns { exitCode, log, outputs, instantiateMs, runMs }, where outputs holds
// every file present after the run that was not an input.
export async function runSipnet({ createSipnet, wasmModule }, files,
                                args = ['-i', 'sipnet.in']) {
  let log = '';
  const t0 = performance.now();
  const mod = await createSipnet({
    print: (s) => { log += s + '\n'; },
    printErr: (s) => { log += s + '\n'; },
    instantiateWasm: (imports, done) => {
      WebAssembly.instantiate(wasmModule, imports).then((inst) => done(inst));
      return {};
    },
  });
  const t1 = performance.now();

  for (const [name, data] of Object.entries(files)) {
    mod.FS.writeFile(name, data);
  }

  let exitCode;
  const savedExitCode = process.exitCode;
  try {
    exitCode = mod.callMain(args);
  } catch (e) {
    // exit() from deep inside SIPNET surfaces as an ExitStatus
    if (e && typeof e.status === 'number') {
      exitCode = e.status;
    } else {
      throw e;
    }
  }
  // Emscripten sets process.exitCode on exit(); don't leak that into Node
  process.exitCode = savedExitCode;
  const t2 = performance.now();

  const outputs = {};
  for (const name of mod.FS.readdir('.')) {
    if (name === '.' || name === '..' || name in files) continue;
    const stat = mod.FS.stat(name);
    if (mod.FS.isFile(stat.mode)) {
      outputs[name] = mod.FS.readFile(name, { encoding: 'utf8' });
    }
  }

  return { exitCode, log, outputs, instantiateMs: t1 - t0, runMs: t2 - t1 };
}

// Read the input files of a smoke-test style directory
export function readInputs(dir) {
  const files = {};
  for (const name of ['sipnet.in', 'sipnet.param', 'sipnet.clim', 'events.in']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) files[name] = fs.readFileSync(p);
  }
  return files;
}
