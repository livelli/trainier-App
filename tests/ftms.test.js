import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FtmsControl, encodeSetTargetPower, parseControlResponse } from '../js/ftms.js';
import { ErgController } from '../js/erg.js';

const dv = (...bytes) => new DataView(new Uint8Array(bytes).buffer);
const tick = () => new Promise((r) => setTimeout(r, 0));
// Für Tests mit gemockten Timern: wartet ein paar Runden der Ereignisschleife ab.
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

// Simulierter Trainer: beantwortet jeden Befehl per Indication mit dem eingestellten Ergebnis.
function fakeTrainer({ results = {}, answer = true } = {}) {
  const written = [];
  let handler = null;
  const ch = {
    async writeValueWithResponse(bytes) {
      written.push(Array.from(bytes));
      const op = bytes[0];
      const res = typeof results[op] === 'function' ? results[op]() : (results[op] ?? 0x01);
      if (answer) setTimeout(() => handler(dv(0x80, op, res)), 1);
    },
  };
  const dev = {
    async subscribe(_svc, uuid, h) {
      assert.equal(uuid, 0x2ad9);
      handler = h;
      return ch;
    },
  };
  return { dev, written };
}

const noLog = () => {};

test('Zielleistung kodieren', () => {
  assert.deepEqual(Array.from(encodeSetTargetPower(200)), [0x05, 0xc8, 0x00]);
  assert.deepEqual(Array.from(encodeSetTargetPower(600)), [0x05, 0x58, 0x02]);
});

test('Antwort lesen', () => {
  assert.deepEqual(parseControlResponse(dv(0x80, 0x05, 0x01)), { requestOp: 5, result: 1, ok: true });
  assert.equal(parseControlResponse(dv(0x05, 0x00)), null);
});

test('Kontrolle wird vor dem ersten Befehl angefordert', async () => {
  const t = fakeTrainer();
  const c = new FtmsControl({ log: noLog });
  await c.attach({}, t.dev);
  await c.setTargetPower(150);
  await c.setTargetPower(160);
  assert.deepEqual(t.written, [[0x00], [0x05, 150, 0], [0x05, 160, 0]]);
});

test('Kontrolle verloren: einmal neu anfordern und wiederholen', async () => {
  let first = true;
  const t = fakeTrainer({ results: { 0x05: () => { const r = first ? 0x05 : 0x01; first = false; return r; } } });
  const c = new FtmsControl({ log: noLog });
  await c.attach({}, t.dev);
  await c.setTargetPower(150);
  assert.deepEqual(t.written, [[0x00], [0x05, 150, 0], [0x00], [0x05, 150, 0]]);
});

test('Fehlerantwort wird gemeldet', async () => {
  const t = fakeTrainer({ results: { 0x08: 0x02 } });
  const c = new FtmsControl({ log: noLog });
  await c.attach({}, t.dev);
  await assert.rejects(c.pause(), /nicht unterstützt/);
});

test('Ohne Verbindung kein Befehl', async () => {
  const c = new FtmsControl({ log: noLog });
  await assert.rejects(c.setTargetPower(100), /nicht verbunden/);
});

test('ERG schickt nur den neuesten Zielwert', async () => {
  const t = fakeTrainer();
  const c = new FtmsControl({ log: noLog });
  await c.attach({}, t.dev);
  const erg = new ErgController({ control: c, log: noLog });
  await erg.enable();
  t.written.length = 0;
  erg.adjust(10);
  erg.adjust(10);
  erg.adjust(10);
  while (erg.busy) await tick();
  const targets = t.written.filter((w) => w[0] === 0x05).map((w) => w[1] | (w[2] << 8));
  assert.equal(targets.at(-1), 130);
  assert.ok(targets.length <= 2, `zu viele Befehle: ${targets}`);
  assert.equal(erg.sentTarget, 130);
});

test('ERG begrenzt auf den Leistungsbereich des Trainers', () => {
  const erg = new ErgController({ control: { ready: false }, log: noLog });
  erg.setRange(50, 600);
  erg.setTarget(20);
  assert.equal(erg.target, 50);
  erg.setTarget(900);
  assert.equal(erg.target, 600);
  erg.setTarget(200);
  erg.scale(0.9);
  assert.equal(erg.target, 180);
});

test('Pause ohne Unterstützung setzt Minimum', async () => {
  const t = fakeTrainer({ results: { 0x08: 0x02 } });
  const c = new FtmsControl({ log: noLog });
  await c.attach({}, t.dev);
  const erg = new ErgController({ control: c, log: noLog });
  erg.setTarget(200);
  await erg.enable();
  await erg.togglePause();
  const last = t.written.at(-1);
  assert.deepEqual(last, [0x05, 50, 0]);
  assert.equal(erg.paused, true);
  await erg.togglePause();
  while (erg.busy) await tick();
  assert.deepEqual(t.written.at(-1), [0x05, 200, 0]);
});

test('Nach Wiederverbinden wird das Ziel erneut gesendet', async () => {
  const t = fakeTrainer();
  const c = new FtmsControl({ log: noLog });
  await c.attach({}, t.dev);
  const erg = new ErgController({ control: c, log: noLog });
  erg.setTarget(150);
  await erg.enable();
  c.detach();
  const t2 = fakeTrainer();
  await c.attach({}, t2.dev);
  await erg.resync();
  assert.deepEqual(t2.written, [[0x00], [0x07], [0x05, 150, 0]]);
});

test('Beim Verbinden mit ERG aus wird ein Stopp gesendet', async () => {
  const t = fakeTrainer();
  const c = new FtmsControl({ log: noLog });
  await c.attach({}, t.dev);
  const erg = new ErgController({ control: c, log: noLog });
  await erg.resync();
  assert.deepEqual(t.written, [[0x00], [0x08, 0x01]]);
});

test('Stopp scheitert: kleinste Leistung setzen', async () => {
  const t = fakeTrainer({ results: { 0x08: 0x04 } });
  const c = new FtmsControl({ log: noLog });
  await c.attach({}, t.dev);
  const erg = new ErgController({ control: c, log: noLog });
  erg.setTarget(300);
  await erg.enable();
  await erg.disable();
  assert.deepEqual(t.written.at(-1), [0x05, 50, 0]);
  assert.match(erg.error, /hält jetzt 50 W/);
});

test('Keine Antwort: Timeout, verspätete Antwort zählt nicht für den nächsten Befehl', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const written = [];
  let handler;
  let answerNext = false;
  const ch = { async writeValueWithResponse(b) { written.push(Array.from(b)); if (answerNext) queueMicrotask(() => handler(dv(0x80, b[0], 0x01))); } };
  const c = new FtmsControl({ log: noLog });
  await c.attach({}, { async subscribe(_s, _u, h) { handler = h; return ch; } });
  c.hasControl = true;
  const p1 = c.setTargetPower(300);
  await settle();
  t.mock.timers.tick(3001);
  await assert.rejects(p1, /keine Antwort/);
  // Verspätete Antwort auf 300 W kommt jetzt an, danach der neue Befehl
  handler(dv(0x80, 0x05, 0x01));
  answerNext = true;
  await c.setTargetPower(200);
  assert.deepEqual(written, [[0x05, 44, 1], [0x05, 200, 0]]);
});

test('Hängender Schreibzugriff blockiert die Warteschlange nicht', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let handler;
  let hang = true;
  const ch = { writeValueWithResponse(b) { if (hang) return new Promise(() => {}); queueMicrotask(() => handler(dv(0x80, b[0], 0x01))); return Promise.resolve(); } };
  const c = new FtmsControl({ log: noLog });
  await c.attach({}, { async subscribe(_s, _u, h) { handler = h; return ch; } });
  c.hasControl = true;
  const p1 = c.setTargetPower(300);
  await settle();
  t.mock.timers.tick(3001);
  await assert.rejects(p1, /keine Antwort/);
  hang = false;
  await c.stop();
});

test('Verlorene Antwort blockiert spätere gleiche Befehle nicht dauerhaft', async () => {
  const written = [];
  let handler;
  let drop = true;
  const ch = { async writeValueWithResponse(b) { written.push(Array.from(b)); if (!drop) queueMicrotask(() => handler(dv(0x80, b[0], 0x01))); } };
  const c = new FtmsControl({ log: noLog });
  await c.attach({}, { async subscribe(_s, _u, h) { handler = h; return ch; } });
  c.hasControl = true;
  // Zeitfenster für verspätete Antworten simuliert abgelaufen
  c.late[0x05] = Date.now() - 1;
  drop = false;
  await c.setTargetPower(200);
});
