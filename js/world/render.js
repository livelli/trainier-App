// Zeichnet die Fahrwelt: Straße von hinten gesehen, Berge, Bäume, Wasser.
// Reines Canvas 2D ohne Zusatzbibliothek, damit es auch auf einfachen Laptops flüssig läuft.

import { STEP, at, turnAt } from './route.js';

const QUALITY = {
  hoch: { segments: 220, maxDpr: 1.5, trees: 1 },
  niedrig: { segments: 120, maxDpr: 1, trees: 0.5 },
};

const hash = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mixRgb = (a, b, k) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',')})`;

const PAL = {
  skyTop: '#2f7fd1', skyMid: '#8cc6ee', skyBot: '#e3f1fa',
  fog: hex('#dcecf6'),
  grass1: hex('#58b04f'), grass2: hex('#4fa347'),
  road1: hex('#565b63'), road2: hex('#51565e'),
  rum1: hex('#ececec'), rum2: hex('#d94b3b'),
  water1: hex('#3d86b8'), water2: hex('#3a80b0'),
  line: '#f4f4f4',
};

export function fitCanvas(cv, maxDpr) {
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  return [cv.getContext('2d'), w, h];
}

function ridge(c, W, H, { base, amp, color, shift, seed, snow }) {
  c.beginPath();
  c.moveTo(0, H);
  const step = W / 90;
  for (let x = 0; x <= W + step; x += step) {
    const u = x / W + shift + seed;
    const y = base - amp * (0.55 * Math.abs(Math.sin(u * 6.1)) + 0.3 * Math.abs(Math.sin(u * 13.7 + 1)) + 0.15 * Math.sin(u * 31));
    c.lineTo(x, y);
  }
  c.lineTo(W, H);
  c.closePath();
  c.fillStyle = color;
  c.fill();
  if (snow) {
    c.save();
    c.clip();
    c.fillStyle = 'rgba(255,255,255,0.88)';
    c.fillRect(0, base - amp, W, amp * 0.3);
    c.restore();
  }
}

/** Ein Bild der Welt an Position dist (Meter, über alle Runden). */
export function drawWorld(cv, route, dist, quality = 'hoch') {
  const q = QUALITY[quality] || QUALITY.hoch;
  const [c, W, H] = fitCanvas(cv, q.maxDpr);
  const sc = route.scenery || {};
  const N = q.segments;
  const segL = 6;
  const focal = 1.05;
  const camH = 1.9;
  const camY = at(route, 'elev', dist) + camH;
  const horizon = H * 0.52;
  const unit = Math.max(W, H * 1.6) / 2; // Bildbreite pro Meter bei Abstand 1

  // Himmel
  const sky = c.createLinearGradient(0, 0, 0, horizon + H * 0.05);
  sky.addColorStop(0, PAL.skyTop);
  sky.addColorStop(0.65, PAL.skyMid);
  sky.addColorStop(1, PAL.skyBot);
  c.fillStyle = sky;
  c.fillRect(0, 0, W, H);

  // Berge im Hintergrund wandern in Kurven zur Seite.
  const shift = -turnAt(route, dist) / (Math.PI * 2);
  ridge(c, W, H, { base: horizon + H * 0.02, amp: H * (sc.snow ? 0.3 : 0.16), color: sc.snow ? '#8aa1bf' : '#97adc4', shift: shift * 0.6, seed: 0, snow: sc.snow });
  ridge(c, W, H, { base: horizon + H * 0.04, amp: H * 0.13, color: '#5d8a6a', shift: shift * 1.2, seed: 0.45, snow: false });

  // Straßenabschnitte vom Fahrer aus nach hinten berechnen.
  const base = Math.floor(dist / segL);
  const pts = new Array(N + 1);
  let x = 0;
  let dx = 0;
  for (let n = 0; n <= N; n++) {
    const z = (base + n) * segL;
    const zc = z - dist;
    if (n > 0) {
      dx += at(route, 'curv', z) * segL;
      x += dx * segL;
    }
    if (zc < 0.3) {
      pts[n] = null;
      continue;
    }
    const s = focal / zc;
    pts[n] = {
      z, zc, s,
      X: W / 2 + x * s * unit,
      Y: horizon - (at(route, 'elev', z) - camY) * s * unit,
      R: 3.2 * s * unit, // halbe Straßenbreite in Pixeln
    };
  }

  const quad = (x1, y1, w1, x2, y2, w2, col) => {
    c.fillStyle = col;
    c.beginPath();
    c.moveTo(x1 - w1, y1);
    c.lineTo(x2 - w2, y2);
    c.lineTo(x2 + w2, y2);
    c.lineTo(x1 + w1, y1);
    c.closePath();
    c.fill();
  };
  const treeDensity = (sc.trees ?? 0.6) * q.trees;

  // Von hinten nach vorne malen: Nähere Abschnitte verdecken fernere (auch hinter Kuppen).
  for (let n = N; n >= 1; n--) {
    const p2 = pts[n];
    const p1 = pts[n - 1];
    if (!p2 || !p1) continue;
    if (p2.Y > H && p1.Y > H) continue;
    const id = base + n;
    const k = id % 2;
    const fog = Math.min(1, Math.pow(p2.zc / (N * segL), 1.4)) * 0.75;
    const col = (pair) => mixRgb(pair, PAL.fog, fog);

    c.fillStyle = col(k ? PAL.grass1 : PAL.grass2);
    c.fillRect(0, p2.Y, W, p1.Y - p2.Y + 1);
    if (sc.lake === 'left') {
      c.fillStyle = col(k ? PAL.water1 : PAL.water2);
      c.beginPath();
      c.moveTo(0, p1.Y);
      c.lineTo(0, p2.Y);
      c.lineTo(p2.X - p2.R * 3, p2.Y);
      c.lineTo(p1.X - p1.R * 3, p1.Y);
      c.closePath();
      c.fill();
    }
    quad(p1.X, p1.Y, p1.R * 1.12, p2.X, p2.Y, p2.R * 1.12, col(k ? PAL.rum1 : PAL.rum2));
    quad(p1.X, p1.Y, p1.R, p2.X, p2.Y, p2.R, col(k ? PAL.road1 : PAL.road2));
    if (id % 4 < 2) quad(p1.X, p1.Y, p1.R * 0.03, p2.X, p2.Y, p2.R * 0.03, PAL.line);

    // Bäume am Rand, immer an derselben Stelle der Strecke.
    const rid = Math.floor((((p2.z % route.length) + route.length) % route.length) / segL);
    if (hash(rid) < treeDensity) {
      for (const side of [-1, 1]) {
        if (side === -1 && sc.lake === 'left') continue;
        if (hash(rid * 3 + side) < 0.5) continue;
        const lat = side * (5 + hash(rid * 7 + side) * 24);
        const tx = p2.X + lat * p2.s * unit;
        const th = (5 + hash(rid * 11 + side) * 8) * p2.s * unit;
        if (th < 1.5) continue;
        c.fillStyle = col(hex('#5b3a24'));
        c.fillRect(tx - th * 0.05, p2.Y - th * 0.22, th * 0.1, th * 0.22);
        c.fillStyle = col(hash(rid * 13 + side) < 0.5 ? hex('#1f6b3a') : hex('#2b7f45'));
        c.beginPath();
        c.moveTo(tx, p2.Y - th);
        c.lineTo(tx - th * 0.3, p2.Y - th * 0.18);
        c.lineTo(tx + th * 0.3, p2.Y - th * 0.18);
        c.closePath();
        c.fill();
      }
    }
  }
  // Unterkante, falls der nächste Abschnitt nicht bis zum Bildrand reicht
  const near = pts.find(Boolean);
  if (near && near.Y < H) {
    c.fillStyle = mixRgb(PAL.grass1, PAL.fog, 0);
    c.fillRect(0, near.Y, W, H - near.Y);
    quad(near.X, H + near.R, near.R * 1.4, near.X, near.Y, near.R, mixRgb(PAL.road1, PAL.fog, 0));
  }
}

/** Kleine Karte der Strecke mit Position. */
export function drawMiniMap(cv, route, dist) {
  const [c, w, h] = fitCanvas(cv, 2);
  c.clearRect(0, 0, w, h);
  let minx = Infinity; let maxx = -Infinity; let miny = Infinity; let maxy = -Infinity;
  for (let i = 0; i < route.n; i++) {
    minx = Math.min(minx, route.x[i]); maxx = Math.max(maxx, route.x[i]);
    miny = Math.min(miny, route.y[i]); maxy = Math.max(maxy, route.y[i]);
  }
  const s = Math.min((w * 0.82) / Math.max(1, maxx - minx), (h * 0.82) / Math.max(1, maxy - miny));
  const tx = (v) => w / 2 + (v - (minx + maxx) / 2) * s;
  const ty = (v) => h / 2 + (v - (miny + maxy) / 2) * s;
  const stride = Math.max(1, Math.floor(route.n / 600));
  const pos = (((dist % route.length) + route.length) % route.length) / STEP;
  c.lineJoin = 'round';
  c.lineCap = 'round';
  c.lineWidth = Math.max(2, w * 0.025);
  c.strokeStyle = 'rgba(255,255,255,0.35)';
  c.beginPath();
  for (let i = 0; i <= route.n; i += stride) {
    const j = i % route.n;
    if (i) c.lineTo(tx(route.x[j]), ty(route.y[j]));
    else c.moveTo(tx(route.x[j]), ty(route.y[j]));
  }
  c.closePath();
  c.stroke();
  c.strokeStyle = '#ff7a1a';
  c.beginPath();
  for (let i = 0; i <= pos; i += stride) {
    if (i) c.lineTo(tx(route.x[i]), ty(route.y[i]));
    else c.moveTo(tx(route.x[i]), ty(route.y[i]));
  }
  c.stroke();
  const i = Math.min(route.n - 1, Math.floor(pos));
  c.fillStyle = '#fff';
  c.beginPath();
  c.arc(tx(route.x[i]), ty(route.y[i]), Math.max(4, w * 0.04), 0, Math.PI * 2);
  c.fill();
}

/** Höhenprofil einer ganzen Runde mit Fahrerpunkt. */
export function drawElevation(cv, route, dist) {
  const [c, w, h] = fitCanvas(cv, 2);
  c.clearRect(0, 0, w, h);
  const top = h * 0.12;
  const bottom = h * 0.96;
  const span = Math.max(20, route.maxE - route.minE);
  const y = (e) => bottom - (bottom - top) * ((e - route.minE + span * 0.08) / (span * 1.16));
  const xs = (i) => (w * i) / route.n;
  const stride = Math.max(1, Math.floor(route.n / w));
  const pos = (((dist % route.length) + route.length) % route.length) / STEP;

  const fillPart = (from, to, color) => {
    c.beginPath();
    c.moveTo(xs(from), bottom);
    for (let i = from; i <= to; i += stride) c.lineTo(xs(i), y(route.elev[Math.min(i, route.n - 1)]));
    c.lineTo(xs(to), y(route.elev[Math.min(Math.floor(to), route.n - 1)]));
    c.lineTo(xs(to), bottom);
    c.closePath();
    c.fillStyle = color;
    c.fill();
  };
  fillPart(0, route.n, 'rgba(63,167,255,0.35)');
  fillPart(0, pos, 'rgba(63,167,255,0.8)');
  const mx = xs(pos);
  const my = y(at(route, 'elev', dist));
  c.fillStyle = '#fff';
  c.beginPath();
  c.arc(mx, my, Math.max(4, h * 0.09), 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = '#ff7a1a';
  c.lineWidth = Math.max(2, h * 0.035);
  c.stroke();
}
