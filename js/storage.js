// Gespeicherte Fahrten in der Browser-Datenbank (IndexedDB). Sie bleiben nur in diesem Browser
// auf diesem Laptop und gehen nirgends hin, bis du eine FIT-Datei herunterlädst.

const DB_NAME = 'trainerApp';
const STORE = 'fahrten';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => {
        const db = req.result;
        // Schliesst der Browser die Verbindung, beim nächsten Mal neu öffnen.
        db.onclose = () => { dbPromise = null; };
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

async function run(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    const fail = () => reject(tx.error || (req && req.error) || new Error('Speicherfehler im Browser'));
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

// Den Browser bitten, die Daten nicht bei Platzmangel zu löschen. Klappt nicht überall, schadet aber nicht.
let persistAsked = false;
async function askPersist() {
  if (persistAsked) return;
  persistAsked = true;
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch {
    // egal
  }
}

export async function saveRide(record) {
  askPersist();
  await run('readwrite', (s) => s.put(record));
}

export async function getRide(id) {
  return run('readonly', (s) => s.get(id));
}

export async function deleteRide(id) {
  await run('readwrite', (s) => s.delete(id));
}

// Für die Liste ohne die Messpunkte, neueste zuerst.
export async function listRides() {
  const all = await run('readonly', (s) => s.getAll());
  return all
    .map(({ samples, ...rest }) => ({ ...rest, sampleCount: samples ? samples.length : 0 }))
    .sort((a, b) => b.startedAt - a.startedAt);
}
