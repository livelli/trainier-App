import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIndoorBikeData, parseMachineFeature, parsePowerRange,
  parseHeartRate, parseCscMeasurement, CadenceCalculator, toHex,
} from '../js/parsers.js';

const dv = (...bytes) => new DataView(new Uint8Array(bytes).buffer);

test('Indoor Bike Data: Geschwindigkeit, Kadenz und Leistung', () => {
  // Flags 0x0044: Geschwindigkeit (Bit 0 = 0), Kadenz (Bit 2), Leistung (Bit 6)
  // 25,00 km/h = 2500 = 0x09C4, Kadenz 90 U/min = 180 = 0x00B4, Leistung 200 W = 0x00C8
  const d = parseIndoorBikeData(dv(0x44, 0x00, 0xc4, 0x09, 0xb4, 0x00, 0xc8, 0x00));
  assert.equal(d.speedKmh, 25);
  assert.equal(d.cadence, 90);
  assert.equal(d.power, 200);
});

test('Indoor Bike Data: ohne Geschwindigkeit (More Data gesetzt)', () => {
  // Flags 0x0041: nur Leistung, 150 W
  const d = parseIndoorBikeData(dv(0x41, 0x00, 0x96, 0x00));
  assert.equal(d.speedKmh, undefined);
  assert.equal(d.power, 150);
});

test('Indoor Bike Data: alle Felder in richtiger Reihenfolge', () => {
  // Flags 0x0B74 (Bits 2,4,5,6,8,9,11) mit Geschwindigkeit
  const d = parseIndoorBikeData(dv(
    0x74, 0x0b,
    0x10, 0x27, // Geschwindigkeit 100,00 km/h
    0xb4, 0x00, // Kadenz 90
    0xe8, 0x03, 0x00, // Strecke 1000 m
    0x05, 0x00, // Widerstand 5
    0xff, 0xff, // Leistung -1 W (vorzeichenbehaftet)
    0x0a, 0x00, 0x14, 0x00, 0x01, // Energie 10 kcal, 20/h, 1/min
    0x8c, // Herzfrequenz 140
    0x3c, 0x00, // Zeit 60 s
  ));
  assert.equal(d.speedKmh, 100);
  assert.equal(d.cadence, 90);
  assert.equal(d.distanceM, 1000);
  assert.equal(d.resistance, 5);
  assert.equal(d.power, -1);
  assert.equal(d.energyTotalKcal, 10);
  assert.equal(d.heartRate, 140);
  assert.equal(d.elapsedS, 60);
});

test('Machine Feature: ERG erkannt', () => {
  // Machine: Kadenz (Bit 1) + Leistung (Bit 14) = 0x4002; Target: Leistung (Bit 3) + Simulation (Bit 13) = 0x2008
  const f = parseMachineFeature(dv(0x02, 0x40, 0, 0, 0x08, 0x20, 0, 0));
  assert.equal(f.powerTargetSupported, true);
  assert.equal(f.simulationSupported, true);
  assert.deepEqual(f.machine, ['Kadenz', 'Leistungsmessung']);
});

test('Machine Feature: ohne ERG', () => {
  const f = parseMachineFeature(dv(0, 0, 0, 0, 0x04, 0, 0, 0));
  assert.equal(f.powerTargetSupported, false);
  assert.deepEqual(f.target, ['Zielwiderstand']);
});

test('Power Range', () => {
  assert.deepEqual(parsePowerRange(dv(0x00, 0x00, 0x58, 0x02, 0x01, 0x00)), { min: 0, max: 600, step: 1 });
});

test('Herzfrequenz 8 und 16 Bit', () => {
  assert.equal(parseHeartRate(dv(0x00, 0x48)).bpm, 72);
  assert.equal(parseHeartRate(dv(0x01, 0x2c, 0x01)).bpm, 300);
  assert.equal(parseHeartRate(dv(0x06, 0x48)).contact, true);
  assert.equal(parseHeartRate(dv(0x00, 0x48)).contact, null);
});

test('CSC: nur Kurbel und Rad+Kurbel', () => {
  assert.deepEqual(parseCscMeasurement(dv(0x02, 0x0a, 0x00, 0x00, 0x04)), { crankRevs: 10, crankTime: 1024 });
  const both = parseCscMeasurement(dv(0x03, 1, 0, 0, 0, 0x00, 0x08, 0x0a, 0x00, 0x00, 0x04));
  assert.equal(both.wheelRevs, 1);
  assert.equal(both.crankRevs, 10);
  assert.equal(both.crankTime, 1024);
});

test('Kadenz: 90 U/min und Überlauf', () => {
  const c = new CadenceCalculator();
  c.update(100, 0, 0);
  // 3 Umdrehungen in 2 s (2048/1024) = 90 U/min
  assert.equal(c.update(103, 2048, 2000), 90);
  // Überlauf von Zähler und Zeit
  const c2 = new CadenceCalculator();
  c2.update(65535, 65000, 0);
  assert.equal(c2.update(1, (65000 + 1365) & 0xffff, 1000), 90); // 2 Umdr. in 1365/1024 s
});

test('Kadenz: fällt nach Stillstand auf 0', () => {
  const c = new CadenceCalculator({ timeoutMs: 3000 });
  c.update(0, 0, 0);
  c.update(3, 2048, 2000);
  assert.equal(c.current(4000), 90);
  assert.equal(c.current(5500), 0);
});

test('toHex', () => {
  assert.equal(toHex(dv(0x00, 0xab, 0x10)), '00 ab 10');
});

test('Kadenz: nach langer Pause keine falsche Kadenz', () => {
  const c = new CadenceCalculator();
  c.update(0, 0, 0);
  c.update(3, 2048, 2000); // 90 U/min
  // Stillstand: Sensor sendet weiter Pakete mit gleichen Zählern
  for (let t = 3000; t <= 71000; t += 1000) c.update(3, 2048, t);
  // 70 s nach der letzten Umdrehung: Sensorzeit ist übergelaufen, erstes Paket darf nichts rechnen
  assert.equal(c.update(4, 1000, 72000), 0);
  assert.equal(c.update(7, 3048, 74000), 90);
});
