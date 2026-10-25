import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEntry, parseIsoDate, planDate, sortByPlan, defaultBriefing } from '../js/plan.js';

test('normalizeEntry nimmt Dateinamen und Objekte', () => {
  assert.deepEqual(normalizeEntry('a.zwo'), { datei: 'a.zwo', datum: null, briefing: null });
  assert.deepEqual(normalizeEntry({ datei: 'b.zwo', datum: '2026-10-28' }), { datei: 'b.zwo', datum: '2026-10-28', briefing: null });
  assert.equal(normalizeEntry({ datum: '2026-10-28' }), null);
  assert.equal(normalizeEntry({ datei: 'c.zwo', datum: 'morgen' }).datum, null);
});

test('parseIsoDate lehnt ungültige Daten ab', () => {
  assert.equal(parseIsoDate('2026-02-30'), null);
  assert.equal(parseIsoDate('28.10.2026'), null);
  assert.equal(parseIsoDate('2026-10-28').getDate(), 28);
});

test('planDate zeigt Wochentag, Datum und heute/morgen/vorbei', () => {
  const today = new Date(2026, 9, 27, 21, 30);
  assert.deepEqual(planDate('2026-10-27', today), { text: 'Dienstag, 27. Oktober', when: 'heute' });
  assert.deepEqual(planDate('2026-10-28', today), { text: 'Mittwoch, 28. Oktober', when: 'morgen' });
  assert.deepEqual(planDate('2026-10-26', today), { text: 'Montag, 26. Oktober', when: 'vorbei' });
  assert.deepEqual(planDate('2026-11-01', today), { text: 'Sonntag, 1. November', when: null });
  assert.equal(planDate(null, today), null);
});

test('sortByPlan sortiert geplante nach Datum, ungeplante danach', () => {
  const items = [{ n: 'x' }, { n: 'b', datum: '2026-10-30' }, { n: 'a', datum: '2026-10-28' }, { n: 'y' }];
  assert.deepEqual(sortByPlan(items).map((i) => i.n), ['a', 'b', 'x', 'y']);
});

test('defaultBriefing richtet Fueling nach Dauer und Gefühl nach Intensität', () => {
  const easy = { description: 'd', segments: [{ durationS: 1800, startPct: 0.6, endPct: 0.6, free: false }] };
  const hard = { description: 'd', segments: [{ durationS: 6000, startPct: 1.1, endPct: 1.1, free: false }] };
  assert.match(defaultBriefing(easy).fueling, /reicht Wasser/);
  assert.match(defaultBriefing(easy).gefuehl, /Locker/);
  assert.match(defaultBriefing(hard).fueling, /60 bis 90 g/);
  assert.match(defaultBriefing(hard).gefuehl, /sehr hart/);
});
