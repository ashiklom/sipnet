// Web Worker that runs SIPNET (WebAssembly) off the main thread.
//
// Messages in:  { id, type: 'run', files: {name: text}, args: [...] }
//               { id, type: 'version' }
// Messages out: { id, ok: true, exitCode, log, outputs, runMs }
//               { id, ok: false, error }
//
// SIPNET keeps global state and calls exit() on bad input, so each run gets a
// fresh module instance; the .wasm is compiled once and re-instantiated.

import createSipnet from '../sipnet.mjs';

const wasmUrl = new URL('../sipnet.wasm', import.meta.url);
const wasmModule = WebAssembly.compileStreaming
  ? WebAssembly.compileStreaming(fetch(wasmUrl)).catch(
    async () => WebAssembly.compile(await (await fetch(wasmUrl)).arrayBuffer()))
  : fetch(wasmUrl).then((r) => r.arrayBuffer()).then((b) => WebAssembly.compile(b));

async function run(files, args) {
  const compiled = await wasmModule;
  let log = '';
  const mod = await createSipnet({
    print: (s) => { log += s + '\n'; },
    printErr: (s) => { log += s + '\n'; },
    instantiateWasm: (imports, done) => {
      WebAssembly.instantiate(compiled, imports).then((inst) => done(inst));
      return {};
    },
  });
  for (const [name, data] of Object.entries(files)) mod.FS.writeFile(name, data);

  const t0 = performance.now();
  let exitCode;
  try {
    exitCode = mod.callMain(args);
  } catch (e) {
    // exit() from inside SIPNET surfaces as an ExitStatus
    if (e && typeof e.status === 'number') exitCode = e.status;
    else throw e;
  }
  const runMs = performance.now() - t0;

  const outputs = {};
  for (const name of mod.FS.readdir('.')) {
    if (name === '.' || name === '..' || name in files) continue;
    if (mod.FS.isFile(mod.FS.stat(name).mode)) {
      outputs[name] = mod.FS.readFile(name, { encoding: 'utf8' });
    }
  }
  return { exitCode, log, outputs, runMs };
}

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === 'version') {
      const r = await run({}, ['--version']);
      self.postMessage({ id: msg.id, ok: true, ...r });
    } else if (msg.type === 'run') {
      const r = await run(msg.files, msg.args || ['-i', 'sipnet.in']);
      self.postMessage({ id: msg.id, ok: true, ...r });
    } else {
      throw new Error(`unknown message type ${msg.type}`);
    }
  } catch (e) {
    self.postMessage({ id: msg.id, ok: false, error: String(e && e.stack || e) });
  }
};
