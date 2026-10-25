// Workouts: Einlesen von Zwift-Dateien (.zwo) und Umwandeln in eine flache Liste von Abschnitten.
// Ein Abschnitt: { durationS, startPct, endPct, free, label } mit Leistung als Anteil der FTP.
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
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
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
  const re = /<(Warmup|Cooldown|SteadyState|Ramp|IntervalsT|FreeRide|MaxEffort)\b([^>]*?)(\/>|>)/gi;
  for (const m of body[1].matchAll(re)) {
    const type = m[1].toLowerCase();
    const a = attrs(m[2]);
    const d = num(a.duration);
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
      for (let i = 0; i < reps; i++) {
        segments.push(ramp(num(a.onduration), onLow, onHigh, `Intervall ${i + 1} von ${reps}`));
        segments.push(ramp(num(a.offduration), offLow, offHigh, 'Erholung'));
      }
    } else {
      segments.push({ durationS: d, startPct: 0, endPct: 0, free: true, label: 'Freie Fahrt' });
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
