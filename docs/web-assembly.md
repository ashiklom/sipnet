# Running SIPNET in the Browser (WebAssembly)

SIPNET's C sources compile unchanged to [WebAssembly](https://webassembly.org/) (WASM) with
[Emscripten](https://emscripten.org/). The WASM build produces output that is byte-identical to the
native build on every smoke test, and runs in any modern browser or in Node.js. This repository also
includes a small static website, in `web/`, that runs SIPNET in the browser, saves runs, and compares them.

## Building

Install and activate the Emscripten SDK (see the
[Emscripten docs](https://emscripten.org/docs/getting_started/downloads.html)):

```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh   # puts emcc on your PATH for this shell
```

Then, from the SIPNET root directory:

```bash
make wasm        # builds web/sipnet.mjs (JS loader) + web/sipnet.wasm
make wasm-smoke  # runs the smoke tests against the WASM build (needs Node.js)
```

`make wasm` compiles the same sources as `make sipnet`, with `-O3`. The output is an ES module that
exports a `createSipnet()` factory; `callMain()` runs SIPNET's `main()`, and `FS` is Emscripten's
in-memory file system, which holds the input and output files.

## Using the module from JavaScript

```js
import createSipnet from './web/sipnet.mjs';

let log = '';
const sipnet = await createSipnet({ print: (s) => { log += s + '\n'; } });

// Write the usual input files into the in-memory file system
sipnet.FS.writeFile('sipnet.in', configText);
sipnet.FS.writeFile('sipnet.param', paramText);
sipnet.FS.writeFile('sipnet.clim', climText);
sipnet.FS.writeFile('events.in', eventsText);

const exitCode = sipnet.callMain(['-i', 'sipnet.in']);  // same arguments as the CLI
const out = sipnet.FS.readFile('sipnet.out', { encoding: 'utf8' });
```

Things to know:

- **Use a fresh instance per run.** SIPNET keeps global state and is written to run once per process.
  Compile the `.wasm` once (`WebAssembly.compile`) and pass an `instantiateWasm` hook to `createSipnet`
  to re-instantiate it cheaply (about 1–2 ms); see `tests/wasm/sipnet-wasm.mjs` or `web/js/worker.js`.
- **Errors.** SIPNET calls `exit()` on bad input. `callMain` then returns the exit code, or throws an
  object with a numeric `status`. SIPNET writes its messages, including errors, to stdout, so capture
  them with the `print` callback.
- **In the browser**, run SIPNET in a Web Worker so long runs don't freeze the page.

## The web runner

```bash
make wasm-serve   # builds everything, then serves web/ at http://localhost:8000/
```

`make wasm-site` assembles the site without serving it: the WASM build, the smoke test inputs as
examples (`web/examples/`), and parameter and output descriptions extracted from these docs. The site
must be served over HTTP; opening `index.html` directly from disk does not work. Any static file server
will do.

In the web runner you can:

- pick one of the example sites, or upload your own `.param`, `.clim`, `events.in` and `sipnet.in` files
  (see [Model Inputs](user-guide/model-inputs.md));
- switch model options, edit parameter values (with descriptions and units from
  [Parameters](parameters.md)), and edit events;
- run SIPNET; each successful run is saved, with its inputs and outputs, in the browser's IndexedDB
  storage, so it persists across page reloads. Nothing is uploaded anywhere;
- compare up to 8 saved runs: plot any output variable (per time step, or daily, monthly or yearly
  means or sums), or its difference from a reference run, alongside summary statistics and a table of
  the inputs that differ between runs;
- download a run's `sipnet.out` or parameter file, or load a run back into the editor.

### Publishing to GitHub Pages

The web runner can be published with the documentation, at `app/` under the docs site. The built files
are kept out of the source branches; instead, they are pushed as a build artifact to a separate
`wasm-site-build` branch:

```bash
make wasm-publish                          # build and push the web runner
DRY_RUN=1 ./tools/publish_wasm_site.sh     # build the artifact commit locally, without pushing
```

`tools/publish_wasm_site.sh` refuses to publish from a tree with uncommitted changes (override with
`FORCE=1`); `REMOTE` and `BRANCH` choose where to push (default `origin` and `wasm-site-build`). Each
publish adds one commit that records the source commit in its message and in `BUILD_INFO.txt`.

Pushing to `wasm-site-build` runs the *WASM site artifact* workflow, which checks the artifact. On
success, it triggers *Publish Docs*, which builds the documentation, copies the latest web runner
build into `site/app/`, and deploys to GitHub Pages. Regular docs publishes from `master` also include
the latest web runner build. GitHub Pages must be set to deploy from GitHub Actions
(*Settings → Pages → Source*).

## Performance

`make wasm-bench` (`tests/wasm/bench.mjs`) times the native build against the WASM build. The
benchmark cases exercise the main model configurations covered by the smoke tests, plus two long
runs, made by repeating the climate and events forward in time, that measure throughput with less
startup noise. Niwot is a forest site with 2 climate steps per day (1998–2005); the Russell Ranch
cases are an agricultural site with 8 steps per day (2016–2017). Every WASM run's `sipnet.out` is
checked against the native output.

- **Native -O0** is the default `make` build (`-g`, no optimization); **native -O3** is the same
  sources built with `gcc -O3`. Native times are wall-clock times for the whole process, including
  process start-up and file I/O.
- **WASM run** is the time to write the inputs to the in-memory file system and run `main()`, in
  Node.js. **WASM init** is the time to create a fresh module instance from the compiled
  `.wasm`.

Results:

- CPU: Intel Xeon @ 2.80GHz (4 threads), Linux
- Native: gcc 13.3.0
- WASM: emcc 6.0.13 (`-O3`); Node v22.22.0
- Median of 10 runs per case

Times in milliseconds; *Ratio* is WASM run time ÷ native -O3 time:

| Case | Configuration | Steps | Native -O0 | Native -O3 | WASM run | WASM init | Ratio |
|---|---|---:|---:|---:|---:|---:|---:|
| niwot | default options | 5,237 | 47.3 | 43.7 | 107.5 | 1.9 | 2.46 |
| russell_1 | events | 5,848 | 52.3 | 49.2 | 121.0 | 1.3 | 2.46 |
| russell_2 | nitrogen cycle, litter pool, fertilization | 5,848 | 51.9 | 51.6 | 124.8 | 1.1 | 2.42 |
| russell_3 | growth resp., leaf water, litter pool, no water-limited Rh | 5,848 | 50.4 | 48.4 | 119.7 | 0.9 | 2.47 |
| russell_4 | microbes, soil-temp. phenology; no snow, GDD or events | 5,848 | 50.4 | 51.3 | 119.8 | 2.2 | 2.34 |
| niwot ×10 | default options, 80 years | 52,370 | 372.5 | 368.9 | 1068.9 | 1.1 | 2.90 |
| russell_2 ×10 | as russell_2, 20 years | 58,480 | 454.9 | 419.4 | 1424.8 | 0.9 | 3.40 |

The same WASM build in headless Chromium 153 on the same machine (median of 10 runs) took 100 ms for
niwot, 131 ms for russell_2 and 1052 ms for niwot ×10, in line with Node.js.

Takeaways:

- WASM is about **2.3–2.5× slower** than native for the smoke-test runs and about **3–3.4×** slower
  for the long runs. In absolute terms it is still fast: a typical multi-year run takes about 0.1 s in
  the browser, and an 80-year run about 1 s.
- Model configuration has little effect; the relative cost is similar across all configurations.
- Native `-O0` and `-O3` take about the same time, so SIPNET's run time is dominated by reading and
  writing text files, not by the model calculations.
- Profiling the WASM build (niwot x10) shows that about 45% of the time goes to `fscanf` parsing the
  climate file. The C library's number parser uses `long double`, which WASM supports only as
  software-emulated 128-bit floating point. Writing `sipnet.out` takes about another 25%. Model
  calculations are a small share. A faster climate-file reader would close much of the gap with
  native.
