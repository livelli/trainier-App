import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recording, summarize, normalizedPower } from '../js/recorder.js';

const v = (p, extra = {}) => ({ p, hr: 130, cad: 90, spd: 36, tgt: p, ...extra });

test('ein Messpunkt pro Sekunde, nicht in der Pause', () => {
  const r = new Recording({ name: 'Test', ftp: 200, startedAt: 1_000_000 });
  assert.equal(r.tick(1_000_000, v(100), true), 1);
  assert.equal(r.tick(1_000_250, v(100), true), 0); // gleiche Sekunde
  assert.equal(r.tick(1_001_100, v(110), true), 1);
  assert.equal(r.tick(1_002_000, v(110), false), 0); // Pause
  assert.equal(r.tick(1_005_000, v(120), false), 0);
  assert.equal(r.tick(1_006_000, v(120), true), 1); // weiter, Pause nicht aufgefüllt
  assert.deepEqual(r.samples.map((s) => s.t), [1000, 1001, 1006]);
});

test('Pause und Weiter in derselben Sekunde schreibt keine Sekunde doppelt', () => {
  const r = new Recording({ name: 'Test', ftp: 200, startedAt: 0 });
  r.tick(5_000, v(100), true);
  r.tick(5_100, v(100), false);
  assert.equal(r.tick(5_300, v(100), true), 0);
  assert.equal(r.tick(6_000, v(100), true), 1);
  assert.deepEqual(r.samples.map((s) => s.t), [5, 6]);
  assert.equal(r.startedAt, 5000);
  assert.equal(r.id, 'fahrt-5000');
});

test('Lücke beim Fahren höchstens 10 s auffüllen', () => {
  const r = new Recording({ name: 'Test', ftp: 200, startedAt: 0 });
  r.tick(0, v(100), true);
  assert.equal(r.tick(60_000, v(100), true), 10);
  assert.equal(r.samples.at(-1).t, 60);
});

test('Normalized Power: konstant gleich Schnitt, schwankend höher', () => {
  assert.equal(normalizedPower(new Array(29).fill(200)), null);
  assert.equal(Math.round(normalizedPower(new Array(600).fill(200))), 200);
  const mixed = [];
  for (let i = 0; i < 20; i++) mixed.push(...new Array(60).fill(300), ...new Array(60).fill(100));
  assert.ok(normalizedPower(mixed) > 230);
});

test('Zusammenfassung: Schnitt, TSS, Strecke', () => {
  const samples = Array.from({ length: 3600 }, (_, i) => ({ t: i, p: 200, hr: 140, cad: 90, spd: 36, tgt: 200 }));
  const s = summarize(samples, 200);
  assert.equal(s.timerS, 3600);
  assert.equal(s.avgPower, 200);
  assert.equal(s.np, 200);
  assert.equal(s.intensity, 1);
  assert.equal(s.tss, 100);
  assert.equal(s.distanceM, 36000);
  assert.equal(s.kj, 720);
  assert.equal(s.avgHr, 140);
});

test('ohne Wattmesser keine Wattwerte, Kadenz 0 zählt nicht', () => {
  const samples = [{ t: 0, p: null, hr: 120, cad: 0, spd: null, tgt: null }, { t: 2, p: null, hr: 130, cad: 80, spd: null, tgt: null }];
  const s = summarize(samples, 200);
  assert.equal(s.avgPower, null);
  assert.equal(s.tss, null);
  assert.equal(s.avgCad, 80);
  assert.equal(s.elapsedS, 3);
  assert.equal(s.timerS, 2);
});
