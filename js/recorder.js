// Zeichnet eine Fahrt auf: ein Messpunkt pro Sekunde, nur solange die Fahrt läuft (nicht in der Pause).
// Ein Messpunkt: { t: Unix-Sekunde, p: Watt, hr: Puls, cad: Kadenz, spd: km/h, tgt: Ziel in Watt }.
// Fehlende Werte sind null.

// Nach einer längeren Lücke (Laptop eingeschlafen, Tab gedrosselt) höchstens so viele Sekunden auffüllen.
const MAX_FILL_S = 10;

export class Recording {
  constructor({ name, ftp, startedAt }) {
    this.id = `fahrt-${startedAt}`;
    this.name = name;
    this.ftp = ftp;
    this.startedAt = startedAt;
    this.samples = [];
    this.lastS = null;
    this.paused = false;
  }

  // Für jede volle Sekunde seit dem letzten Aufruf einen Messpunkt mit den aktuellen Werten anhängen.
  // Gibt die Zahl der neuen Messpunkte zurück.
  tick(nowMs, values, running) {
    const s = Math.floor(nowMs / 1000);
    if (!running) {
      this.paused = true;
      return 0;
    }
    let from;
    if (this.lastS === null) from = s;
    // Nach der Pause nicht auffüllen und keine Sekunde doppelt schreiben.
    else if (this.paused) from = Math.max(this.lastS + 1, s);
    else from = Math.max(this.lastS + 1, s - MAX_FILL_S + 1);
    this.paused = false;
    if (from > s) return 0;
    // Startzeit ist der erste echte Messpunkt, nicht das Öffnen der Fahranzeige.
    if (!this.samples.length) {
      this.startedAt = from * 1000;
      this.id = `fahrt-${this.startedAt}`;
    }
    for (let t = from; t <= s; t++) this.samples.push({ t, ...values });
    this.lastS = s;
    return s - from + 1;
  }

  toRecord(complete) {
    return {
      id: this.id,
      name: this.name,
      ftp: this.ftp,
      startedAt: this.startedAt,
      complete,
      summary: summarize(this.samples, this.ftp),
      samples: this.samples,
    };
  }
}

// Normalized Power: gleitender 30-s-Schnitt, davon die vierte Potenz mitteln, dann die vierte Wurzel.
export function normalizedPower(powers) {
  if (powers.length < 30) return null;
  let sum = 0;
  for (let i = 0; i < 30; i++) sum += powers[i];
  let acc = 0;
  let n = 0;
  for (let i = 29; i < powers.length; i++) {
    if (i > 29) sum += powers[i] - powers[i - 30];
    acc += (sum / 30) ** 4;
    n++;
  }
  return (acc / n) ** 0.25;
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const round = (v) => (v === null ? null : Math.round(v));

export function summarize(samples, ftp) {
  const n = samples.length;
  if (!n) return null;
  const has = (k) => samples.some((s) => s[k] !== null && s[k] !== undefined);
  const list = (k) => samples.map((s) => s[k]).filter((v) => v !== null && v !== undefined);
  // Fehlende Watt zählen als 0 (Rollen lassen), wie bei Garmin und Strava.
  const powers = samples.map((s) => s.p ?? 0);
  const withPower = has('p');
  const hr = list('hr');
  const cad = list('cad').filter((c) => c > 0);
  let distanceM = 0;
  for (const s of samples) if (s.spd) distanceM += s.spd / 3.6;
  const np = withPower ? normalizedPower(powers) : null;
  const intensity = np && ftp ? np / ftp : null;
  return {
    timerS: n,
    elapsedS: samples[n - 1].t - samples[0].t + 1,
    distanceM: Math.round(distanceM),
    avgPower: withPower ? round(avg(powers)) : null,
    maxPower: withPower ? Math.max(...powers) : null,
    np: round(np),
    intensity: intensity === null ? null : Math.round(intensity * 100) / 100,
    tss: intensity === null ? null : Math.round(((n * np * intensity) / (ftp * 3600)) * 100),
    kj: withPower ? Math.round(powers.reduce((x, y) => x + y, 0) / 1000) : null,
    avgHr: round(avg(hr)),
    maxHr: hr.length ? Math.max(...hr) : null,
    avgCad: round(avg(cad)),
  };
}
