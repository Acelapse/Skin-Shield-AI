// Saves recordings in the browser's IndexedDB. Clips are too big for
// localStorage, which is limited to about 5 MB.

const DB = "skinshield";
const STORE = "clips";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => {
      db.close();
      resolve(req?.result);
    };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export const clipStore = {
  all: async () => ((await run("readonly", (s) => s.getAll())) || []).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)),
  put: (clip) => run("readwrite", (s) => s.put(clip)),
  remove: (id) => run("readwrite", (s) => s.delete(id)),
  clear: () => run("readwrite", (s) => s.clear()),
};
