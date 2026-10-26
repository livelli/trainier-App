// Workouts: Einlesen von Zwift-Dateien (.zwo) und Umwandeln in eine flache Liste von Abschnitten.
// Ein Abschnitt: { durationS, startPct, endPct, free, label, cadence } mit Leistung als Anteil der FTP.
// cadence ist { low, high } in U/min, wenn die Datei eine Trittfrequenz vorgibt, sonst null.
// startPct === endPct ist ein gleichbleibender Abschnitt, sonst eine Rampe.

function attrs(text) {
  const out = {};
  for (const m of text.matchAll(/([A-Za-z_][\w-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    out[m[1].toLowerCase()] = m[3] ?? m[4];
  }
  return out;
}

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(m[1].trim()) : '';
}

export function parseZwo(xml) {
  xml = xml.replace(/<!--[\s\S]*?-->/g, '');
  const body = xml.match(/<workout\b[^>]*>([\s\S]*?)<\/workout>/i);
  if (!body) throw new Error('Keine <workout>-Angaben in der Datei gefunden');
  const segments = [];
  // Nur die Abschnitts-Elemente direkt lesen; <textevent> innerhalb wird übersprungen.
  const re = /<(Warmup|Cooldown|SteadyState|Ramp|IntervalsT|FreeRide|MaxEffort)\b([^>]*?)(\/\s*>|>)/gi;
  for (const m of body[1].matchAll(re)) {
    const type = m[1].toLowerCase();
    const a = attrs(m[2]);
    const note = segmentNote(body[1], m);
    const d = num(a.duration);
    const cad = cadenceAttr(a.cadence, a.cadencelow, a.cadencehigh);
    const before = segments.length;
    if (type === 'warmup') {
      segments.push(ramp(d, num(a.powerlow, 0.5), num(a.powerhigh, 0.75), 'Einfahren'));
    } else if (type === 'cooldown') {
      segments.push(ramp(d, num(a.powerlow, 0.75), num(a.powerhigh, 0.5), 'Ausfahren'));
    } else if (type === 'ramp') {
      segments.push(ramp(d, num(a.powerlow), num(a.powerhigh), 'Rampe'));
    } else if (type === 'steadystate') {
      const p = num(a.power, num(a.powerlow));
      segments.push(steady(d, p, null));
    } else if (type === 'intervalst') {
      const reps = Math.max(1, Math.round(num(a.repeat, 1)));
      // Manche Dateien geben Intervalle als Rampe an (PowerOnLow/PowerOnHigh).
      const onLow = num(a.onpower, num(a.poweronlow, num(a.powerhigh)));
      const onHigh = num(a.onpower, num(a.poweronhigh, onLow));
      const offLow = num(a.offpower, num(a.powerofflow, num(a.powerlow)));
      const offHigh = num(a.offpower, num(a.poweroffhigh, offLow));
      const restCad = cadenceAttr(a.cadenceresting);
      for (let i = 0; i < reps; i++) {
        segments.push({ ...ramp(num(a.onduration), onLow, onHigh, `Intervall ${i + 1} von ${reps}`), cadence: cad, note });
        segments.push({ ...ramp(num(a.offduration), offLow, offHigh, 'Erholung'), cadence: restCad });
      }
      continue;
    } else if (type === 'maxeffort') {
      // Ohne Wattziel, aber alles geben.
      segments.push({ durationS: d, startPct: 0, endPct: 0, free: true, max: true, label: 'Vollgas' });
    } else {
      segments.push({ durationS: d, startPct: 0, endPct: 0, free: true, label: 'Freie Fahrt' });
    }
    for (let i = before; i < segments.length; i++) {
      segments[i].cadence = cad;
      segments[i].note = note;
    }
  }
  const valid = segments.filter((s) => s.durationS > 0);
  if (!valid.length) throw new Error('Das Workout enthält keine Abschnitte');
  labelSteady(valid);
  return {
    name: tagText(xml, 'name') || 'Workout',
    description: tagText(xml, 'description'),
    segments: valid,
  };
}

// Hinweistext für einen Abschnitt aus <textevent message="…"> (Zwift-Format) im Element.
// Ohne Hinweis null.
function segmentNote(body, match) {
  if (match[3] !== '>') return null;
  const start = match.index + match[0].length;
  const close = new RegExp(`</${match[1]}\\s*>`, 'i').exec(body.slice(start));
  if (!close) return null;
  const texts = [];
  for (const t of body.slice(start, start + close.index).matchAll(/<textevent\b([^>]*?)\/?>/gi)) {
    const a = attrs(t[1]);
    // Nur Hinweise für den Anfang; spätere („Halbzeit!“) passen nicht in die Einblendung davor.
    if (num(a.timeoffset, 0) > 15) continue;
    if (a.message && a.message.trim()) texts.push(decodeEntities(a.message.trim()));
  }
  if (!texts.length) return null;
  const note = texts.join(' ');
  return note.length > 160 ? `${note.slice(0, 157)}…` : note;
}

// Zwift kennt nur Cadence="90" (und CadenceResting für Erholungen); CadenceLow/CadenceHigh erlauben einen Bereich.
function cadenceAttr(single, low, high) {
  const valid = (v) => Number.isFinite(Number(v)) && Number(v) >= 30 && Number(v) <= 160;
  if (valid(low) && valid(high)) return { low: Math.min(Number(low), Number(high)), high: Math.max(Number(low), Number(high)) };
  if (valid(single)) return { low: Number(single), high: Number(single) };
  return null;
}

// Trittfrequenz für einen Abschnitt: aus der Datei, sonst eine Empfehlung nach Intensität.
export function cadenceTarget(segment) {
  if (!segment || segment.free) return null;
  if (segment.cadence) return segment.cadence;
  const pct = (segment.startPct + segment.endPct) / 2;
  if (pct > 1.05) return { low: 90, high: 100 };
  if (pct > 0.75) return { low: 85, high: 95 };
  return { low: 80, high: 90 };
}

export function formatCadence(c) {
  if (!c) return '';
  return c.low === c.high ? `${c.low} U/min` : `${c.low}–${c.high} U/min`;
}

function ramp(durationS, from, to, label) {
  return { durationS, startPct: from, endPct: to, free: false, label };
}

function steady(durationS, pct, label) {
  return { durationS, startPct: pct, endPct: pct, free: false, label };
}

// Gleichbleibende Abschnitte ohne eigenen Namen nach ihrer Höhe benennen.
function labelSteady(segments) {
  for (const s of segments) {
    if (s.label) continue;
    s.label = s.startPct < 0.6 ? 'Erholung' : 'Block';
  }
}

export function totalDuration(workout) {
  return workout.segments.reduce((sum, s) => sum + s.durationS, 0);
}

export function formatTime(totalS) {
  const s = Math.max(0, Math.round(totalS));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// Erholung zählt nur als „ganz locker“, wenn sie wirklich locker ist (bei Über-Unter-Intervallen nicht).
function isEasy(segment, pct) {
  return pct <= 0.55 || (segment.label === 'Erholung' && pct <= 0.65);
}

// Wie sich ein Abschnitt anfühlen soll, nach Intensität (Anteil der FTP).
export function segmentFeel(segment) {
  if (!segment) return '';
  if (segment.max) return 'Maximal. Alles geben, so schnell und hart du kannst.';
  if (segment.free) return 'Ohne Wattziel: Fahr nach Gefühl.';
  const pct = Math.max(segment.startPct, segment.endPct);
  let feel;
  if (isEasy(segment, pct)) feel = 'Ganz locker. Beine lockern, ruhig atmen, trinken.';
  else if (pct <= 0.75) feel = 'Locker bis angenehm. Reden in ganzen Sätzen geht.';
  else if (pct <= 0.9) feel = 'Zügig, aber kontrolliert. Reden nur noch in kurzen Sätzen.';
  else if (pct <= 1.05) feel = 'Hart und gleichmässig. Nur noch einzelne Worte.';
  else if (pct <= 1.2) feel = 'Sehr hart. Nicht zu schnell anfangen, rund treten.';
  else feel = 'Maximal. Kurz alles geben.';
  if (segment.endPct > segment.startPct + 0.02) feel = `Wird stetig schwerer. ${feel}`;
  else if (segment.endPct < segment.startPct - 0.02) feel = `Wird stetig leichter. ${feel}`;
  return feel;
}

// Anstrengung auf der Skala 1 bis 10 (wie „Perceived Exertion“), passend zu segmentFeel.
export function segmentEffort(segment) {
  if (!segment) return null;
  if (segment.max) return { level: 10, word: 'maximal' };
  if (segment.free) return null;
  const pct = Math.max(segment.startPct, segment.endPct);
  if (isEasy(segment, pct)) return { level: 2, word: 'sehr leicht' };
  if (pct <= 0.75) return { level: 4, word: 'leicht' };
  if (pct <= 0.9) return { level: 6, word: 'mittel' };
  if (pct <= 1.05) return { level: 8, word: 'schwer' };
  if (pct <= 1.2) return { level: 9, word: 'sehr schwer' };
  return { level: 10, word: 'maximal' };
}

// Wann die Einblendung zum nächsten Abschnitt erscheint: 10 s vorher („gleich“) bis 5 s nach dem Wechsel („jetzt“).
// Am Anfang des Workouts wird der erste Abschnitt 6 s lang gezeigt.
export const PREVIEW_BEFORE_S = 10;
export const PREVIEW_AFTER_S = 5;

// Bei kurzen Abschnitten (unter 30 s) keine Einblendung, sonst steht sie fast dauernd da; die Ansage reicht.
const PREVIEW_MIN_S = 30;

export function previewFor(st) {
  if (!st || st.state !== 'läuft') return null;
  if (st.index === 0 && st.segElapsedS < 6 && st.segment.durationS >= PREVIEW_MIN_S) return { segment: st.segment, index: 0, mode: 'jetzt' };
  if (st.next && st.next.durationS >= PREVIEW_MIN_S && st.segRemainingS <= PREVIEW_BEFORE_S && st.segment.durationS >= 15) {
    return { segment: st.next, index: st.index + 1, mode: 'gleich', inS: Math.max(1, Math.round(st.segRemainingS)) };
  }
  if (st.index > 0 && st.segElapsedS < PREVIEW_AFTER_S && st.segment.durationS >= PREVIEW_MIN_S) return { segment: st.segment, index: st.index, mode: 'jetzt' };
  return null;
}
