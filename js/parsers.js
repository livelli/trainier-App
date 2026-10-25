// Auswertung der Bluetooth-Datenpakete (reine Funktionen, ohne Browser-Abhängigkeit).
// Alle Funktionen erwarten ein DataView, so wie Web Bluetooth es liefert.

// FTMS Indoor Bike Data (0x2AD2)
export function parseIndoorBikeData(dv) {
  const flags = dv.getUint16(0, true);
  let i = 2;
  const out = { flags };

  // Bit 0 ist umgekehrt: 0 bedeutet, dass die Geschwindigkeit enthalten ist.
  if (!(flags & 0x0001)) { out.speedKmh = dv.getUint16(i, true) / 100; i += 2; }
  if (flags & 0x0002) { out.avgSpeedKmh = dv.getUint16(i, true) / 100; i += 2; }
  if (flags & 0x0004) { out.cadence = dv.getUint16(i, true) / 2; i += 2; }
  if (flags & 0x0008) { out.avgCadence = dv.getUint16(i, true) / 2; i += 2; }
  if (flags & 0x0010) {
    out.distanceM = dv.getUint8(i) | (dv.getUint8(i + 1) << 8) | (dv.getUint8(i + 2) << 16);
    i += 3;
  }
  if (flags & 0x0020) { out.resistance = dv.getInt16(i, true); i += 2; }
  if (flags & 0x0040) { out.power = dv.getInt16(i, true); i += 2; }
  if (flags & 0x0080) { out.avgPower = dv.getInt16(i, true); i += 2; }
  if (flags & 0x0100) {
    out.energyTotalKcal = dv.getUint16(i, true);
    out.energyPerHourKcal = dv.getUint16(i + 2, true);
    out.energyPerMinuteKcal = dv.getUint8(i + 4);
    i += 5;
  }
  if (flags & 0x0200) { out.heartRate = dv.getUint8(i); i += 1; }
  if (flags & 0x0400) { out.met = dv.getUint8(i) / 10; i += 1; }
  if (flags & 0x0800) { out.elapsedS = dv.getUint16(i, true); i += 2; }
  if (flags & 0x1000) { out.remainingS = dv.getUint16(i, true); i += 2; }
  return out;
}

// FTMS Fitness Machine Feature (0x2ACC)
const MACHINE_FEATURES = [
  [0, 'Durchschnittsgeschwindigkeit'], [1, 'Kadenz'], [2, 'Gesamtstrecke'],
  [3, 'Steigung'], [4, 'Höhenmeter'], [5, 'Tempo'], [6, 'Schritte'],
  [7, 'Widerstandsstufe'], [8, 'Schrittzahl'], [9, 'Kalorien'],
  [10, 'Herzfrequenz'], [11, 'MET'], [12, 'Verstrichene Zeit'],
  [13, 'Restzeit'], [14, 'Leistungsmessung'], [15, 'Kraft am Riemen'],
  [16, 'Nutzerdaten'],
];
const TARGET_FEATURES = [
  [0, 'Zielgeschwindigkeit'], [1, 'Zielsteigung'], [2, 'Zielwiderstand'],
  [3, 'Zielleistung (ERG)'], [4, 'Zielherzfrequenz'], [5, 'Ziel-Kalorien'],
  [6, 'Ziel-Schritte'], [7, 'Ziel-Schrittzahl'], [8, 'Ziel-Strecke'],
  [9, 'Ziel-Trainingszeit'], [10, 'Zeit in zwei HF-Zonen'],
  [11, 'Zeit in drei HF-Zonen'], [12, 'Zeit in fünf HF-Zonen'],
  [13, 'Simulation (Steigung/Wind)'], [14, 'Radumfang'],
  [15, 'Spin-down-Steuerung'], [16, 'Zielkadenz'],
];

export function parseMachineFeature(dv) {
  const machine = dv.getUint32(0, true);
  const target = dv.byteLength >= 8 ? dv.getUint32(4, true) : 0;
  const names = (bits, table) => table.filter(([b]) => bits & (1 << b)).map(([, n]) => n);
  return {
    machine: names(machine, MACHINE_FEATURES),
    target: names(target, TARGET_FEATURES),
    powerTargetSupported: Boolean(target & (1 << 3)),
    simulationSupported: Boolean(target & (1 << 13)),
  };
}

// FTMS Supported Power Range (0x2AD8)
export function parsePowerRange(dv) {
  return {
    min: dv.getInt16(0, true),
    max: dv.getInt16(2, true),
    step: dv.getUint16(4, true),
  };
}

// Heart Rate Measurement (0x2A37)
export function parseHeartRate(dv) {
  const flags = dv.getUint8(0);
  const bpm = flags & 0x01 ? dv.getUint16(1, true) : dv.getUint8(1);
  // Bit 2: Gurt meldet Hautkontakt überhaupt, Bit 1: Hautkontakt erkannt.
  const contactSupported = Boolean(flags & 0x04);
  const contact = contactSupported ? Boolean(flags & 0x02) : null;
  return { bpm, contact };
}

// CSC Measurement (0x2A5B): liefert die Rohzähler, die Kadenz rechnet CadenceCalculator.
export function parseCscMeasurement(dv) {
  const flags = dv.getUint8(0);
  let i = 1;
  const out = {};
  if (flags & 0x01) {
    out.wheelRevs = dv.getUint32(i, true);
    out.wheelTime = dv.getUint16(i + 4, true);
    i += 6;
  }
  if (flags & 0x02) {
    out.crankRevs = dv.getUint16(i, true);
    out.crankTime = dv.getUint16(i + 2, true); // Einheit 1/1024 s
    i += 4;
  }
  return out;
}

// Rechnet aus den Kurbelzählern eine Kadenz in U/min.
// Zähler und Zeit laufen bei 65535 über, daher die Maskierung.
export class CadenceCalculator {
  constructor({ timeoutMs = 3000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.prev = null;
    this.cadence = 0;
    this.lastChangeAt = 0;
  }

  update(crankRevs, crankTime, nowMs) {
    if (this.prev) {
      const dRevs = (crankRevs - this.prev.revs) & 0xffff;
      const dTime = (crankTime - this.prev.time) & 0xffff;
      if (dRevs > 0 && dTime > 0) {
        if (nowMs - this.lastChangeAt > 60000) {
          // Nach mehr als 60 s ohne Umdrehung kann die Sensorzeit (läuft nach 64 s über) nicht
          // mehr eindeutig verglichen werden. Erste Umdrehung nur merken, nicht rechnen.
          this.cadence = 0;
        } else {
          const rpm = (dRevs * 60 * 1024) / dTime;
          // Unplausible Sprünge (z. B. nach einem Verbindungsabbruch) verwerfen.
          if (rpm <= 250) this.cadence = rpm;
        }
        this.lastChangeAt = nowMs;
      }
    } else {
      this.lastChangeAt = nowMs;
    }
    this.prev = { revs: crankRevs, time: crankTime };
    return this.current(nowMs);
  }

  current(nowMs) {
    if (nowMs - this.lastChangeAt > this.timeoutMs) this.cadence = 0;
    return Math.round(this.cadence);
  }

  reset() {
    this.prev = null;
    this.cadence = 0;
  }
}

export function toHex(dv) {
  const bytes = [];
  for (let i = 0; i < dv.byteLength; i++) bytes.push(dv.getUint8(i).toString(16).padStart(2, '0'));
  return bytes.join(' ');
}
