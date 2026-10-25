import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseZwo, totalDuration, formatTime } from '../js/workout.js';
import { WorkoutPlayer } from '../js/player.js';
import { powerZone } from '../js/zones.js';

const ZWO = `<?xml version="1.0"?>
<workout_file>
  <author>Claude</author>
  <name>Sweet Spot 3 &amp; 8</name>
  <description>Test</description>
  <sportType>bike</sportType>
  <workout>
    <Warmup Duration="600" PowerLow="0.5" PowerHigh="0.75"/>
    <IntervalsT Repeat="3" OnDuration="480" OffDuration="180" OnPower="0.9" OffPower="0.5"/>
    <SteadyState Duration="120" Power="0.65">
      <textevent timeoffset="10" message="Locker bleiben"/>
    </SteadyState>
    <FreeRide Duration="60"/>
    <Cooldown Duration="300" PowerLow="0.6" PowerHigh="0.4"/>
  </workout>
</workout_file>`;

test('ZWO einlesen', () => {
  const w = parseZwo(ZWO);
  assert.equal(w.name, 'Sweet Spot 3 & 8');
  // Warmup + 3×(on+off) + Steady + Free + Cooldown
  assert.equal(w.segments.length, 1 + 6 + 1 + 1 + 1);
  assert.deepEqual(w.segments[0], { durationS: 600, startPct: 0.5, endPct: 0.75, free: false, label: 'Einfahren', cadence: null });
  assert.equal(w.segments[1].label, 'Intervall 1 von 3');
  assert.equal(w.segments[1].startPct, 0.9);
  assert.equal(w.segments[2].label, 'Erholung');
  assert.equal(w.segments[7].label, 'Block');
  assert.equal(w.segments[8].free, true);
  assert.equal(w.segments[9].endPct, 0.4);
  assert.equal(totalDuration(w), 600 + 3 * 660 + 120 + 60 + 300);
});

test('ZWO ohne Workout wird abgelehnt', () => {
  assert.throws(() => parseZwo('<workout_file></workout_file>'), /Keine <workout>/);
});

test('Zeit formatieren', () => {
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(3725), '1:02:05');
  assert.equal(formatTime(-3), '0:00');
});

test('Player: Abschnitt, Rampe und nächstes Ziel', () => {
  const w = parseZwo(ZWO);
  const p = new WorkoutPlayer(w, { ftp: 194 });
  p.start(0);
  let s = p.status(300 * 1000); // Mitte des Einfahrens
  assert.equal(s.index, 0);
  assert.equal(s.targetW, Math.round(0.625 * 194));
  s = p.status((600 + 100) * 1000); // im ersten Intervall
  assert.equal(s.segment.label, 'Intervall 1 von 3');
  assert.equal(s.targetW, Math.round(0.9 * 194));
  assert.equal(Math.round(s.segRemainingS), 380);
  assert.equal(s.nextTargetW, Math.round(0.5 * 194));
});

test('Player: Pause hält die Uhr an', () => {
  const p = new WorkoutPlayer(parseZwo(ZWO), { ftp: 194 });
  p.start(0);
  p.pause(10_000);
  assert.equal(p.status(50_000).elapsedS, 10);
  p.resume(50_000);
  assert.equal(p.status(55_000).elapsedS, 15);
});

test('Player: Anpassungen und freie Fahrt', () => {
  const w = parseZwo(ZWO);
  const p = new WorkoutPlayer(w, { ftp: 200 });
  p.start(0);
  p.scale(0.9);
  p.adjustOffset(10);
  const t = (600 + 10) * 1000;
  assert.equal(p.status(t).targetW, Math.round(0.9 * 200 * 0.9 + 10));
  const freeStart = 600 + 3 * 660 + 120;
  assert.equal(p.status((freeStart + 5) * 1000).targetW, null);
});

test('Player: Ende und Überspringen', () => {
  const w = parseZwo(ZWO);
  const p = new WorkoutPlayer(w, { ftp: 194 });
  p.start(0);
  p.skip(1000);
  assert.equal(p.status(1000).index, 1);
  assert.equal(p.status(1000 + 999_999_999).state, 'fertig');
});

test('Zonen', () => {
  assert.equal(powerZone(97, 194).zone, 1); // 50 %
  assert.equal(powerZone(174, 194).zone, 3); // 89,7 %
  assert.equal(powerZone(175, 194).zone, 4); // 90,2 %
  assert.equal(powerZone(110, 200).zone, 1); // genau 55 % gehört noch zu Zone 1
  assert.equal(powerZone(400, 194).zone, 7);
});

test('ZWO: Kommentare, Attribute am workout-Tag, Intervall-Rampen', () => {
  const w = parseZwo(`<workout_file><name>X</name><workout sport="bike">
    <!-- <SteadyState Duration="999" Power="2"/> -->
    <IntervalsT Repeat="2" OnDuration="60" OffDuration="30" PowerOnLow="0.8" PowerOnHigh="1.0" PowerOffLow="0.5" PowerOffHigh="0.5"/>
  </workout></workout_file>`);
  assert.equal(w.segments.length, 4);
  assert.equal(w.segments[0].startPct, 0.8);
  assert.equal(w.segments[0].endPct, 1.0);
  assert.equal(w.segments[1].startPct, 0.5);
});

test('Kadenz aus der Datei und als Empfehlung', async () => {
  const { parseZwo, cadenceTarget, formatCadence } = await import('../js/workout.js');
  const w = parseZwo(`<workout_file><workout>
    <Warmup Duration="300" PowerLow="0.5" PowerHigh="0.7"/>
    <SteadyState Duration="600" Power="0.9" Cadence="70"/>
    <SteadyState Duration="60" Power="1.1" CadenceLow="95" CadenceHigh="105"/>
    <IntervalsT Repeat="2" OnDuration="60" OffDuration="60" OnPower="1.2" OffPower="0.5" Cadence="100" CadenceResting="85"/>
    <FreeRide Duration="60"/>
  </workout></workout_file>`);
  const c = w.segments.map(cadenceTarget);
  assert.deepEqual(c[0], { low: 85, high: 95 });
  assert.deepEqual(c[1], { low: 70, high: 70 });
  assert.deepEqual(c[2], { low: 95, high: 105 });
  assert.deepEqual(c[3], { low: 100, high: 100 });
  assert.deepEqual(c[4], { low: 85, high: 85 });
  assert.equal(c[7], null);
  assert.deepEqual(cadenceTarget({ startPct: 1.1, endPct: 1.1, free: false }), { low: 90, high: 100 });
  assert.equal(formatCadence({ low: 85, high: 95 }), '85–95 U/min');
  assert.equal(formatCadence({ low: 70, high: 70 }), '70 U/min');
  assert.equal(parseZwo('<workout><SteadyState Duration="60" Power="0.5" Cadence="999"/></workout>').segments[0].cadence, null);
});
