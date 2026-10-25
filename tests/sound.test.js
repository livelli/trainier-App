import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soundCue } from '../js/sound.js';

const seg = { durationS: 60 };
const st = (index, rem, extra = {}) => ({ state: 'läuft', index, segRemainingS: rem, segment: seg, next: {}, ...extra });

test('Countdown 3-2-1 einmal pro Sekunde, dann Wechsel', () => {
  let prev = null;
  const cues = [];
  for (const [i, rem] of [[0, 5], [0, 3.8], [0, 2.9], [0, 2.7], [0, 1.5], [0, 0.6], [1, 59.9], [1, 59.6]]) {
    const r = soundCue(prev, st(i, rem));
    prev = r.state;
    cues.push(r.cue);
  }
  assert.deepEqual(cues, [null, null, 'countdown', null, 'countdown', 'countdown', 'wechsel', null]);
});

test('kein Countdown vor dem letzten Abschnitt und bei kurzen Abschnitten', () => {
  assert.equal(soundCue({ index: 0, remaining: 4 }, st(0, 2.5, { next: null })).cue, null);
  assert.equal(soundCue({ index: 0, remaining: 4 }, st(0, 2.5, { segment: { durationS: 5 } })).cue, null);
});

test('in der Pause still, Ende einmal melden', () => {
  assert.equal(soundCue({ index: 0, remaining: 4 }, st(0, 2.5, { state: 'pause' })).cue, null);
  const end = soundCue({ index: 3, remaining: 1 }, st(3, 0, { state: 'fertig' }));
  assert.equal(end.cue, 'fertig');
  assert.equal(soundCue(end.state, st(3, 0, { state: 'fertig' })).cue, null);
});
