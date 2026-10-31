// Strecken für die Fahrwelt: drei erfundene Beispielstrecken und eigene GPX-Dateien.
// Eigene GPX-Dateien bleiben nur in diesem Browser (sie zeigen oft, wo man wohnt).

export const STEP = 10; // Meter zwischen zwei Streckenpunkten
const MAX_GRADE = 0.15;
const MAX_CURV = 0.006; // 1/m, engere Kurven sähen in der Ansicht verzerrt aus
const LOOP_GAP_M = 200;
const MIN_LEN_M = 500;
const MAX_LEN_M = 300000;

const wrap = (i, n) => ((i % n) + n) % n;

function smooth(arr, radius, circular) {
  const n = arr.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let cnt = 0;
    for (let k = -radius; k <= radius; k++) {
      let j = i + k;
      if (circular) j = wrap(j, n);
      else if (j < 0 || j >= n) continue;
      sum += arr[j];
      cnt++;
    }
    out[i] = sum / cnt;
  }
  return out;
}

/** Punkte {x, y, e} (Meter) gleichmäßig alle STEP Meter neu verteilen. */
export function resample(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  const total = cum[cum.length - 1];
  const x = [];
  const y = [];
  const e = [];
  let j = 1;
  for (let s = 0; s <= total; s += STEP) {
    while (j < points.length - 1 && cum[j] < s) j++;
    const a = points[j - 1];
    const b = points[j];
    const seg = cum[j] - cum[j - 1];
    const f = seg > 0 ? (s - cum[j - 1]) / seg : 0;
    x.push(a.x + (b.x - a.x) * f);
    y.push(a.y + (b.y - a.y) * f);
    e.push(a.e + (b.e - a.e) * f);
  }
  return { x, y, e, total };
}

/**
 * Aus gleichmäßigen Punkten eine fahrbare Runde machen: Höhen glätten, Steigung begrenzen,
 * Kurven berechnen. Strecken, die nicht am Start enden, werden hin und zurück gefahren.
 */
export function finalize({ id, name, scenery = {}, x, y, e, loop }) {
  let xs = x.slice();
  let ys = y.slice();
  let es = e.slice();
  if (!loop) {
    // Hin und zurück: Am Ende wendet man und fährt dieselbe Strecke zurück.
    xs = xs.concat(xs.slice(1, -1).reverse());
    ys = ys.concat(ys.slice(1, -1).reverse());
    es = es.concat(es.slice(1, -1).reverse());
  }
  const n = xs.length;
  // Zwei Durchgänge über je ±80 m: GPS-Höhen springen sonst um mehrere Meter.
  const sm = smooth(smooth(es, 8, true), 8, true);
  const grade = new Array(n);
  for (let i = 0; i < n; i++) {
    grade[i] = Math.max(-MAX_GRADE, Math.min(MAX_GRADE, (sm[wrap(i + 1, n)] - sm[i]) / STEP));
  }
  // Höhe aus den begrenzten Steigungen neu aufbauen; den Restfehler gleichmäßig verteilen,
  // damit die Runde ohne Sprung wieder am Start ankommt.
  const elev = new Array(n);
  // Mehrmals: Das Verteilen kann eine begrenzte Steigung wieder knapp über die Grenze heben.
  for (let pass = 0; pass < 8; pass++) {
    elev[0] = sm[0];
    for (let i = 1; i < n; i++) elev[i] = elev[i - 1] + grade[i - 1] * STEP;
    const residual = elev[n - 1] + grade[n - 1] * STEP - elev[0];
    for (let i = 0; i < n; i++) elev[i] -= (residual * i) / n;
    let over = false;
    for (let i = 0; i < n; i++) {
      const g = (elev[wrap(i + 1, n)] - elev[i]) / STEP;
      grade[i] = Math.max(-MAX_GRADE, Math.min(MAX_GRADE, g));
      if (grade[i] !== g) over = true;
    }
    if (!over) break;
  }

  // Fahrtrichtung und Kurven
  const head = new Array(n);
  for (let i = 0; i < n; i++) {
    const j = wrap(i + 1, n);
    head[i] = Math.atan2(ys[j] - ys[i], xs[j] - xs[i]);
  }
  for (let i = 1; i < n; i++) {
    while (head[i] - head[i - 1] > Math.PI) head[i] -= 2 * Math.PI;
    while (head[i] - head[i - 1] < -Math.PI) head[i] += 2 * Math.PI;
  }
  const hs = smooth(head, 3, false);
  const curv = new Array(n);
  for (let i = 0; i < n; i++) {
    const d = i + 1 < n ? hs[i + 1] - hs[i] : 0;
    curv[i] = Math.max(-MAX_CURV, Math.min(MAX_CURV, d / STEP));
  }
  // Aufsummierte Richtung: verschiebt die Berge im Hintergrund in Kurven.
  const turn = new Array(n);
  turn[0] = 0;
  for (let i = 1; i < n; i++) turn[i] = turn[i - 1] + curv[i - 1] * STEP;

  let minE = Infinity;
  let maxE = -Infinity;
  let climb = 0;
  for (let i = 0; i < n; i++) {
    minE = Math.min(minE, elev[i]);
    maxE = Math.max(maxE, elev[i]);
    if (grade[i] > 0) climb += grade[i] * STEP;
  }
  return {
    id, name, scenery, loop: Boolean(loop),
    length: n * STEP, n,
    x: xs, y: ys, elev, grade, curv, turn,
    minE, maxE, climb: Math.round(climb),
  };
}

/** Wert an beliebiger Stelle (Meter), linear zwischen zwei Punkten, Runde für Runde. */
export function at(route, key, d) {
  const arr = route[key];
  const pos = (((d % route.length) + route.length) % route.length) / STEP;
  const i = Math.floor(pos);
  const f = pos - i;
  const a = arr[i % route.n];
  const b = arr[(i + 1) % route.n];
  if (key === 'turn' && (i + 1) % route.n === 0) {
    // Nach einer Runde dreht man sich weiter, die Summe springt nicht zurück.
    return a + (route.curv[i % route.n] * STEP) * f;
  }
  return a + (b - a) * f;
}

/** Aufsummierte Richtung über mehrere Runden hinweg (für den Hintergrund). */
export function turnAt(route, d) {
  const laps = Math.floor(d / route.length);
  const lapTurn = route.turn[route.n - 1] + route.curv[route.n - 1] * STEP;
  return laps * lapTurn + at(route, 'turn', d - laps * route.length);
}

// ---------- GPX ----------

const attr = (s, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`).exec(s);
  return m ? Number(m[1]) : NaN;
};

/** Punkte aus einer GPX-Datei lesen (Track- oder Routenpunkte). */
export function parseGpx(text) {
  const pts = [];
  const re = /<(trkpt|rtept)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
  let m;
  while ((m = re.exec(text))) {
    const lat = attr(m[2], 'lat');
    const lon = attr(m[2], 'lon');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const em = m[4] ? /<ele>\s*([-0-9.eE+]+)\s*<\/ele>/.exec(m[4]) : null;
    pts.push({ lat, lon, ele: em ? Number(em[1]) : null });
  }
  return pts;
}

const nameOf = (text) => {
  const m = /<name>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/name>/.exec(text);
  return m ? m[1].trim().slice(0, 60) : '';
};

/**
 * Aus einer GPX-Datei die Rohdaten für eine Strecke machen. Ergebnis ist klein genug,
 * um es im Browser zu speichern; finalize() macht daraus die fahrbare Strecke.
 */
export function gpxSource(text, fallbackName = 'Eigene Strecke') {
  const pts = parseGpx(text);
  if (pts.length < 2) throw new Error('In der Datei wurden keine Streckenpunkte gefunden. Ist es eine GPX-Datei mit einer Strecke?');
  const R = 6371000;
  const lat0 = (pts[0].lat * Math.PI) / 180;
  const raw = [];
  let lastEle = pts.find((p) => p.ele !== null)?.ele ?? 0;
  const hasEle = pts.some((p) => p.ele !== null);
  for (const p of pts) {
    if (p.ele !== null) lastEle = p.ele;
    const x = ((p.lon - pts[0].lon) * Math.PI / 180) * R * Math.cos(lat0);
    const y = -((p.lat - pts[0].lat) * Math.PI / 180) * R; // Norden oben
    const prev = raw[raw.length - 1];
    if (prev && Math.hypot(x - prev.x, y - prev.y) < 0.5) continue; // doppelte Punkte
    raw.push({ x, y, e: lastEle });
  }
  if (raw.length < 2) throw new Error('Die Strecke in der Datei ist zu kurz.');
  const r = resample(raw);
  if (r.total < MIN_LEN_M) throw new Error('Die Strecke ist kürzer als 500 m.');
  if (r.total > MAX_LEN_M) throw new Error('Die Strecke ist länger als 300 km. Bitte eine kürzere wählen.');
  const first = raw[0];
  const last = raw[raw.length - 1];
  const loop = Math.hypot(last.x - first.x, last.y - first.y) < LOOP_GAP_M;
  const round = (a) => a.map((v) => Math.round(v * 10) / 10);
  return { name: nameOf(text) || fallbackName, x: round(r.x), y: round(r.y), e: round(r.e), loop, hasEle };
}

export function routeFromSource(src) {
  return finalize({ id: 'gpx', name: src.name, scenery: { snow: false, lake: null, trees: 0.6 }, x: src.x, y: src.y, e: src.e, loop: src.loop });
}

// ---------- Beispielstrecken (erfunden) ----------

function makeBuiltin({ id, name, length, shape, elev, scenery }) {
  const dense = [];
  const N = 4000;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2;
    const [x, y] = shape(t);
    dense.push({ x, y, e: 0 });
  }
  let per = 0;
  for (let i = 1; i < dense.length; i++) per += Math.hypot(dense[i].x - dense[i - 1].x, dense[i].y - dense[i - 1].y);
  const k = length / per;
  for (const p of dense) { p.x *= k; p.y *= k; }
  const r = resample(dense);
  // Letzten Punkt weglassen, er liegt auf dem Start.
  const n = r.x.length - 1;
  const e = r.x.slice(0, n).map((_, i) => elev((i * STEP) / (n * STEP)));
  return finalize({ id, name, scenery, x: r.x.slice(0, n), y: r.y.slice(0, n), e, loop: true });
}

const TAU = Math.PI * 2;

export const BUILTIN_ROUTES = [
  {
    id: 'alpenpass',
    name: 'Alpenpass',
    length: 24000,
    shape: (t) => [Math.cos(t) + 0.28 * Math.cos(3 * t), Math.sin(t) + 0.22 * Math.sin(2 * t)],
    elev: (f) => 650 + 320 * (1 - Math.cos(TAU * f)) / 2 + 14 * Math.sin(TAU * f * 9) + 3 * Math.sin(TAU * f * 23),
    scenery: { snow: true, lake: null, trees: 0.6 },
    info: 'Ein langer Anstieg und eine Abfahrt, Bergkulisse mit Schnee.',
  },
  {
    id: 'seeufer',
    name: 'Seeufer flach',
    length: 18000,
    shape: (t) => [Math.cos(t) + 0.1 * Math.cos(2 * t), 0.6 * Math.sin(t)],
    elev: (f) => 410 + 6 * Math.sin(TAU * f * 5) + 3 * Math.sin(TAU * f * 13),
    scenery: { snow: false, lake: 'left', trees: 0.45 },
    info: 'Fast flach am Wasser entlang, gut für Grundlage und Intervalle.',
  },
  {
    id: 'huegel',
    name: 'Hügelrunde',
    length: 30000,
    shape: (t) => {
      const r = 1 + 0.25 * Math.sin(3 * t) + 0.1 * Math.cos(5 * t);
      return [r * Math.cos(t), r * Math.sin(t)];
    },
    elev: (f) => 480 + 45 * Math.sin(TAU * f * 4) + 14 * Math.sin(TAU * f * 11 + 1) + 2 * Math.sin(TAU * f * 27),
    scenery: { snow: false, lake: null, trees: 0.75 },
    info: 'Wellige Runde durch Wald und Wiesen, ständig kurz rauf und runter.',
  },
];

const builtCache = new Map();
export function builtinRoute(id) {
  const def = BUILTIN_ROUTES.find((r) => r.id === id) || BUILTIN_ROUTES[0];
  if (!builtCache.has(def.id)) builtCache.set(def.id, makeBuiltin(def));
  return builtCache.get(def.id);
}
