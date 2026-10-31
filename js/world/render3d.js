// Realistische Fahrwelt in echtem 3D (WebGL über three.js).
// Gelände, Straße, Wald, Wasser, Himmel mit Sonne, Wolken, Licht und Schatten.
// Alles wird aus der Strecke berechnet, nichts wird aus dem Internet geladen.

import * as THREE from '../vendor/three/three.module.min.js';
import { Sky } from '../vendor/three/Sky.js';
import { STEP, at } from './route.js';

const QUALITY = {
  hoch: { pixelRatio: 1.25, shadows: true, shadowSize: 2048, terrainSeg: 256, terrainSize: 2400, trees: 1, fogFar: 2600 },
  niedrig: { pixelRatio: 0.85, shadows: false, shadowSize: 1024, terrainSeg: 160, terrainSize: 1800, trees: 0.45, fogFar: 1800 },
};

const ROAD_HALF = 3.2;
const FLAT_EDGE = 7; // bis hier ist das Gelände so hoch wie die Straße
const REBUILD_M = 350; // Gelände neu bauen, wenn man so weit vom Mittelpunkt weg ist

// ---------- Rauschen für Hügel, Berge und Farben ----------

function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function tileNoise(x, y, p) {
  const xi = Math.floor(x); const yi = Math.floor(y);
  const xf = x - xi; const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf); const v = yf * yf * (3 - 2 * yf);
  const w = (a) => ((a % p) + p) % p;
  const a = hash2(w(xi), w(yi)); const b = hash2(w(xi + 1), w(yi));
  const c = hash2(w(xi), w(yi + 1)); const d = hash2(w(xi + 1), w(yi + 1));
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbmTile(x, y, p, oct = 5) {
  let s = 0; let amp = 0.5; let f = 1;
  for (let i = 0; i < oct; i++) {
    s += amp * tileNoise(x * f, y * f, p * f);
    f *= 2; amp *= 0.5;
  }
  return s;
}
function fbm(x, y, oct = 5) {
  let s = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < oct; i++) {
    s += amp * valueNoise(x * f, y * f);
    f *= 2.03;
    amp *= 0.5;
  }
  return s; // etwa 0..1
}
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------- Texturen, auf einer Leinwand gemalt ----------

function canvasTexture(size, paint, repeat = true) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  paint(cv.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function speckle(c, size, n, colors, rmin, rmax, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    c.fillStyle = colors[Math.floor(rnd() * colors.length)];
    const r = rmin + rnd() * (rmax - rmin);
    c.fillRect(rnd() * size, rnd() * size, r, r);
  }
}

function grassTexture() {
  return canvasTexture(512, (c, s) => {
    c.fillStyle = '#8c8c86';
    c.fillRect(0, 0, s, s);
    speckle(c, s, 26000, ['#7e7f78', '#9a9a92', '#73746c', '#a5a59c', '#8a8a82', '#6a6b63'], 1, 3, 7);
    // Halme
    let seed = 3;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    c.lineWidth = 1;
    for (let i = 0; i < 5000; i++) {
      const x = rnd() * s;
      const y = rnd() * s;
      c.strokeStyle = rnd() < 0.5 ? 'rgba(190,190,180,0.5)' : 'rgba(70,72,66,0.5)';
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + (rnd() - 0.5) * 3, y - 2 - rnd() * 4);
      c.stroke();
    }
  });
}

function asphaltTexture() {
  // Quer: ganze Straßenbreite, längs: 12 m mit 3 m Mittelstrich.
  const tex = canvasTexture(512, (c, s) => {
    c.fillStyle = '#4a4c50';
    c.fillRect(0, 0, s, s);
    speckle(c, s, 30000, ['#3f4145', '#55575b', '#46484c', '#5d5f63', '#38393c'], 1, 2.5, 11);
    // Flicken und Spurrillen
    c.fillStyle = 'rgba(30,30,32,0.25)';
    c.fillRect(s * 0.22, 0, s * 0.08, s);
    c.fillRect(s * 0.7, 0, s * 0.08, s);
    // Randlinien
    c.fillStyle = '#e8e6df';
    c.fillRect(s * 0.035, 0, s * 0.025, s);
    c.fillRect(s * 0.94, 0, s * 0.025, s);
    // Mittelstrich (gestrichelt)
    c.fillRect(s * 0.4925, 0, s * 0.015, s * 0.33);
  });
  tex.wrapS = THREE.ClampToEdgeWrapping;
  return tex;
}

function gravelTexture() {
  return canvasTexture(256, (c, s) => {
    c.fillStyle = '#8b8170';
    c.fillRect(0, 0, s, s);
    speckle(c, s, 9000, ['#7a705f', '#9a917f', '#6d6455', '#a59c8a'], 1, 3, 5);
  });
}

function cloudTexture() {
  const tex = canvasTexture(512, (c, s) => {
    const img = c.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        // nahtlos wiederholbar: Rauschen auf einem Torus
        const n = fbmTile(x / 64, y / 64, s / 64, 5);
        const a = smooth(0.48, 0.78, n);
        const i = (y * s + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = a * 235;
      }
    }
    c.putImageData(img, 0, 0);
  });
  return tex;
}

// ---------- Suche: nächster Streckenpunkt ----------

class RouteIndex {
  constructor(route, cell = 80) {
    this.route = route;
    this.cell = cell;
    this.map = new Map();
    for (let i = 0; i < route.n; i++) {
      const k = this.key(Math.floor(route.x[i] / cell), Math.floor(route.y[i] / cell));
      if (!this.map.has(k)) this.map.set(k, []);
      this.map.get(k).push(i);
    }
  }

  key(cx, cy) {
    return cx * 100003 + cy;
  }

  /** Nächster Punkt bis maxR Meter, sonst null. */
  nearest(x, y, maxR = 2) {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    let best = -1;
    let bd = Infinity;
    for (let r = 0; r <= maxR; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const list = this.map.get(this.key(cx + dx, cy + dy));
          if (!list) continue;
          for (const i of list) {
            const d = (this.route.x[i] - x) ** 2 + (this.route.y[i] - y) ** 2;
            if (d < bd) { bd = d; best = i; }
          }
        }
      }
      if (best >= 0 && Math.sqrt(bd) < r * this.cell) break;
    }
    return best < 0 ? null : { i: best, d: Math.sqrt(bd) };
  }
}

// ---------- Abstandsfeld: wie weit ist jeder Punkt der Landschaft von der Straße weg? ----------
// Grobes Raster, einmal pro Strecke berechnet; dadurch steigt das Gelände ohne Kanten an.

class DistanceField {
  constructor(route, index, cell = 25, margin = 4000) {
    this.route = route;
    this.index = index;
    let minx = Infinity; let maxx = -Infinity; let miny = Infinity; let maxy = -Infinity;
    for (let i = 0; i < route.n; i++) {
      minx = Math.min(minx, route.x[i]); maxx = Math.max(maxx, route.x[i]);
      miny = Math.min(miny, route.y[i]); maxy = Math.max(maxy, route.y[i]);
    }
    // Sehr große Strecken: Raster gröber, damit der Speicher reicht.
    const span = Math.max(maxx - minx, maxy - miny) + 2 * margin;
    this.cell = Math.max(cell, span / 1400);
    this.x0 = minx - margin;
    this.y0 = miny - margin;
    this.w = Math.ceil((maxx - minx + 2 * margin) / this.cell) + 1;
    this.h = Math.ceil((maxy - miny + 2 * margin) / this.cell) + 1;
    const nIdx = new Int32Array(this.w * this.h).fill(-1);
    const dist = new Float32Array(this.w * this.h).fill(1e9);
    const cellOf = (x, y) => [Math.round((x - this.x0) / this.cell), Math.round((y - this.y0) / this.cell)];
    for (let i = 0; i < route.n; i++) {
      const [cx, cy] = cellOf(route.x[i], route.y[i]);
      const k = cy * this.w + cx;
      nIdx[k] = i;
      dist[k] = 0;
    }
    const exact = (k, i) => {
      const cx = k % this.w;
      const cy = (k - cx) / this.w;
      return Math.hypot(this.x0 + cx * this.cell - route.x[i], this.y0 + cy * this.cell - route.y[i]);
    };
    // Zwei Durchläufe (vorwärts, rückwärts) reichen den nächsten Streckenpunkt weiter.
    const pass = (dir) => {
      const ys = dir > 0 ? [0, this.h, 1] : [this.h - 1, -1, -1];
      const xs = dir > 0 ? [0, this.w, 1] : [this.w - 1, -1, -1];
      const nb = dir > 0 ? [[-1, 0], [0, -1], [-1, -1], [1, -1]] : [[1, 0], [0, 1], [1, 1], [-1, 1]];
      for (let y = ys[0]; y !== ys[1]; y += ys[2]) {
        for (let x = xs[0]; x !== xs[1]; x += xs[2]) {
          const k = y * this.w + x;
          for (const [dx, dy] of nb) {
            const nx = x + dx; const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
            const i = nIdx[ny * this.w + nx];
            if (i < 0 || i === nIdx[k]) continue;
            const d = exact(k, i);
            if (d < dist[k]) { dist[k] = d; nIdx[k] = i; }
          }
        }
      }
    };
    pass(1); pass(-1); pass(1);
    this.dist = dist;
    this.nIdx = nIdx;
    // Höhe des nächsten Streckenpunkts, damit Hügel um die Straße herum sitzen
    this.elev = new Float32Array(this.w * this.h);
    for (let k = 0; k < nIdx.length; k++) this.elev[k] = nIdx[k] >= 0 ? route.elev[nIdx[k]] : route.minE;
  }

  /** {d, e} weich zwischen den Rasterpunkten. */
  sample(x, y) {
    const fx = Math.max(0, Math.min(this.w - 1.001, (x - this.x0) / this.cell));
    const fy = Math.max(0, Math.min(this.h - 1.001, (y - this.y0) / this.cell));
    const ix = Math.floor(fx); const iy = Math.floor(fy);
    const tx = fx - ix; const ty = fy - iy;
    const k = iy * this.w + ix;
    const lerp2 = (a) => (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - ty) + (a[k + this.w] * (1 - tx) + a[k + this.w + 1] * tx) * ty;
    const out = Math.max(0, Math.hypot(Math.min(0, x - this.x0, this.x0 + (this.w - 1) * this.cell - x), Math.min(0, y - this.y0, this.y0 + (this.h - 1) * this.cell - y)));
    return { d: lerp2(this.dist) + out, e: lerp2(this.elev), i: this.nIdx[Math.round(fy) * this.w + Math.round(fx)] };
  }
}

// ---------- Die Welt ----------

export class Renderer3D {
  constructor(canvas, quality = 'hoch', { lensShift = 0.12 } = {}) {
    this.canvas = canvas;
    this.lensShift = lensShift;
    this.q = QUALITY[quality] || QUALITY.hoch;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.55;
    this.renderer.shadowMap.enabled = this.q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.3, 30000);
    this.tex = {
      grass: grassTexture(),
      asphalt: asphaltTexture(),
      gravel: gravelTexture(),
      cloud: cloudTexture(),
    };
    this.tex.grass.repeat.set(1, 1);
    this.buildSkyAndLight();
    this.lookAhead = new THREE.Vector3();
    this.group = null;
    this.terrain = null;
    this.trees = [];
  }

  buildSkyAndLight() {
    const sky = new Sky();
    sky.scale.setScalar(40000);
    const u = sky.material.uniforms;
    u.turbidity.value = 3.2;
    u.rayleigh.value = 1.3;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.82;
    const sun = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 32), THREE.MathUtils.degToRad(150));
    u.sunPosition.value.copy(sun);
    this.sky = sky;
    this.sunDir = sun.clone();
    this.scene.add(sky);

    // Umgebungslicht aus dem Himmel: gibt Wasser und Straße echte Spiegelungen.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky.clone());
    this.scene.environment = pmrem.fromScene(envScene, 0, 1, 10000).texture;
    pmrem.dispose();

    const fogColor = new THREE.Color('#c5d6e4');
    this.scene.fog = new THREE.Fog(fogColor, 250, this.q.fogFar);

    this.hemi = new THREE.HemisphereLight('#cfe3ff', '#6b7a45', 0.9);
    this.scene.add(this.hemi);
    const dl = new THREE.DirectionalLight('#fff3df', 2.6);
    dl.castShadow = this.q.shadows;
    dl.shadow.mapSize.set(this.q.shadowSize, this.q.shadowSize);
    const sc = dl.shadow.camera;
    sc.left = -90; sc.right = 90; sc.top = 90; sc.bottom = -90; sc.near = 10; sc.far = 600;
    dl.shadow.bias = -0.0004;
    dl.shadow.normalBias = 0.6;
    this.sun = dl;
    this.scene.add(dl);
    this.scene.add(dl.target);

    // Wolkendecke, die langsam zieht
    const clouds = new THREE.Mesh(
      new THREE.PlaneGeometry(9000, 9000),
      new THREE.MeshBasicMaterial({ map: this.tex.cloud, transparent: true, depthWrite: false, fog: false, opacity: 0.9 }),
    );
    clouds.rotation.x = Math.PI / 2;
    this.tex.cloud.repeat.set(3, 3);
    this.clouds = clouds;
    this.scene.add(clouds);
  }

  setRoute(route) {
    this.disposeRoute();
    this.route = route;
    this.base = route.minE;
    this.index = new RouteIndex(route);
    this.field = new DistanceField(route, this.index);
    this.sc = route.scenery || {};
    this.waterLevel = this.sc.lake ? route.minE - this.base - 1.5 : -1e9;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.buildRoad();
    this.buildFarRidge();
    if (this.sc.lake) this.buildWater();
    this.center = null;
  }

  // Höhe in Metern (relativ zur tiefsten Stelle der Strecke) an Position x/y.
  heightAt(x, y) {
    const r = this.route;
    const f = this.field.sample(x, y);
    let di = f.d;
    let base = f.e - this.base;
    let n = f.i >= 0 ? { i: f.i, d: di } : null;
    // Nahe der Straße genau rechnen, damit sie sauber im Gelände liegt.
    if (di < 60) {
      const exact = this.index.nearest(x, y, 1);
      if (exact) {
        n = exact;
        const blend = smooth(30, 60, di);
        di = exact.d * (1 - blend) + di * blend;
        base = (r.elev[exact.i] - this.base) * (1 - blend) + base * blend;
      }
    }
    const mountains = this.sc.snow ? 520 : 70;
    const rolling = this.sc.snow ? 26 : 18;
    const w = smooth(FLAT_EDGE, 70, di);
    const far = smooth(140, 1600, di);
    let h = base - 0.35 + w * (rolling * (fbm(x / 260, y / 260) - 0.35))
      + far * mountains * Math.pow(fbm(x / 1400 + 7, y / 1400 + 3, 6), 1.6) * 1.6;
    if (this.sc.lake && n) {
      // Auf der linken Seite fällt das Ufer zum See ab.
      const j = (n.i + 1) % r.n;
      const tx = r.x[j] - r.x[n.i];
      const ty = r.y[j] - r.y[n.i];
      const side = tx * (y - r.y[n.i]) - ty * (x - r.x[n.i]);
      // im Bild mit Norden oben liegt „links“ bei negativem Kreuzprodukt
      if (side < 0) h -= 9 * smooth(FLAT_EDGE + 2, 45, di);
    }
    return { h, d: di };
  }

  buildRoad() {
    const r = this.route;
    const n = r.n;
    const make = (inner, outer, yLift, tex, vScale) => {
      const pos = new Float32Array((n + 1) * 4 * 3);
      const uv = new Float32Array((n + 1) * 4 * 2);
      const idx = [];
      for (let k = 0; k <= n; k++) {
        const i = k % n;
        const j = (i + 1) % n;
        const p = (i - 1 + n) % n;
        let tx = r.x[j] - r.x[p];
        let ty = r.y[j] - r.y[p];
        const len = Math.hypot(tx, ty) || 1;
        tx /= len; ty /= len;
        const nx = -ty;
        const ny = tx;
        const e = r.elev[i] - this.base + yLift;
        const off = [-outer, -inner, inner, outer];
        for (let s = 0; s < 4; s++) {
          const o = (k * 4 + s) * 3;
          pos[o] = r.x[i] + nx * off[s];
          pos[o + 1] = e - (s === 0 || s === 3 ? 0.08 : 0);
          pos[o + 2] = r.y[i] + ny * off[s];
          const u = k * 4 * 2 + s * 2;
          uv[u] = (off[s] + outer) / (2 * outer);
          uv[u + 1] = (k * STEP) / vScale;
        }
        if (k < n) {
          for (const [a, b] of inner ? [[0, 1], [2, 3]] : [[0, 1], [1, 2], [2, 3]]) {
            const v0 = k * 4 + a; const v1 = k * 4 + b; const v2 = (k + 1) * 4 + a; const v3 = (k + 1) * 4 + b;
            idx.push(v0, v1, v2, v1, v3, v2);
          }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0, envMapIntensity: 0.2, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.receiveShadow = true;
      this.group.add(m);
    };
    make(0, ROAD_HALF, 0.05, this.tex.asphalt, 12); // Fahrbahn
    this.tex.gravel.repeat.set(1, 1);
    make(ROAD_HALF, ROAD_HALF + 1.1, 0.02, this.tex.gravel, 3); // Bankett
    this.buildPosts();
  }

  // Leitpfosten alle 50 m, wie an Landstraßen
  buildPosts() {
    const r = this.route;
    const every = 5;
    const count = Math.floor(r.n / every) * 2;
    const geo = new THREE.BoxGeometry(0.12, 1.0, 0.12);
    geo.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: '#f2f2f2', roughness: 0.6 }), count);
    const band = new THREE.InstancedMesh(new THREE.BoxGeometry(0.13, 0.22, 0.13).translate(0, 0.8, 0), new THREE.MeshStandardMaterial({ color: '#1a1a1a' }), count);
    const m4 = new THREE.Matrix4();
    let c = 0;
    for (let i = 0; i + every < r.n && c < count; i += every) {
      const j = (i + 1) % r.n;
      const tx = r.x[j] - r.x[i];
      const ty = r.y[j] - r.y[i];
      const len = Math.hypot(tx, ty) || 1;
      for (const side of [-1, 1]) {
        if (side === -1 && this.sc.lake) continue;
        m4.makeTranslation(r.x[i] + (-ty / len) * side * (ROAD_HALF + 1.4), r.elev[i] - this.base, r.y[i] + (tx / len) * side * (ROAD_HALF + 1.4));
        mesh.setMatrixAt(c, m4);
        band.setMatrixAt(c, m4);
        c++;
      }
    }
    mesh.count = band.count = c;
    mesh.castShadow = true;
    this.group.add(mesh, band);
  }

  buildWater() {
    const geo = new THREE.PlaneGeometry(20000, 20000);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: '#1d4257', roughness: 0.12, metalness: 0, envMapIntensity: 0.8 });
    const water = new THREE.Mesh(geo, mat);
    water.position.y = this.waterLevel;
    water.receiveShadow = true;
    this.water = water;
    this.group.add(water);
  }

  // Ferne Bergkette rund um den Fahrer, damit der Horizont nie leer ist.
  buildFarRidge() {
    const seg = 512;
    const rows = 8;
    const rIn = 3600;
    const rOut = 7500;
    const pos = [];
    const col = [];
    const idx = [];
    const peak = this.sc.snow ? 1700 : 300;
    const forest = new THREE.Color(this.sc.snow ? '#3e5040' : '#4c6448');
    const rock = new THREE.Color('#7d8088');
    const snow = new THREE.Color('#f6f8fb');
    const c = new THREE.Color();
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const ca = Math.cos(a); const sa = Math.sin(a);
      for (let k = 0; k <= rows; k++) {
        const t = k / rows;
        const rad = rIn + (rOut - rIn) * t;
        // Grate: scharfe Spitzen durch „1 - |Rauschen|“
        const ridgeN = 1 - Math.abs(fbm(ca * 6 + 20 + t * 2, sa * 6 + 20 + t * 2, 6) * 2 - 1);
        const env = Math.sin(Math.PI * Math.min(1, t * 1.6)) * (0.4 + 0.6 * fbm(ca * 2 + 3, sa * 2 + 3, 3));
        const hh = k === 0 ? -60 : peak * env * Math.pow(ridgeN, 1.8) * 1.4;
        pos.push(ca * rad, hh, sa * rad);
        const grain = fbm(ca * 40 + t * 9, sa * 40 + t * 9, 3);
        c.copy(forest).lerp(rock, smooth(peak * 0.15, peak * 0.4, hh + (grain - 0.5) * peak * 0.2));
        c.multiplyScalar(0.8 + grain * 0.4);
        if (this.sc.snow) c.lerp(snow, smooth(peak * 0.38, peak * 0.6, hh + (grain - 0.5) * peak * 0.25));
        col.push(c.r, c.g, c.b);
      }
    }
    const R = rows + 1;
    for (let i = 0; i < seg; i++) {
      for (let k = 0; k < rows; k++) {
        const a = i * R + k; const b = (i + 1) * R + k;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
    // Dunst: ferne Berge werden bläulich hell
    mat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>', 'gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.72,0.80,0.88), 0.38);\n#include <dithering_fragment>');
    };
    this.ridge = new THREE.Mesh(g, mat);
    this.scene.add(this.ridge);
  }

  // Gelände und Bäume rund um den Fahrer (wird beim Weiterfahren neu gebaut).
  buildChunk(cx, cy) {
    if (this.terrain) {
      this.group.remove(this.terrain);
      this.terrain.geometry.dispose();
    }
    for (const t of this.trees) {
      this.group.remove(t);
      t.geometry.dispose();
    }
    this.trees = [];
    const size = this.q.terrainSize;
    const seg = this.q.terrainSeg;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const green1 = new THREE.Color('#5b7a30');
    const green2 = new THREE.Color('#93a84f');
    const dry = new THREE.Color('#b0a56a');
    const forestFloor = new THREE.Color('#3d4f26');
    const rock = new THREE.Color('#7b7a74');
    const snow = new THREE.Color('#f2f5f8');
    const hs = new Float32Array(pos.count);
    const ds = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + cx;
      const z = pos.getZ(i) + cy;
      const { h, d } = this.heightAt(x, z);
      hs[i] = h;
      ds[i] = d;
      pos.setXYZ(i, x, h, z);
    }
    geo.computeVertexNormals();
    const nrm = geo.attributes.normal;
    const c = new THREE.Color();
    const snowLine = this.sc.snow ? 380 : 1e9;
    for (let i = 0; i < pos.count; i++) {
      const slope = 1 - nrm.getY(i);
      const x = pos.getX(i);
      const z = pos.getZ(i);
      c.copy(green1).lerp(green2, fbm(x / 90, z / 90, 3));
      // Felder: Flecken in anderer Farbe, wie gemähte Wiesen und Äcker
      const field = fbm(Math.floor(x / 120) * 1.7, Math.floor(z / 90) * 1.3, 1);
      if (ds[i] > 25) c.lerp(dry, smooth(0.55, 0.9, field) * 0.55 * smooth(25, 60, ds[i]));
      c.lerp(dry, smooth(0.55, 0.85, fbm(x / 400 + 5, z / 400, 3)) * 0.4);
      c.lerp(forestFloor, smooth(0.45, 0.62, fbm(x / 350 + 13, z / 350 + 2, 4)) * 0.6);
      c.lerp(rock, smooth(0.18, 0.4, slope));
      if (hs[i] > snowLine) c.lerp(snow, smooth(snowLine, snowLine + 120, hs[i]) * (1 - smooth(0.3, 0.55, slope)));
      if (hs[i] < this.waterLevel + 0.6) c.lerp(new THREE.Color('#a8997a'), 0.7);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // Grastextur wiederholt sich alle 10 m
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / 10, pos.getZ(i) / 10);
    const mat = new THREE.MeshStandardMaterial({ map: this.tex.grass, vertexColors: true, roughness: 0.95, metalness: 0, envMapIntensity: 0.35 });
    mat.onBeforeCompile = (sh) => {
      // Textur nur als Struktur, die Farbe kommt aus dem Gelände.
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `
        vec4 sampledDiffuseColor = texture2D( map, vMapUv );
        diffuseColor.rgb *= sampledDiffuseColor.rgb * 1.75;
      `);
    };
    const terrain = new THREE.Mesh(geo, mat);
    terrain.receiveShadow = true;
    this.terrain = terrain;
    this.group.add(terrain);
    this.plantTrees(cx, cy, size);
    this.center = { x: cx, y: cy };
  }

  plantTrees(cx, cy, size) {
    const density = (this.sc.trees ?? 0.6) * this.q.trees;
    const conifer = [];
    const broad = [];
    const half = size / 2 - 20;
    const step = 9;
    const x0 = Math.floor((cx - half) / step);
    const x1 = Math.floor((cx + half) / step);
    const y0 = Math.floor((cy - half) / step);
    const y1 = Math.floor((cy + half) / step);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const r = hash2(gx, gy);
        const x = gx * step + (hash2(gx + 91, gy) - 0.5) * step;
        const y = gy * step + (hash2(gx, gy + 37) - 0.5) * step;
        // Waldstücke statt gleichmäßiger Verteilung
        const forest = smooth(0.42, 0.62, fbm(x / 350 + 13, y / 350 + 2, 4));
        const dist = Math.hypot(x - cx, y - cy);
        const thin = dist > 700 ? 0.35 : 1; // in der Ferne weniger, die verschwinden eh im Dunst
        if (r > density * (0.06 + forest * 0.9) * thin) continue;
        const { h, d } = this.heightAt(x, y);
        if (d < ROAD_HALF + 4.5) continue;
        if (h < this.waterLevel + 0.8) continue;
        if (this.sc.snow && h > 420) continue;
        const s = 0.7 + hash2(gx * 3, gy * 7) * 0.8;
        const rot = hash2(gx * 5, gy * 11) * Math.PI * 2;
        (hash2(gx * 13, gy * 17) < (this.sc.snow ? 0.8 : 0.45) ? conifer : broad).push([x, h, y, s, rot]);
      }
    }
    this.trees.push(...this.makeConifers(conifer), ...this.makeBroadleaf(broad), ...this.makeTufts(cx, cy));
    for (const t of this.trees) this.group.add(t);
  }

  // Grasbüschel am Straßenrand: kleine gekreuzte Flächen mit Halm-Muster.
  makeTufts(cx, cy) {
    const r = this.route;
    const list = [];
    const R = 380;
    for (let i = 0; i < r.n; i++) {
      if (Math.abs(r.x[i] - cx) > R || Math.abs(r.y[i] - cy) > R) continue;
      const j = (i + 1) % r.n;
      const tx = r.x[j] - r.x[i];
      const ty = r.y[j] - r.y[i];
      const len = Math.hypot(tx, ty) || 1;
      for (let k = 0; k < Math.round(14 * this.q.trees); k++) {
        const hsh = hash2(i * 31 + k, k * 7 + 3);
        const side = hash2(i, k + 99) < 0.5 ? -1 : 1;
        if (side === -1 && this.sc.lake) continue;
        const off = ROAD_HALF + 1.2 + Math.pow(hsh, 1.6) * 26;
        const along = hash2(k, i + 5) * STEP;
        const x = r.x[i] + (tx / len) * along + (-ty / len) * side * off;
        const y = r.y[i] + (ty / len) * along + (tx / len) * side * off;
        list.push([x, this.heightAt(x, y).h, y, 0.6 + hash2(i + k, 17) * 0.9, hsh * 6.28]);
      }
    }
    if (!list.length) return [];
    if (!this.tex.tuft) {
      this.tex.tuft = canvasTexture(128, (c, sz) => {
        c.clearRect(0, 0, sz, sz);
        let seed = 9;
        const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
        for (let b = 0; b < 70; b++) {
          const x = sz * (0.1 + rnd() * 0.8);
          const hgt = sz * (0.35 + rnd() * 0.6);
          c.strokeStyle = `rgb(${200 + rnd() * 55},${200 + rnd() * 55},${170 + rnd() * 60})`;
          c.lineWidth = 1.5 + rnd() * 2;
          c.beginPath();
          c.moveTo(x, sz);
          c.quadraticCurveTo(x + (rnd() - 0.5) * 20, sz - hgt * 0.6, x + (rnd() - 0.5) * 36, sz - hgt);
          c.stroke();
        }
      }, false);
    }
    const plane = new THREE.PlaneGeometry(1.1, 0.7).translate(0, 0.33, 0);
    const geo = mergeGeos([plane.clone(), plane.clone().rotateY(Math.PI / 2)]);
    const mat = new THREE.MeshStandardMaterial({ map: this.tex.tuft, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1, envMapIntensity: 0.2 });
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    list.forEach(([x, h, y, sc, rot], i) => {
      q.setFromAxisAngle(up, rot);
      m4.compose(new THREE.Vector3(x, h - 0.05, y), q, new THREE.Vector3(sc, sc, sc));
      mesh.setMatrixAt(i, m4);
      col.setHSL(0.2 + (rot % 0.06), 0.5, 0.18 + (sc - 0.6) * 0.08);
      mesh.setColorAt(i, col);
    });
    mesh.receiveShadow = true;
    return [mesh];
  }

  makeConifers(list) {
    if (!list.length) return [];
    const trunkG = new THREE.CylinderGeometry(0.18, 0.28, 3, 6).translate(0, 1.5, 0);
    const crownG = mergeCones();
    const trunk = new THREE.InstancedMesh(trunkG, new THREE.MeshStandardMaterial({ color: '#4a3424', roughness: 1 }), list.length);
    const crown = new THREE.InstancedMesh(crownG, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, flatShading: true, envMapIntensity: 0.25 }), list.length);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    list.forEach(([x, h, y, s, rot], i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
      m4.compose(new THREE.Vector3(x, h - 0.2, y), q, new THREE.Vector3(s, s * (0.9 + (rot % 0.4)), s));
      trunk.setMatrixAt(i, m4);
      crown.setMatrixAt(i, m4);
      col.setHSL(0.30 + (rot % 0.05), 0.5, 0.075 + (s - 0.7) * 0.03);
      crown.setColorAt(i, col);
    });
    for (const m of [trunk, crown]) {
      m.castShadow = this.q.shadows;
      m.receiveShadow = true;
    }
    return [trunk, crown];
  }

  makeBroadleaf(list) {
    if (!list.length) return [];
    const trunkG = new THREE.CylinderGeometry(0.2, 0.32, 3.4, 6).translate(0, 1.7, 0);
    const crownG = new THREE.IcosahedronGeometry(2.8, 1);
    // Krone etwas unregelmäßig
    const p = crownG.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const k = 0.85 + 0.3 * hash2(Math.round(p.getX(i) * 10), Math.round(p.getY(i) * 10 + p.getZ(i) * 7));
      p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.9 + 5.4, p.getZ(i) * k);
    }
    crownG.computeVertexNormals();
    const trunk = new THREE.InstancedMesh(trunkG, new THREE.MeshStandardMaterial({ color: '#54402e', roughness: 1 }), list.length);
    const crown = new THREE.InstancedMesh(crownG, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85, flatShading: true, envMapIntensity: 0.25 }), list.length);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    list.forEach(([x, h, y, s, rot], i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
      m4.compose(new THREE.Vector3(x, h - 0.2, y), q, new THREE.Vector3(s, s, s));
      trunk.setMatrixAt(i, m4);
      crown.setMatrixAt(i, m4);
      col.setHSL(0.21 + (rot % 0.07), 0.55, 0.11 + (s - 0.7) * 0.05);
      crown.setColorAt(i, col);
    });
    for (const m of [trunk, crown]) {
      m.castShadow = this.q.shadows;
      m.receiveShadow = true;
    }
    return [trunk, crown];
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    const pr = Math.min(window.devicePixelRatio || 1, this.q.pixelRatio);
    if (this.size !== `${w}x${h}x${pr}`) {
      this.size = `${w}x${h}x${pr}`;
      this.renderer.setPixelRatio(pr);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      // Objektiv leicht nach unten verschoben: Der Horizont sitzt tiefer im Bild,
      // weil oben die Werte liegen. Die Perspektive bleibt dabei unverzerrt.
      this.camera.setViewOffset(w, h, 0, -h * this.lensShift, w, h);
      this.camera.updateProjectionMatrix();
    }
  }

  /** Ein Bild an Position dist (Meter). cadence (U/min) wippt die Kamera leicht. */
  render(dist, { timeS = 0, cadence = 0 } = {}) {
    const r = this.route;
    if (!r) return;
    this.resize();
    const px = at(r, 'x', dist);
    const py = at(r, 'y', dist);
    // x/y springen am Rundenende nicht, weil die Runde geschlossen ist.
    const pe = at(r, 'elev', dist) - this.base;
    if (!this.center || Math.hypot(px - this.center.x, py - this.center.y) > REBUILD_M) {
      this.buildChunk(Math.round(px / 50) * 50, Math.round(py / 50) * 50);
    }
    const bob = cadence > 0 ? Math.sin(timeS * (cadence / 60) * Math.PI * 2) * 0.012 : 0;
    this.camera.position.set(px, pe + 1.55 + bob, py);
    const ahead = 22;
    const tx = at(r, 'x', dist + ahead);
    const ty = at(r, 'y', dist + ahead);
    const te = at(r, 'elev', dist + ahead) - this.base + 1.2;
    const target = new THREE.Vector3(tx, te, ty);
    // Blick weich nachführen, sonst ruckelt es in Kurven
    if (this.lookAhead.lengthSq() === 0 || this.lookAhead.distanceTo(target) > 60) this.lookAhead.copy(target);
    else this.lookAhead.lerp(target, 0.12);
    this.camera.lookAt(this.lookAhead);

    // Sonne und Schatten folgen dem Fahrer
    this.sun.position.set(px + this.sunDir.x * 300, pe + this.sunDir.y * 300, py + this.sunDir.z * 300);
    this.sun.target.position.set(px, pe, py);
    this.ridge.position.set(px, pe * 0.3, py);
    this.clouds.position.set(px, 1400, py);
    this.tex.cloud.offset.set(timeS * 0.0008, timeS * 0.0003);
    if (this.water) this.water.position.set(px, this.waterLevel, py);
    this.renderer.render(this.scene, this.camera);
  }

  disposeRoute() {
    if (!this.group) return;
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material.dispose) o.material.dispose();
    });
    if (this.ridge) {
      this.scene.remove(this.ridge);
      this.ridge.geometry.dispose();
    }
    this.group = null;
    this.terrain = null;
    this.trees = [];
    this.water = null;
  }

  dispose() {
    this.disposeRoute();
    for (const t of Object.values(this.tex)) t.dispose();
    this.renderer.dispose();
  }
}

function mergeGeos(geos) {
  const pos = []; const uv = []; const nrm = [];
  for (const g0 of geos) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    pos.push(...g.attributes.position.array);
    uv.push(...g.attributes.uv.array);
    nrm.push(...g.attributes.normal.array);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return out;
}

// Fichte aus drei übereinander gestapelten Kegeln
function mergeCones() {
  const parts = [[2.2, 4.2, 2.6], [1.7, 3.6, 4.6], [1.1, 3.0, 6.4]];
  const pos = [];
  const idx = [];
  for (const [rad, hgt, y] of parts) {
    const g = new THREE.ConeGeometry(rad, hgt, 8).translate(0, y, 0).toNonIndexed();
    const p = g.attributes.position;
    const off = pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      idx.push(off + i);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setIndex(idx);
  out.computeVertexNormals();
  return out;
}
