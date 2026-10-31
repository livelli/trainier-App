// Legt jede gespeicherte Fahrt zusätzlich als Datei in einen Ordner auf dem Laptop
// (FIT-Datei und JSON mit allen Messpunkten). Den Ordner wählst du einmal aus; Chrome merkt sich ihn.
// Die Daten verlassen dabei den Laptop nicht.

const DB_NAME = 'trainerAppOrdner';
const STORE = 'kv';
const KEY = 'ordner';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => {
        const db = req.result;
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

export function supported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

// Der gewählte Ordner, im Speicher gehalten, damit die Freigabe-Abfrage direkt im Klick passieren kann.
let current = null; // { handle, token, name }

export async function load() {
  if (!supported()) return null;
  current = (await run('readonly', (s) => s.get(KEY))) || null;
  return current;
}

export function folderName() {
  return current ? current.name : null;
}

export async function permission(ask = false) {
  if (!current) return 'none';
  const opts = { mode: 'readwrite' };
  let p = await current.handle.queryPermission(opts);
  // Nachfragen geht nur direkt nach einem Klick.
  if (p === 'prompt' && ask) p = await current.handle.requestPermission(opts);
  return p;
}

export async function choose() {
  const handle = await window.showDirectoryPicker({ id: 'trainer-fahrten', mode: 'readwrite', startIn: 'documents' });
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const next = { handle, token, name: handle.name || 'Ordner' };
  await run('readwrite', (s) => s.put(next, KEY));
  current = next;
  return next;
}

export async function forget() {
  await run('readwrite', (s) => s.delete(KEY));
  current = null;
}

// Welche Fahrten schon in genau diesem Ordner liegen (bei neuem Ordner wieder alle).
async function writtenIds(f) {
  return new Set((await run('readonly', (s) => s.get(`geschrieben:${f.token}`))) || []);
}

async function markWritten(f, ids) {
  await run('readwrite', (s) => s.put([...ids], `geschrieben:${f.token}`));
}

async function writeFile(f, name, data) {
  const fh = await f.handle.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    await w.write(data);
    await w.close();
  } catch (err) {
    await w.abort().catch(() => {});
    throw err;
  }
}

// Schreibt alle noch fehlenden Fahrten. rides: Liste mit id; getFull(id) liefert die ganze Fahrt.
// Gibt { written, failed, missing } zurück; ohne Freigabe wird nichts geschrieben.
export async function sync({ ids, getFull, encode, fileBase, ask = false }) {
  // Mit dem Ordner weiterarbeiten, mit dem begonnen wurde, auch wenn inzwischen ein anderer gewählt ist.
  const f = current;
  if (!f) return { written: 0, failed: 0, missing: 0, permission: 'none' };
  const done = await writtenIds(f);
  const todo = ids.filter((id) => !done.has(id));
  if (!todo.length) return { written: 0, failed: 0, missing: 0, permission: 'granted' };
  const p = await permission(ask);
  if (p !== 'granted') return { written: 0, failed: 0, missing: todo.length, permission: p };
  let written = 0;
  let failed = 0;
  let lastError = null;
  for (const id of todo) {
    if (current !== f) break; // Ordner gewechselt oder abgeschaltet
    try {
      const record = await getFull(id);
      if (!record) continue;
      const base = fileBase(record);
      await writeFile(f, `${base}.fit`, encode(record));
      await writeFile(f, `${base}.json`, JSON.stringify(record));
      done.add(id);
      await markWritten(f, done);
      written++;
    } catch (err) {
      // Eine kaputte Fahrt soll die anderen nicht aufhalten.
      failed++;
      lastError = err;
    }
  }
  return { written, failed, lastError, missing: 0, permission: 'granted' };
}

export async function missingCount(ids) {
  if (!current) return 0;
  const done = await writtenIds(current);
  return ids.filter((id) => !done.has(id)).length;
}

// ---------- Geplante Workouts aus dem Unterordner „Geplant“ ----------

export const PLAN_DIR = 'Geplant';

// Liest alle .zwo-Dateien und die optionale plan.json (gleiches Format wie workouts/index.json).
// Fragt nicht nach der Erlaubnis; ohne Freigabe kommt { permission } ohne Dateien zurück.
export async function readPlanned({ ask = false } = {}) {
  const f = current;
  if (!f) return { permission: 'none', files: [], plan: null, bad: [], token: null };
  const p = await permission(ask);
  if (p !== 'granted') return { permission: p, files: [], plan: null, bad: [], token: f.token };
  const dir = await f.handle.getDirectoryHandle(PLAN_DIR, { create: true });
  const files = [];
  const bad = [];
  let plan = null;
  let planError = null;
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== 'file') continue;
    const lower = name.toLowerCase();
    if (!lower.endsWith('.zwo') && lower !== 'plan.json') continue;
    let text;
    try {
      // Eine Datei kann gerade geschrieben werden oder nur in OneDrive liegen; dann nur diese auslassen.
      text = await (await h.getFile()).text();
    } catch (err) {
      bad.push({ name, error: err });
      continue;
    }
    if (lower === 'plan.json') {
      try {
        plan = JSON.parse(text);
        if (!Array.isArray(plan)) throw new Error('plan.json muss eine Liste sein');
      } catch (err) {
        plan = null;
        planError = err;
      }
    } else {
      files.push({ name, text });
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { permission: 'granted', files, plan, planError, bad, token: f.token };
}

export function folderToken() {
  return current ? current.token : null;
}
