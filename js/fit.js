// Schreibt eine aufgezeichnete Fahrt als FIT-Datei (Garmin-Format), die iGPSPORT, Strava,
// intervals.icu und TrainingPeaks einlesen. Nur die Nachrichten, die eine Indoor-Fahrt braucht:
// file_id, event (Start/Stopp), record (jede Sekunde), lap, session, activity.

const FIT_EPOCH = 631065600; // 31.12.1989 00:00 UTC in Unix-Sekunden
const PROFILE_VERSION = 2132;

// [Basistyp, Bytes, ungültiger Wert]
const T = {
  enum: [0x00, 1, 0xff],
  uint8: [0x02, 1, 0xff],
  uint16: [0x84, 2, 0xffff],
  uint32: [0x86, 4, 0xffffffff],
  uint32z: [0x8c, 4, 0],
};

const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];

export function fitCrc(bytes, crc = 0) {
  for (const b of bytes) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[b & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(b >> 4) & 0xf];
  }
  return crc;
}

// Nachrichtentypen: globale Nummer und Felder [Feldnummer, Name, Typ].
const MESSAGES = {
  fileId: { global: 0, fields: [[0, 'type', 'enum'], [1, 'manufacturer', 'uint16'], [2, 'product', 'uint16'], [3, 'serial', 'uint32z'], [4, 'timeCreated', 'uint32']] },
  event: { global: 21, fields: [[253, 'timestamp', 'uint32'], [0, 'event', 'enum'], [1, 'eventType', 'enum']] },
  record: { global: 20, fields: [[253, 'timestamp', 'uint32'], [7, 'power', 'uint16'], [3, 'heartRate', 'uint8'], [4, 'cadence', 'uint8'], [5, 'distance', 'uint32'], [6, 'speed', 'uint16']] },
  lap: { global: 19, fields: [[253, 'timestamp', 'uint32'], [2, 'startTime', 'uint32'], [7, 'elapsed', 'uint32'], [8, 'timer', 'uint32'], [9, 'distance', 'uint32'],
    [0, 'event', 'enum'], [1, 'eventType', 'enum'], [19, 'avgPower', 'uint16'], [20, 'maxPower', 'uint16'], [15, 'avgHr', 'uint8'], [16, 'maxHr', 'uint8'],
    [17, 'avgCad', 'uint8'], [25, 'sport', 'enum']] },
  session: { global: 18, fields: [[253, 'timestamp', 'uint32'], [2, 'startTime', 'uint32'], [7, 'elapsed', 'uint32'], [8, 'timer', 'uint32'], [9, 'distance', 'uint32'],
    [0, 'event', 'enum'], [1, 'eventType', 'enum'], [5, 'sport', 'enum'], [6, 'subSport', 'enum'], [20, 'avgPower', 'uint16'], [21, 'maxPower', 'uint16'],
    [16, 'avgHr', 'uint8'], [17, 'maxHr', 'uint8'], [18, 'avgCad', 'uint8'], [11, 'calories', 'uint16'], [34, 'np', 'uint16'], [35, 'tss', 'uint16'],
    [36, 'intensity', 'uint16'], [45, 'ftp', 'uint16'], [25, 'firstLap', 'uint16'], [26, 'numLaps', 'uint16']] },
  activity: { global: 34, fields: [[253, 'timestamp', 'uint32'], [0, 'timer', 'uint32'], [1, 'numSessions', 'uint16'], [2, 'type', 'enum'],
    [3, 'event', 'enum'], [4, 'eventType', 'enum'], [5, 'localTimestamp', 'uint32']] },
};

const EVENT = { timer: 0, session: 8, lap: 9, activity: 26 };
const EVENT_TYPE = { start: 0, stop: 1, stopAll: 4 };
const SPORT_CYCLING = 2;
const SUB_SPORT_INDOOR = 6;

class Writer {
  constructor() {
    this.bytes = [];
    this.local = new Map();
  }

  push(type, value) {
    const [, size, invalid] = T[type];
    let v = value === null || value === undefined || Number.isNaN(value) ? invalid : Math.round(value);
    if (v < 0 || v > invalid && type !== 'uint32z') v = invalid;
    for (let i = 0; i < size; i++) this.bytes.push((v / 2 ** (8 * i)) & 0xff);
  }

  write(name, values) {
    const msg = MESSAGES[name];
    if (!this.local.has(name)) {
      const localType = this.local.size;
      this.local.set(name, localType);
      this.bytes.push(0x40 | localType, 0, 0, msg.global & 0xff, msg.global >> 8, msg.fields.length);
      for (const [num, , type] of msg.fields) this.bytes.push(num, T[type][1], T[type][0]);
    }
    this.bytes.push(this.local.get(name));
    for (const [, key, type] of msg.fields) this.push(type, values[key]);
  }
}

const fitTime = (unixS) => unixS - FIT_EPOCH;
const scaled = (v, f) => (v === null || v === undefined ? null : v * f);

// record: { startedAt, ftp, samples, summary } wie von Recording.toRecord.
export function encodeFit(record) {
  const { samples, summary: sum } = record;
  if (!samples.length) throw new Error('Die Fahrt enthält keine Messwerte.');
  const w = new Writer();
  const first = samples[0].t;
  const last = samples[samples.length - 1].t;

  w.write('fileId', { type: 4, manufacturer: 255, product: 1, serial: 1, timeCreated: fitTime(first) });
  w.write('event', { timestamp: fitTime(first), event: EVENT.timer, eventType: EVENT_TYPE.start });
  let distance = 0;
  let prevT = null;
  for (const s of samples) {
    // Pausen als Stopp und Start der Uhr eintragen, damit die Fahrzeit stimmt.
    if (prevT !== null && s.t - prevT > 1) {
      w.write('event', { timestamp: fitTime(prevT), event: EVENT.timer, eventType: EVENT_TYPE.stopAll });
      w.write('event', { timestamp: fitTime(s.t), event: EVENT.timer, eventType: EVENT_TYPE.start });
    }
    if (s.spd) distance += s.spd / 3.6;
    w.write('record', {
      timestamp: fitTime(s.t),
      power: s.p,
      heartRate: s.hr,
      cadence: s.cad,
      distance: distance * 100,
      // Ohne Tempo 0 schreiben: Den „ungültig“-Wert lesen manche Programme als 236 km/h.
      speed: s.spd ? (s.spd / 3.6) * 1000 : 0,
    });
    prevT = s.t;
  }
  w.write('event', { timestamp: fitTime(last), event: EVENT.timer, eventType: EVENT_TYPE.stopAll });

  const totals = {
    timestamp: fitTime(last),
    startTime: fitTime(first),
    elapsed: sum.elapsedS * 1000,
    timer: sum.timerS * 1000,
    distance: sum.distanceM * 100,
    avgPower: sum.avgPower,
    maxPower: sum.maxPower,
    avgHr: sum.avgHr,
    maxHr: sum.maxHr,
    avgCad: sum.avgCad,
  };
  w.write('lap', { ...totals, event: EVENT.lap, eventType: EVENT_TYPE.stop, sport: SPORT_CYCLING });
  w.write('session', {
    ...totals,
    event: EVENT.session,
    eventType: EVENT_TYPE.stop,
    sport: SPORT_CYCLING,
    subSport: SUB_SPORT_INDOOR,
    // Kalorien: mechanische Arbeit in kJ entspricht bei rund 24 % Wirkungsgrad etwa den kcal.
    calories: sum.kj,
    np: sum.np,
    tss: scaled(sum.tss, 10),
    intensity: scaled(sum.intensity, 1000),
    ftp: record.ftp,
    firstLap: 0,
    numLaps: 1,
  });
  const offsetS = -new Date(record.startedAt).getTimezoneOffset() * 60;
  w.write('activity', {
    timestamp: fitTime(last),
    timer: sum.timerS * 1000,
    numSessions: 1,
    type: 0,
    event: EVENT.activity,
    eventType: EVENT_TYPE.stop,
    localTimestamp: fitTime(last) + offsetS,
  });

  const data = w.bytes;
  const header = [14, 0x20, PROFILE_VERSION & 0xff, PROFILE_VERSION >> 8,
    data.length & 0xff, (data.length >> 8) & 0xff, (data.length >> 16) & 0xff, (data.length >>> 24) & 0xff,
    0x2e, 0x46, 0x49, 0x54];
  const headerCrc = fitCrc(header);
  header.push(headerCrc & 0xff, headerCrc >> 8);
  const all = header.concat(data);
  const crc = fitCrc(all);
  all.push(crc & 0xff, crc >> 8);
  return new Uint8Array(all);
}

// Dateiname wie „2026-10-26_1805_Grundlage-60.fit“.
export function fitFileName(record) {
  const d = new Date(record.startedAt);
  const pad = (v) => String(v).padStart(2, '0');
  const slug = String(record.name || 'Fahrt').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'Fahrt';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}_${slug}.fit`;
}
