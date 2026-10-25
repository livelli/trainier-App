import { totalDuration } from './workout.js';

// Ein Eintrag in workouts/index.json ist entweder nur ein Dateiname ("x.zwo")
// oder ein Objekt mit geplantem Datum und Briefing:
// { "datei": "x.zwo", "datum": "2026-10-28", "briefing": { "ziel", "gefuehl", "fueling", "tipps": [] } }
export function normalizeEntry(entry) {
  if (typeof entry === 'string') return { datei: entry, datum: null, briefing: null };
  if (!entry || typeof entry.datei !== 'string') return null;
  return {
    datei: entry.datei,
    datum: parseIsoDate(entry.datum) ? entry.datum : null,
    briefing: cleanBriefing(entry.briefing),
  };
}

// Nur Textfelder übernehmen, damit eine fehlerhafte index.json nicht „[object Object]“ anzeigt.
function cleanBriefing(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const text = (v) => (typeof v === 'string' && v.trim() ? v : null);
  return {
    ziel: text(b.ziel),
    gefuehl: text(b.gefuehl),
    fueling: text(b.fueling),
    tipps: Array.isArray(b.tipps) ? b.tipps.filter(text) : [],
  };
}

// "2026-10-28" als lokales Datum (nicht UTC, sonst rutscht der Tag in der Schweiz nachts zurück).
export function parseIsoDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d : null;
}

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli',
  'August', 'September', 'Oktober', 'November', 'Dezember'];

// Liefert z. B. { text: "Dienstag, 28. Oktober", when: "morgen" } – when ist heute, morgen, vorbei oder null.
export function planDate(iso, today = new Date()) {
  const d = parseIsoDate(iso);
  if (!d) return null;
  const text = `${WEEKDAYS[d.getDay()]}, ${d.getDate()}. ${MONTHS[d.getMonth()]}`;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((d - start) / 86400000);
  const when = days === 0 ? 'heute' : days === 1 ? 'morgen' : days < 0 ? 'vorbei' : null;
  return { text, when };
}

// Geplante Workouts nach Datum, ungeplante behalten ihre Reihenfolge und kommen danach.
export function sortByPlan(items) {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const da = a.item.datum, db = b.item.datum;
      if (da && db) return da < db ? -1 : da > db ? 1 : a.i - b.i;
      if (da) return -1;
      if (db) return 1;
      return a.i - b.i;
    })
    .map(({ item }) => item);
}

// Briefing für Workouts ohne eigenes (z. B. eine selbst geöffnete .zwo-Datei),
// abgeleitet aus Dauer und höchster Intensität.
export function defaultBriefing(workout) {
  const minutes = Math.round(totalDuration(workout) / 60);
  const peak = Math.max(0, ...workout.segments.filter((s) => !s.free).map((s) => Math.max(s.startPct, s.endPct)));
  let gefuehl;
  if (peak <= 0.75) gefuehl = 'Locker. Du kannst die ganze Zeit in ganzen Sätzen reden.';
  else if (peak <= 0.9) gefuehl = 'Zügig, aber kontrolliert. Reden geht noch in kurzen Sätzen.';
  else if (peak <= 1.05) gefuehl = 'Die Blöcke sind hart, Reden nur noch in einzelnen Worten. Die Erholung dazwischen ist wirklich locker.';
  else gefuehl = 'Die Intervalle sind sehr hart, am Ende jedes Intervalls kannst du nicht mehr reden.';
  let fueling;
  if (minutes < 60) fueling = 'Vorher normal essen (2 bis 3 Stunden vorher eine Mahlzeit). Während der Fahrt reicht Wasser, etwa eine Flasche (500 bis 750 ml).';
  else if (minutes <= 90) fueling = 'Vorher eine Mahlzeit mit Kohlenhydraten. Während der Fahrt 30 bis 60 g Kohlenhydrate pro Stunde (z. B. Sportgetränk oder eine Banane) und 500 bis 750 ml pro Stunde trinken.';
  else fueling = 'Vorher eine Mahlzeit mit Kohlenhydraten. Während der Fahrt etwa 60 g Kohlenhydrate pro Stunde (mehr nur, wenn dein Magen das gewohnt ist), ab der ersten halben Stunde regelmäßig, und 500 bis 750 ml pro Stunde trinken.';
  return {
    ziel: workout.description || 'Keine Beschreibung vorhanden.',
    gefuehl,
    fueling,
    tipps: [
      'Ventilator an: drinnen fehlt der Fahrtwind, ohne Kühlung steigt der Puls unnötig.',
      'Wenn ein Block deutlich zu schwer ist: −10 % drücken statt abzubrechen.',
    ],
  };
}
