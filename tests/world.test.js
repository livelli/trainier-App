import { test } from 'node:test';
import assert from 'node:assert/strict';
import { steadySpeed, stepSpeed, coastDown } from '../js/world/physics.js';
import { BUILTIN_ROUTES, builtinRoute, gpxSource, routeFromSource, at, parseGpx, STEP } from '../js/world/route.js';

const kmh = (v) => v * 3.6;

test('Geschwindigkeit: flach, bergauf, bergab plausibel', () => {
  const flat = kmh(steadySpeed(200, 0, 84));
  assert.ok(flat > 31 && flat < 36, `flach ${flat}`);
  const up = kmh(steadySpeed(200, 0.06, 84));
  assert.ok(up > 11 && up < 15, `6 % ${up}`);
  assert.ok(kmh(steadySpeed(200, -0.04, 84)) > 45);
  // Schwerer ist bergauf langsamer
  assert.ok(steadySpeed(200, 0.06, 100) < steadySpeed(200, 0.06, 70));
});

test('Schwung: Geschwindigkeit nähert sich dem Gleichgewicht ohne Sprung', () => {
  let v = 0;
  const seen = [];
  for (let i = 0; i < 400; i++) { v = stepSpeed(v, 180, 0, 84, 0.25); seen.push(v); }
  assert.ok(Math.abs(v - steadySpeed(180, 0, 84)) < 0.2);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] - seen[i - 1] < 1, 'kein Sprung');
  // Ohne Leistung in der Ebene langsamer werden
  assert.ok(stepSpeed(9, 0, 0, 84, 1) < 9);
  // Lange Pausen im Hintergrund-Tab begrenzen
  assert.ok(Number.isFinite(stepSpeed(5, 300, 0, 84, 1000)));
});

test('Pause: man rollt aus und steht', () => {
  let v = 9;
  for (let i = 0; i < 20; i++) v = coastDown(v, 0.25);
  assert.ok(v < 3);
  for (let i = 0; i < 40; i++) v = coastDown(v, 0.25);
  assert.equal(v, 0);
});

test('Beispielstrecken: Runde ohne Höhensprung, Steigung begrenzt', () => {
  for (const def of BUILTIN_ROUTES) {
    const r = builtinRoute(def.id);
    assert.equal(r.length, def.length);
    assert.ok(Math.max(...r.grade.map(Math.abs)) <= 0.15);
    const jump = Math.abs(at(r, 'elev', r.length - 1) - at(r, 'elev', 0));
    assert.ok(jump < 2, `${def.id} Sprung am Start ${jump}`);
    // Werte hinter dem Rundenende kommen aus der nächsten Runde
    assert.equal(at(r, 'elev', r.length + 50), at(r, 'elev', 50));
  }
});

const gpx = (pts, name = 'Testrunde') => `<?xml version="1.0"?><gpx><trk><name>${name}</name><trkseg>${pts
  .map(([lat, lon, ele]) => `<trkpt lat="${lat}" lon="${lon}">${ele === undefined ? '' : `<ele>${ele}</ele>`}</trkpt>`).join('')}</trkseg></trk></gpx>`;

test('GPX: Punkte lesen, auch ohne Höhe und mit selbstschließenden Tags', () => {
  const p = parseGpx('<gpx><rte><rtept lon="8.5" lat="47.3"/><rtept lat="47.31" lon="8.51"><ele>500</ele></rtept></rte></gpx>');
  assert.deepEqual(p, [{ lat: 47.3, lon: 8.5, ele: null }, { lat: 47.31, lon: 8.51, ele: 500 }]);
});

test('GPX: Strecke ohne Rundenschluss wird hin und zurück gefahren', () => {
  const pts = [];
  for (let i = 0; i <= 100; i++) pts.push([47 + i * 0.0002, 8, 400 + i * 0.5]); // ~2,2 km nach Norden, 50 m hoch
  const src = gpxSource(gpx(pts));
  assert.equal(src.name, 'Testrunde');
  assert.equal(src.loop, false);
  const r = routeFromSource(src);
  assert.ok(Math.abs(r.length - 2 * 2224) < 60, `Länge ${r.length}`);
  assert.ok(r.climb > 35 && r.climb < 60, `Höhenmeter ${r.climb}`);
  // Mitte = Wendepunkt oben, Anfang unten
  assert.ok(at(r, 'elev', r.length / 2) > at(r, 'elev', 0) + 30);
});

test('GPX: Runde erkannt, Unsinn-Steigungen geglättet', () => {
  const pts = [];
  for (let i = 0; i < 400; i++) {
    const t = (i / 400) * Math.PI * 2;
    // Höhe mit wildem GPS-Rauschen
    pts.push([47 + 0.01 * Math.sin(t), 8 + 0.015 * Math.cos(t), 500 + (i % 2 ? 8 : -8)]);
  }
  const src = gpxSource(gpx(pts));
  assert.equal(src.loop, true);
  const r = routeFromSource(src);
  assert.ok(Math.max(...r.grade.map(Math.abs)) <= 0.15);
  assert.ok(r.climb < 100, `Rauschen sollte kaum Höhenmeter ergeben: ${r.climb}`);
  assert.equal(r.n * STEP, r.length);
});

test('GPX: verständliche Fehler', () => {
  assert.throws(() => gpxSource('<gpx></gpx>'), /keine Streckenpunkte/);
  assert.throws(() => gpxSource(gpx([[47, 8], [47.001, 8]])), /kürzer als 500 m/);
});

test('Bergab rollt man auch ohne Treten los', () => {
  let v = 0;
  for (let i = 0; i < 40; i++) v = stepSpeed(v, 0, -0.1, 84, 0.25);
  assert.ok(v > 3, `v ${v}`);
  assert.equal(stepSpeed(0, 0, 0, 84, 1), 0);
});

test('Steile, ungleiche Runde bleibt auch nach dem Ausgleich unter 15 %', () => {
  const pts = [];
  const n = 300;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    // 25 % kurz hoch, dann lange flach runter
    const e = i < 40 ? i * 2.5 * 4 : 400 - ((i - 40) / (n - 40)) * 400;
    pts.push([47 + 0.01 * Math.sin(t), 8 + 0.015 * Math.cos(t), 500 + e]);
  }
  const r = routeFromSource(gpxSource(gpx(pts)));
  assert.ok(Math.max(...r.grade.map(Math.abs)) <= 0.15 + 1e-9, `max ${Math.max(...r.grade)}`);
});
