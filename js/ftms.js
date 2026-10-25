// Steuerung des Trainers über den FTMS Control Point (0x2AD9).
// Jeder Befehl wird mit Antwort geschrieben, der Trainer bestätigt ihn per Indication.
// Befehle laufen strikt nacheinander, weil Web Bluetooth keine parallelen GATT-Operationen verträgt.

import { toHex } from './parsers.js';

export const OP = {
  REQUEST_CONTROL: 0x00,
  RESET: 0x01,
  SET_TARGET_POWER: 0x05,
  START_RESUME: 0x07,
  STOP_PAUSE: 0x08,
  RESPONSE: 0x80,
};

const OP_NAMES = {
  0x00: 'Kontrolle anfordern',
  0x01: 'Zurücksetzen',
  0x05: 'Zielleistung setzen',
  0x07: 'Start',
  0x08: 'Stopp/Pause',
};

export const RESULT_TEXT = {
  0x01: 'erfolgreich',
  0x02: 'vom Trainer nicht unterstützt',
  0x03: 'ungültiger Wert',
  0x04: 'fehlgeschlagen',
  0x05: 'nicht erlaubt (keine Kontrolle)',
};

const RESPONSE_TIMEOUT_MS = 3000;
const LATE_WINDOW_MS = 2000;

export function encodeSetTargetPower(watts) {
  const w = Math.round(watts);
  return new Uint8Array([OP.SET_TARGET_POWER, w & 0xff, (w >> 8) & 0xff]);
}

export function parseControlResponse(dv) {
  if (dv.byteLength < 3 || dv.getUint8(0) !== OP.RESPONSE) return null;
  const requestOp = dv.getUint8(1);
  const result = dv.getUint8(2);
  return { requestOp, result, ok: result === 0x01 };
}

export class FtmsControl {
  constructor({ log }) {
    this.log = log;
    this.ch = null;
    this.hasControl = false;
    this.pending = null;
    this.queue = Promise.resolve();
    this.controlRequest = null;
    this.late = {};
  }

  // Nach jedem (Wieder-)Verbinden aufrufen. dev ist die BleDevice-Instanz des Trainers.
  async attach(ftmsService, dev) {
    this.detach();
    this.ch = await dev.subscribe(ftmsService, 0x2ad9, (dv) => this._onResponse(dv));
  }

  detach() {
    this.ch = null;
    this.hasControl = false;
    this.late = {};
    if (this.pending) {
      this.pending.reject(new Error('Trainer getrennt'));
      this.pending = null;
    }
  }

  get ready() {
    return Boolean(this.ch);
  }

  _onResponse(dv) {
    const r = parseControlResponse(dv);
    if (!r) {
      this.log('Trainer', `Unbekannte Antwort auf Steuerbefehl: ${toHex(dv)}`);
      return;
    }
    const name = OP_NAMES[r.requestOp] || r.requestOp;
    // Verspätete Antwort auf einen Befehl, der schon als „keine Antwort“ abgebrochen wurde:
    // darf nicht als Antwort auf den nächsten gleichartigen Befehl zählen.
    if (this.late[r.requestOp] > Date.now()) {
      delete this.late[r.requestOp];
      this.log('Trainer', `Verspätete Antwort: ${name} → ${RESULT_TEXT[r.result] || r.result} (ignoriert)`);
      return;
    }
    this.log('Trainer', `Antwort: ${name} → ${RESULT_TEXT[r.result] || r.result}`);
    if (this.pending && this.pending.op === r.requestOp) {
      this.pending.resolve(r);
      this.pending = null;
    }
  }

  // Reiht einen Befehl ein; ein Fehler eines Befehls blockiert die folgenden nicht.
  send(bytes) {
    const run = () => this._sendNow(Uint8Array.from(bytes));
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async _sendNow(bytes) {
    if (!this.ch) throw new Error('Trainer nicht verbunden');
    const op = bytes[0];
    const response = new Promise((resolve, reject) => {
      this.pending = { op, resolve, reject };
    });
    response.catch(() => {}); // Abbruch durch detach() wird über das race unten gemeldet
    let timer;
    const timeout = new Promise((_, reject) => {
      // Der Timeout deckt Schreiben und Antwort ab, damit ein hängender Schreibzugriff
      // die Warteschlange (und damit Stopp und Pause) nicht für immer blockiert.
      timer = setTimeout(() => reject(new Error(`${OP_NAMES[op]}: keine Antwort vom Trainer`)), RESPONSE_TIMEOUT_MS);
    });
    let r;
    try {
      r = await Promise.race([
        this.ch.writeValueWithResponse(bytes).then(() => response),
        timeout,
      ]);
    } catch (err) {
      if (this.pending && this.pending.op === op) {
        this.pending = null;
        // Eine verspätete Antwort wird nur kurz erwartet; kommt keine, gilt die nächste wieder normal.
        if (/keine Antwort/.test(err.message)) this.late[op] = Date.now() + LATE_WINDOW_MS;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) {
      const err = new Error(`${OP_NAMES[op]}: ${RESULT_TEXT[r.result] || r.result}`);
      err.result = r.result;
      throw err;
    }
    return r;
  }

  ensureControl() {
    if (this.hasControl) return Promise.resolve();
    // Gleichzeitige Aufrufe teilen sich eine Anfrage.
    if (!this.controlRequest) {
      this.controlRequest = this.send([OP.REQUEST_CONTROL])
        .then(() => { this.hasControl = true; })
        .finally(() => { this.controlRequest = null; });
    }
    return this.controlRequest;
  }

  // Führt einen Befehl aus und fordert die Kontrolle einmal neu an, falls der Trainer sie verloren hat.
  async _withControl(bytes) {
    await this.ensureControl();
    try {
      return await this.send(bytes);
    } catch (err) {
      if (err.result !== 0x05) throw err;
      this.hasControl = false;
      await this.ensureControl();
      return this.send(bytes);
    }
  }

  setTargetPower(watts) {
    return this._withControl(encodeSetTargetPower(watts));
  }

  start() {
    return this._withControl([OP.START_RESUME]);
  }

  pause() {
    return this._withControl([OP.STOP_PAUSE, 0x02]);
  }

  stop() {
    return this._withControl([OP.STOP_PAUSE, 0x01]);
  }
}

