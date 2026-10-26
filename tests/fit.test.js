import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFit, fitCrc, fitFileName } from '../js/fit.js';
import { summarize } from '../js/recorder.js';

function ride(n = 120, gapAt = null) {
  const samples = [];
  let t = 1_761_500_000;
  for (let i = 0; i < n; i++) {
    if (i === gapAt) t += 30;
    samples.push({ t: t++, p: 150 + (i % 10), hr: 130, cad: i % 2 ? 90 : null, spd: 30, tgt: 150 });
  }
  return { name: 'Grundlage 60', ftp: 195, startedAt: samples[0].t * 1000, samples, summary: summarize(samples, 195) };
}

test('Kopf, Länge und Prüfsummen stimmen', () => {
  const bytes = encodeFit(ride());
  assert.equal(bytes[0], 14);
  assert.equal(String.fromCharCode(...bytes.slice(8, 12)), '.FIT');
  const dataSize = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
  assert.equal(bytes.length, 14 + dataSize + 2);
  assert.equal(fitCrc(bytes.slice(0, 12)), bytes[12] | (bytes[13] << 8));
  // Die Prüfsumme über die ganze Datei inklusive CRC ergibt 0.
  assert.equal(fitCrc(bytes), 0);
});

test('Pause erzeugt zusätzliche Start/Stopp-Ereignisse', () => {
  assert.ok(encodeFit(ride(120, 60)).length > encodeFit(ride(120)).length);
});

test('leere Fahrt wird abgelehnt', () => {
  assert.throws(() => encodeFit({ samples: [], summary: null }));
});

test('Dateiname ohne Sonderzeichen', () => {
  const name = fitFileName({ name: 'Sweet Spot 3×8 – Übung', startedAt: new Date(2026, 9, 26, 18, 5).getTime() });
  assert.equal(name, '2026-10-26_1805_Sweet-Spot-3-8-Ubung.fit');
});
