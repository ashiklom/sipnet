// Browser storage for saved runs, using IndexedDB.
//
// Stores:
//   runs     run metadata: name, site, flags, parameter values, ...  (small)
//   outputs  { id, out, eventsOut, log }  (large; loaded only when needed)
//   inputs   uploaded input files keyed by content hash, so a run made from
//            uploaded climate data can be re-loaded later

const DB_NAME = 'sipnet-wasm';
const DB_VERSION = 1;

let dbPromise;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('runs', { keyPath: 'id', autoIncrement: true });
        d.createObjectStore('outputs', { keyPath: 'id' });
        d.createObjectStore('inputs', { keyPath: 'hash' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function tx(stores, mode, fn) {
  const t = (await db()).transaction(stores, mode);
  const finished = new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  const result = await fn(...stores.map((s) => t.objectStore(s)));
  await finished;
  return result;
}

export async function saveRun(meta, output) {
  return tx(['runs', 'outputs'], 'readwrite', async (runs, outputs) => {
    const id = await done(runs.add(meta));
    outputs.put({ id, ...output });
    return id;
  });
}

export const listRuns = () => tx(['runs'], 'readonly', (runs) => done(runs.getAll()));
export const getOutput = (id) => tx(['outputs'], 'readonly', (o) => done(o.get(id)));

export async function updateRun(id, changes) {
  return tx(['runs'], 'readwrite', async (runs) => {
    const meta = await done(runs.get(id));
    runs.put({ ...meta, ...changes });
  });
}

export async function deleteRun(id) {
  return tx(['runs', 'outputs'], 'readwrite', (runs, outputs) => {
    runs.delete(id);
    outputs.delete(id);
  });
}

export async function deleteAll() {
  return tx(['runs', 'outputs', 'inputs'], 'readwrite', (runs, outputs, inputs) => {
    runs.clear();
    outputs.clear();
    inputs.clear();
  });
}

export const saveInput = (rec) => tx(['inputs'], 'readwrite', (s) => done(s.put(rec)));
export const getInput = (hash) => tx(['inputs'], 'readonly', (s) => done(s.get(hash)));
