import { BleDevice, tryRead, readDeviceInfo } from './ble.js';
import { FtmsControl } from './ftms.js';
import { ErgController } from './erg.js';
import { parseZwo, totalDuration, formatTime, cadenceTarget, formatCadence, segmentFeel, segmentEffort, previewFor } from './workout.js';
import { Sound, soundCue, SOUND_LABELS } from './sound.js';
import { WorkoutPlayer } from './player.js';
import { powerZone } from './zones.js';
import { normalizeEntry, planDate, sortByPlan, defaultBriefing } from './plan.js';
import { Recording } from './recorder.js';
import { encodeFit, fitFileName } from './fit.js';
import { saveRide, getRide, deleteRide, listRides } from './storage.js';
import * as strava from './strava.js';
import * as folder from './folder.js';
import { World } from './world/world.js';
import { BUILTIN_ROUTES, builtinRoute, gpxSource, routeFromSource } from './world/route.js';
import { DEFAULT_RIDER_KG, DEFAULT_BIKE_KG } from './world/physics.js';
import {
  parseIndoorBikeData, parseMachineFeature, parsePowerRange,
  parseHeartRate, parseCscMeasurement, CadenceCalculator, toHex,
} from './parsers.js';

const $ = (sel) => document.querySelector(sel);
const STALE_MS = 5000;
const LOG_LIMIT = 20000;
const LOG_VIEW_LINES = 300;

// ---------- Diagnose-Protokoll ----------

const logLines = [];
// Alles außer den laufenden Messpaketen landet zusätzlich hier, damit Fähigkeiten,
// Geräteinfo und Fehler vom Anfang auch nach einer langen Fahrt in der Datei stehen.
const keyLines = [];
let logDirty = false;

function log(source, message) {
  const t = new Date().toISOString().slice(11, 23);
  const line = `${t} [${source}] ${message}`;
  logLines.push(line);
  if (logLines.length > LOG_LIMIT) logLines.splice(0, logLines.length - LOG_LIMIT);
  if (!message.startsWith('Daten ')) {
    keyLines.push(line);
    if (keyLines.length > 2000) keyLines.splice(0, keyLines.length - 2000);
  }
  logDirty = true;
}

setInterval(() => {
  if (!logDirty) return;
  const view = $('#log-view');
  const atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 20;
  view.textContent = logLines.slice(-LOG_VIEW_LINES).join('\n');
  if (atBottom) view.scrollTop = view.scrollHeight;
  logDirty = false;
}, 500);

$('#log-save').addEventListener('click', () => {
  const header = [
    'Trainer-App Verbindungstest',
    `Zeit: ${new Date().toString()}`,
    `Browser: ${navigator.userAgent}`,
    '',
    '=== Wichtige Ereignisse ===',
    ...keyLines,
    '',
    '=== Vollständiges Protokoll ===',
  ];
  const blob = new Blob([header.concat(logLines).join('\n')], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `verbindungstest-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#log-clear').addEventListener('click', () => {
  logLines.length = 0;
  keyLines.length = 0;
  logDirty = true;
});

// ---------- Anzeige ----------

const latest = {
  power: { value: null, at: 0 },
  hr: { value: null, at: 0 },
  cad: { value: null, at: 0 },
  speed: { value: null, at: 0 },
  trainerCad: { value: null, at: 0 },
};

function setMetric(key, value) {
  latest[key] = { value, at: Date.now() };
}

const cadenceCalc = new CadenceCalculator();

setInterval(() => {
  const now = Date.now();
  const show = (key, el, fmt = (v) => String(Math.round(v))) => {
    const m = latest[key];
    $(el).textContent = m.value === null || now - m.at > STALE_MS ? '–' : fmt(m.value);
  };
  // Kadenz fällt auf 0, wenn der Sensor keine neuen Umdrehungen meldet.
  // Manche Sensoren senden im Stillstand nichts mehr, daher bleibt die 0 sichtbar, solange er verbunden ist.
  if (latest.cad.value !== null && devices.cad.connected) {
    latest.cad = { value: cadenceCalc.current(now), at: now };
  }
  show('power', '#m-power');
  show('hr', '#m-hr');
  show('cad', '#m-cad');
  show('speed', '#m-speed', (v) => `${v.toFixed(1)} km/h`);
  if (ride) {
    show('power', '#r-power');
    show('hr', '#r-hr');
    show('cad', '#r-cad');
    // Kadenz-Kachel markieren, wenn die Trittfrequenz deutlich außerhalb des Ziels liegt.
    const c = latest.cad;
    const goal = ride.cadenceGoal;
    const off = goal && c.value !== null && now - c.at <= STALE_MS && c.value > 0
      && (c.value < goal.low - 5 || c.value > goal.high + 5);
    $('#t-cad').classList.toggle('off', Boolean(off));
  }
}, 250);

const STATUS_TEXT = {
  verbinde: 'verbinde …',
  verbunden: 'verbunden',
  wiederverbinden: 'Verbindung verloren, verbinde neu',
  verloren: 'Verbindung verloren. Bitte auf „verbinden“ klicken.',
  getrennt: 'nicht verbunden',
  fehler: 'Fehler',
};

function statusHandler(boxId, connectLabel) {
  const box = $(boxId);
  const statusEl = box.querySelector('.status');
  const connectBtn = box.querySelector('[data-connect]');
  const disconnectBtn = box.querySelector('[data-disconnect]');
  return (state, detail) => {
    statusEl.className = `status ${state}`;
    connectBtn.dataset.state = state;
    statusEl.textContent = STATUS_TEXT[state] + (detail ? ` (${detail})` : '');
    const isUp = state === 'verbunden';
    disconnectBtn.hidden = !(isUp || state === 'wiederverbinden');
    connectBtn.textContent = state === 'verloren' ? 'Neu verbinden' : connectLabel;
    connectBtn.disabled = isUp || state === 'verbinde' || state === 'wiederverbinden';
  };
}

function yesNo(label, ok) {
  return `<li>${label}: <span class="${ok ? 'yes' : 'no'}">${ok ? 'ja' : 'nein'}</span></li>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- ERG ----------

const control = new FtmsControl({ log });
let ergSupported = false;
const erg = new ErgController({ control, log, onChange: renderErg });

// ---------- FTP ----------

const FTP_KEY = 'trainerApp.ftp';
const DEFAULT_FTP = 194;

function loadFtp() {
  try {
    const v = Number(localStorage.getItem(FTP_KEY));
    if (v >= 50 && v <= 600) return v;
  } catch {
    // Kein Speicher verfügbar (z. B. privates Fenster): Standardwert nehmen.
  }
  return DEFAULT_FTP;
}

let ftp = loadFtp();
$('#ftp-input').value = ftp;
$('#ftp-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = Math.round(Number($('#ftp-input').value));
  if (!(v >= 50 && v <= 600)) {
    $('#ftp-status').textContent = 'Bitte eine Zahl zwischen 50 und 600 eingeben.';
    return;
  }
  ftp = v;
  try {
    localStorage.setItem(FTP_KEY, String(v));
    $('#ftp-status').textContent = `Gespeichert: ${v} W`;
  } catch {
    $('#ftp-status').textContent = `Übernommen: ${v} W (dieser Browser kann es sich nicht merken)`;
  }
  renderWorkoutList();
});

// ---------- Workout-Liste ----------

let workouts = [];

async function loadWorkouts() {
  try {
    const res = await fetch('workouts/index.json', { cache: 'no-cache' });
    const entries = (await res.json()).map(normalizeEntry).filter(Boolean);
    const loaded = await Promise.all(entries.map(async (entry) => {
      try {
        const xml = await (await fetch(`workouts/${entry.datei}`, { cache: 'no-cache' })).text();
        return { ...parseZwo(xml), datum: entry.datum, briefing: entry.briefing };
      } catch (err) {
        log('Workouts', `${entry.datei} konnte nicht gelesen werden: ${err.message}`);
        return null;
      }
    }));
    workouts = sortByPlan(loaded.filter(Boolean));
  } catch (err) {
    log('Workouts', `Liste konnte nicht geladen werden: ${err.message}`);
  }
  renderWorkoutList();
}

function zoneColor(pct) {
  return powerZone(pct * ftp, ftp).color;
}

function miniProfile(workout) {
  const box = document.createElement('div');
  box.className = 'mini-profile';
  box.setAttribute('aria-hidden', 'true');
  const maxPct = Math.max(1.2, ...workout.segments.map((s) => Math.max(s.startPct, s.endPct)));
  for (const s of workout.segments) {
    const bar = document.createElement('span');
    const pct = s.free ? 0.5 : (s.startPct + s.endPct) / 2;
    bar.style.flexGrow = String(s.durationS);
    bar.style.height = `${Math.max(4, (pct / maxPct) * 100)}%`;
    bar.style.background = s.free ? '#4b5563' : zoneColor(pct);
    box.append(bar);
  }
  return box;
}

function renderWorkoutList() {
  const list = $('#workout-list');
  list.textContent = '';
  if (!workouts.length) {
    const p = document.createElement('p');
    p.className = 'sub';
    p.textContent = 'Keine Workouts gefunden.';
    list.append(p);
    return;
  }
  for (const w of workouts) {
    const card = document.createElement('div');
    card.className = 'workout-card';
    const plan = planDate(w.datum);
    let date = null;
    if (plan) {
      card.classList.toggle('past', plan.when === 'vorbei');
      card.classList.toggle('today', plan.when === 'heute');
      date = document.createElement('div');
      date.className = 'plan-date';
      date.textContent = plan.text;
      if (plan.when) {
        const badge = document.createElement('span');
        badge.className = 'plan-when';
        badge.textContent = plan.when;
        date.append(' ', badge);
      }
    }
    const h = document.createElement('h3');
    h.textContent = w.name;
    card.append(h);
    if (date) card.append(date);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const peaks = w.segments.filter((s) => !s.free).map((s) => Math.max(s.startPct, s.endPct));
    meta.textContent = peaks.length
      ? `${formatTime(totalDuration(w))} · bis ${Math.round(Math.max(...peaks) * ftp)} W`
      : `${formatTime(totalDuration(w))} · freie Fahrt`;
    const desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = w.description;
    const btn = document.createElement('button');
    btn.textContent = 'Dieses Workout fahren';
    btn.addEventListener('click', () => openRide(w));
    const info = document.createElement('button');
    info.className = 'secondary';
    info.textContent = 'Infos vor dem Start';
    info.addEventListener('click', () => openBriefing(w));
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.append(btn, info);
    card.append(meta, miniProfile(w), desc, actions);
    list.append(card);
  }
}

function openBriefing(w) {
  const b = w.briefing ?? defaultBriefing(w);
  const plan = planDate(w.datum);
  $('#b-title').textContent = w.name;
  $('#b-date').textContent = plan ? `Geplant: ${plan.text}` : '';
  $('#b-date').hidden = !plan;
  const body = $('#b-body');
  body.textContent = '';
  const sections = [
    ['Worum es geht', b.ziel],
    ['Wie es sich anfühlen soll', b.gefuehl],
    ['Essen und Trinken', b.fueling],
  ];
  for (const [title, text] of sections) {
    if (!text) continue;
    const h = document.createElement('h3');
    h.textContent = title;
    const p = document.createElement('p');
    p.textContent = text;
    body.append(h, p);
  }
  if (Array.isArray(b.tipps) && b.tipps.length) {
    const h = document.createElement('h3');
    h.textContent = 'Wichtig zu wissen';
    const ul = document.createElement('ul');
    for (const t of b.tipps) {
      const li = document.createElement('li');
      li.textContent = t;
      ul.append(li);
    }
    body.append(h, ul);
  }
  $('#b-ride').onclick = () => { $('#briefing').close(); openRide(w); };
  $('#briefing').showModal();
}
$('#b-close').addEventListener('click', () => $('#briefing').close());

$('#zwo-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const w = parseZwo(await file.text());
    workouts.unshift(w);
    renderWorkoutList();
    log('Workouts', `Datei geladen: ${file.name}`);
  } catch (err) {
    alert(`Die Datei konnte nicht gelesen werden: ${err.message}`);
  }
});

$('#free-ride').addEventListener('click', () => openRide(null));

// ---------- Fahranzeige ----------

let ride = null; // { workout, player, freeStartedAt, freeElapsedMs, endArmedUntil }
let profileBars = [];

// ---------- Fahrwelt ----------

const WORLD_KEY = 'trainerApp.world';
const WORLD_GPX_KEY = 'trainerApp.worldGpx';

function loadWorldSettings() {
  const d = { on: true, routeId: 'alpenpass', quality: 'hoch', riderKg: DEFAULT_RIDER_KG, bikeKg: DEFAULT_BIKE_KG };
  try {
    const s = JSON.parse(localStorage.getItem(WORLD_KEY) || '{}');
    // Vor der 3D-Welt hieß die schonende einfache Welt „niedrig“.
    if (!s.v && s.quality === 'niedrig') s.quality = 'einfach-niedrig';
    return { ...d, ...s, v: 2 };
  } catch {
    return d;
  }
}

function saveWorldSettings() {
  try {
    localStorage.setItem(WORLD_KEY, JSON.stringify(worldSettings));
  } catch {
    // Ohne Speicher gilt die Einstellung nur bis zum Neuladen.
  }
}

function loadGpx() {
  try {
    const s = localStorage.getItem(WORLD_GPX_KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

let worldSettings = loadWorldSettings();
let gpxSrc = loadGpx();
const world = new World({
  canvas: $('#w-canvas'),
  canvas3d: $('#w-canvas3d'),
  onFallback: () => {
    log('Fahrwelt', '3D nicht möglich, einfache Welt wird gezeigt');
    setWorldStatus('Dein Browser konnte die 3D-Welt nicht anzeigen, darum läuft die einfache Welt. Ist in Chrome unter Einstellungen → System die Grafikbeschleunigung an?');
  },
  mapCanvas: $('#w-map'),
  elevCanvas: $('#w-elevc'),
  els: { speed: $('#w-speed'), grade: $('#w-grade'), elev: $('#w-elev'), dist: $('#w-dist'), route: $('#w-route') },
});

function currentRoute() {
  if (worldSettings.routeId === 'gpx' && gpxSrc) {
    try {
      return routeFromSource(gpxSrc);
    } catch (err) {
      log('Fahrwelt', `Eigene Strecke unbrauchbar: ${err.message}`);
      setWorldStatus('Die gespeicherte eigene Strecke ist beschädigt, darum gilt der Alpenpass. Bitte die GPX-Datei neu öffnen.');
    }
  }
  return builtinRoute(worldSettings.routeId === 'gpx' ? 'alpenpass' : worldSettings.routeId);
}

function worldMassKg() {
  const r = Number(worldSettings.riderKg);
  const b = Number(worldSettings.bikeKg);
  return (r >= 30 && r <= 200 ? r : DEFAULT_RIDER_KG) + (b >= 3 && b <= 30 ? b : DEFAULT_BIKE_KG);
}

function setWorldStatus(text) {
  const el = $('#world-status');
  el.hidden = !text;
  el.textContent = text || '';
}

function renderWorldPanel() {
  const sel = $('#world-route');
  const opts = BUILTIN_ROUTES.map((r) => `<option value="${r.id}">${escapeHtml(r.name)} (${r.length / 1000} km)</option>`);
  if (gpxSrc) opts.push(`<option value="gpx">Eigene Strecke: ${escapeHtml(gpxSrc.name)}</option>`);
  sel.innerHTML = opts.join('');
  if (worldSettings.routeId === 'gpx' && !gpxSrc) worldSettings.routeId = 'alpenpass';
  sel.value = worldSettings.routeId;
  $('#world-on').checked = worldSettings.on;
  $('#world-quality').value = worldSettings.quality;
  $('#world-rider').value = worldSettings.riderKg;
  $('#world-bike').value = worldSettings.bikeKg;
  const route = currentRoute();
  const def = BUILTIN_ROUTES.find((r) => r.id === route.id);
  const km = (route.length / 1000).toFixed(1).replace('.', ',');
  const kind = route.id === 'gpx' ? (route.loop ? 'Runde' : 'hin und zurück') : 'Runde';
  $('#world-route-info').textContent = `${def ? `${def.info} ` : ''}${km} km ${kind}, ${route.climb} Höhenmeter.`;
}

$('#world-on').addEventListener('change', (e) => {
  worldSettings.on = e.target.checked;
  saveWorldSettings();
});
$('#world-route').addEventListener('change', (e) => {
  worldSettings.routeId = e.target.value;
  saveWorldSettings();
  renderWorldPanel();
});
$('#world-quality').addEventListener('change', (e) => {
  worldSettings.quality = e.target.value;
  saveWorldSettings();
});
for (const [id, key] of [['#world-rider', 'riderKg'], ['#world-bike', 'bikeKg']]) {
  $(id).addEventListener('change', (e) => {
    const v = Number(String(e.target.value).replace(',', '.'));
    const [lo, hi] = key === 'riderKg' ? [30, 200] : [3, 30];
    if (Number.isFinite(v) && v >= lo && v <= hi) {
      worldSettings[key] = Math.round(v * 2) / 2;
      saveWorldSettings();
      setWorldStatus('');
    } else {
      setWorldStatus(`${key === 'riderKg' ? 'Dein Gewicht' : 'Das Radgewicht'} bitte zwischen ${lo} und ${hi} kg eingeben.`);
    }
    renderWorldPanel();
  });
}
$('#world-gpx').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const src = gpxSource(await file.text(), file.name.replace(/\.gpx$/i, ''));
    gpxSrc = src;
    worldSettings.routeId = 'gpx';
    let note = '';
    try {
      localStorage.setItem(WORLD_GPX_KEY, JSON.stringify(src));
    } catch {
      note = ' Der Browser kann sie sich nicht merken, nach dem Neuladen bitte erneut öffnen.';
    }
    saveWorldSettings();
    renderWorldPanel();
    setWorldStatus(`Strecke „${src.name}“ geladen.${src.hasEle ? '' : ' Die Datei hat keine Höhenangaben, die Strecke ist daher flach.'}${note}`);
    log('Fahrwelt', `Eigene Strecke geladen: ${src.x.length} Punkte`);
  } catch (err) {
    setWorldStatus(`Diese Datei passt nicht: ${err.message}`);
  }
});

function renderWorldButton() {
  const b = $('#r-world');
  b.textContent = world.visible ? 'Welt aus' : 'Welt an';
  b.setAttribute('aria-pressed', String(world.visible));
}

function showWorld(on) {
  if (on) world.show();
  else world.hide();
  $('#world').hidden = !world.visible;
  $('#w-elev-box').hidden = !world.visible;
  $('#ride-screen').classList.toggle('world-on', world.visible);
  renderWorldButton();
}

// Die Strecke läuft in jeder Fahrt mit (die Rechnung ist winzig), gezeigt wird sie nur mit „Welt an“.
// So setzt An- und Ausschalten die Position nicht zurück.
function startWorld() {
  try {
    world.start(currentRoute(), { massKg: worldMassKg(), quality: worldSettings.quality });
    // Die Aufzeichnung nimmt die virtuelle Geschwindigkeit nur, wenn die Welt beim Start an war.
    ride.virtualSpeed = worldSettings.on;
    showWorld(worldSettings.on);
  } catch (err) {
    // Ohne Welt weiterfahren, nie die Fahrt blockieren.
    log('Fahrwelt', `Start fehlgeschlagen: ${err.message}`);
    stopWorld();
  }
}

function stopWorld() {
  world.stop();
  showWorld(false);
}

function toggleWorld() {
  if (!ride || !world.active) return;
  worldSettings.on = !world.visible;
  saveWorldSettings();
  $('#world-on').checked = worldSettings.on;
  showWorld(worldSettings.on);
}
$('#r-world').addEventListener('click', toggleWorld);

renderWorldPanel();

// ---------- Tonsignale ----------

const SOUND_KEY = 'trainerApp.sound';
let savedSound = null;
try { savedSound = localStorage.getItem(SOUND_KEY); } catch { /* ohne Speicher gilt die Voreinstellung */ }
const sound = new Sound(savedSound ?? 'ansage');

function renderSoundButton() {
  $('#r-sound').textContent = SOUND_LABELS[sound.mode];
}

$('#r-sound').addEventListener('click', () => {
  const mode = sound.nextMode();
  try { localStorage.setItem(SOUND_KEY, mode); } catch { /* egal */ }
  sound.unlock();
  if (mode === 'piepsen') sound.countdown();
  if (mode === 'ansage') sound.say('Ansage an');
  renderSoundButton();
});
renderSoundButton();

// Ansage beim Wechsel, z. B. „Intervall 2 von 5. 213 Watt. Kadenz 90 bis 100.“
function announce(st) {
  const s = st.segment;
  if (!s) return;
  const parts = [s.label];
  if (s.free) parts.push('ohne Wattziel');
  else if (s.startPct !== s.endPct) parts.push(`von ${erg.clamp(ride.player.targetW(s, 0))} auf ${erg.clamp(ride.player.targetW(s, s.durationS))} Watt`);
  else parts.push(`${erg.clamp(st.targetW)} Watt`);
  const c = cadenceTarget(s);
  if (c) parts.push(c.low === c.high ? `Kadenz ${c.low}` : `Kadenz ${c.low} bis ${c.high}`);
  parts.push(spokenDuration(s.durationS));
  sound.say(parts.join('. '));
}

function spokenDuration(totalS) {
  const s = Math.round(totalS);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  const min = m === 1 ? '1 Minute' : `${m} Minuten`;
  if (!m) return `${sec} Sekunden`;
  return sec ? `${min} ${sec}` : min;
}

function playCues() {
  if (!ride || !ride.player) return;
  const st = ride.player.status(Date.now());
  const { cue, state } = soundCue(ride.cue, st);
  ride.cue = state;
  if (cue === 'countdown') sound.countdown();
  else if (cue === 'wechsel') { sound.change(); announce(st); }
  else if (cue === 'fertig') { sound.finish(); sound.say('Workout geschafft. Gut gemacht!'); }
}

function openRide(workout) {
  ride = {
    workout,
    player: workout ? new WorkoutPlayer(workout, { ftp }) : null,
    freeStartedAt: null,
    freeElapsedMs: 0,
    endArmedUntil: 0,
    cue: null,
    cadenceGoal: null,
    rec: new Recording({ name: workout ? workout.name : 'Freie Fahrt', ftp, startedAt: Date.now() }),
    savedSamples: 0,
    nextSaveTry: 0,
    saveWarn: false,
    saveNote: '',
  };
  if (!workout) erg.setTarget(Math.round(ftp * 0.55));
  // Ordner-Freigabe jetzt im Klick holen, beim automatischen Speichern am Ende geht das nicht mehr.
  folder.permission(true).then(() => renderFolder()).catch(() => {});
  $('#setup-screen').hidden = true;
  $('#ride-screen').hidden = false;
  $('#r-name').textContent = workout ? workout.name : 'Freie Fahrt';
  $('#r-profile-box').hidden = !workout;
  $('#r-skip').hidden = !workout;
  $('#r-sound').hidden = !workout;
  buildProfile();
  startWorld();
  renderRide();
  window.scrollTo(0, 0);
}

async function closeRide() {
  // Erst die Fahrt abmelden, dann ERG ausschalten: sonst schaltet der Takt ERG
  // wieder ein, während der Trainer den Stopp noch bestätigt.
  const r = ride;
  ride = null;
  stopWorld();
  sound.silence();
  if (r && r.player && r.player.state !== 'fertig') r.player.stop(Date.now());
  // Zuerst speichern: Das Ausschalten von ERG kann ein paar Sekunden auf den Trainer warten.
  if (r) await saveFinal(r);
  if (r && r.saveFailed) alert(r.saveNote);
  if (erg.on) await erg.disable();
  $('#ride-screen').hidden = true;
  $('#setup-screen').hidden = false;
  $('#ride-screen').classList.remove('done');
  $('#r-preview').hidden = true;
  previewKey = null;
  updateWakeLock();
}

function buildProfile() {
  const box = $('#r-profile');
  box.querySelectorAll('.bar').forEach((b) => b.remove());
  profileBars = [];
  if (!ride || !ride.workout) return;
  const segs = ride.workout.segments;
  const maxPct = Math.max(1.2, ...segs.map((s) => Math.max(s.startPct, s.endPct)));
  let t = 0;
  for (const s of segs) {
    // Rampen in Scheiben zu je höchstens 30 s zeichnen, damit sie als Schräge erkennbar sind.
    const slices = s.startPct === s.endPct ? 1 : Math.max(2, Math.ceil(s.durationS / 30));
    for (let i = 0; i < slices; i++) {
      const d = s.durationS / slices;
      const pct = s.free ? 0.5 : s.startPct + (s.endPct - s.startPct) * ((i + 0.5) / slices);
      const bar = document.createElement('div');
      bar.className = 'bar todo';
      bar.style.flexGrow = String(d);
      bar.style.height = `${Math.max(3, (pct / maxPct) * 100)}%`;
      bar.style.background = s.free ? '#4b5563' : zoneColor(pct);
      box.append(bar);
      t += d;
      profileBars.push({ el: bar, endS: t });
    }
  }
}

function freeElapsedS(now) {
  const running = ride.freeStartedAt !== null ? now - ride.freeStartedAt : 0;
  return (ride.freeElapsedMs + running) / 1000;
}

function currentTargetW(now = Date.now()) {
  if (!ride) return erg.on && !erg.paused ? erg.target : null;
  if (ride.player) {
    const st = ride.player.status(now);
    return st.state === 'läuft' ? st.targetW : null;
  }
  return erg.on && !erg.paused ? erg.target : null;
}

function rideRunning() {
  if (!ride) return false;
  if (ride.player) return ride.player.state === 'läuft';
  return ride.freeStartedAt !== null;
}

// Wird alle 250 ms aufgerufen: Workout weiterschalten und dem Trainer das Ziel geben.
function tickRide() {
  if (!ride) return;
  if (!ride.player) {
    // Freie Fahrt: ERG nachträglich einschalten, wenn der Trainer erst nach dem Start (wieder) bereit ist.
    if (ride.freeStartedAt !== null && !erg.on && control.ready && ergSupported) erg.enable();
    return;
  }
  const now = Date.now();
  const st = ride.player.status(now);
  if (st.state === 'fertig') {
    if (!ride.finished) finishRide();
    return;
  }
  if (st.state !== 'läuft') return;
  if (st.targetW === null) {
    if (erg.on) erg.disable();
    return;
  }
  if (control.ready && ergSupported) {
    if (erg.target !== erg.clamp(st.targetW)) erg.setTarget(st.targetW);
    if (!erg.on) erg.enable();
  }
}

function finishRide() {
  ride.finished = true;
  ride.player.stop(Date.now());
  if (erg.on) erg.disable();
  log('Workout', `Beendet: ${ride.workout.name}`);
  saveFinal(ride);
  renderRide();
  updateWakeLock();
}

setInterval(() => {
  tickRide();
  recordTick();
  playCues();
  if (ride) renderRide();
}, 250);

function setAlert(text, kind = '') {
  const el = $('#r-alert');
  el.hidden = !text;
  el.textContent = text || '';
  el.className = `ride-alert ${kind}`;
}

function renderRide() {
  if (!ride) return;
  const now = Date.now();
  const screen = $('#ride-screen');

  for (const [key, id] of [['trainer', '#dd-trainer'], ['hr', '#dd-hr'], ['cad', '#dd-cad']]) {
    const dev = devices[key];
    $(id).classList.toggle('on', dev.connected);
    $(id).classList.toggle('warn', !dev.connected && dev.retrying);
  }

  let target = null;
  let segLabel;
  let countdown;
  let segProgress = 0;
  let nextText;
  let state;
  let cadGoal = null;

  if (ride.player) {
    const st = ride.player.status(now);
    state = st.state;
    target = st.targetW === null ? null : erg.clamp(st.targetW);
    $('#r-time').textContent = `${formatTime(st.elapsedS)} von ${formatTime(st.totalS)} · FTP ${ftp} W`;
    const s = st.segment;
    if (s.free) segLabel = `${s.label} · ohne Ziel`;
    else if (s.startPct !== s.endPct) {
      segLabel = `${s.label} · ${erg.clamp(ride.player.targetW(s, 0))} → ${erg.clamp(ride.player.targetW(s, s.durationS))} W`;
    } else segLabel = `${s.label} · ${target} W`;
    countdown = formatTime(st.segRemainingS);
    cadGoal = cadenceTarget(s);
    const nextCad = cadenceTarget(st.next);
    segProgress = s.durationS ? st.segElapsedS / s.durationS : 0;
    nextText = st.next
      ? `Danach: ${st.next.label}${st.next.free ? '' : ` · ${erg.clamp(st.nextTargetW)} W`}${nextCad ? ` · ${formatCadence(nextCad)}` : ''} · ${formatTime(st.next.durationS)}`
      : 'Danach: geschafft!';
    $('#r-marker').style.left = `calc(${(st.progress * 100).toFixed(2)}% - 1px)`;
    for (const b of profileBars) {
      const done = b.endS <= st.elapsedS;
      b.el.classList.toggle('done', done);
      b.el.classList.toggle('todo', !done);
    }
    const p = ride.player;
    const parts = [];
    if (Math.abs(p.factor - 1) > 0.001) parts.push(`${Math.round((p.factor - 1) * 100)} %`);
    if (p.offsetW) parts.push(`${p.offsetW > 0 ? '+' : ''}${p.offsetW} W`);
    $('#r-adjust').textContent = parts.length ? `Anpassung: ${parts.join(' · ')}` : '';
  } else {
    state = ride.freeStartedAt !== null ? (erg.paused ? 'pause' : 'läuft') : (ride.freeElapsedMs ? 'pause' : 'bereit');
    target = erg.target;
    const el = freeElapsedS(now);
    $('#r-time').textContent = `${formatTime(el)} gefahren · FTP ${ftp} W`;
    segLabel = `Freie Fahrt · Ziel ${erg.target} W`;
    const pct = erg.target / ftp;
    cadGoal = cadenceTarget({ startPct: pct, endPct: pct, free: false });
    countdown = formatTime(el);
    nextText = 'Ziel mit den Knöpfen oder den Pfeiltasten ändern.';
    $('#r-adjust').textContent = '';
  }

  if (target !== null) {
    const z = powerZone(target, ftp);
    screen.style.setProperty('--zone', z.color);
    $('#r-target').innerHTML = `Ziel ${target} W · <span class="zone-name">Z${z.zone} ${z.name}</span>`;
  } else {
    screen.style.setProperty('--zone', '#3a434f');
    $('#r-target').textContent = ride.player && state !== 'bereit' && state !== 'fertig' ? 'Kein Ziel (freie Fahrt)' : 'Ziel –';
  }
  // Gelb nur während der Fahrt, nicht vor dem Start oder nach dem Ende.
  ride.cadenceGoal = state === 'läuft' ? cadGoal : null;
  $('#r-cad-target').textContent = cadGoal ? `Ziel ${formatCadence(cadGoal)}` : 'U/min · kein Ziel';
  $('#r-seg-label').textContent = segLabel;
  $('#r-countdown').textContent = countdown;
  $('#r-seg-progress').style.width = `${Math.min(100, segProgress * 100).toFixed(1)}%`;
  $('#r-next').textContent = nextText;

  const startBtn = $('#r-start');
  startBtn.disabled = state === 'fertig';
  startBtn.textContent = { bereit: 'Start', läuft: 'Pause', pause: 'Weiter', fertig: 'Geschafft' }[state];
  const endBtn = $('#r-end');
  if (state === 'fertig' || state === 'bereit') endBtn.textContent = 'Zurück';
  else endBtn.textContent = now < ride.endArmedUntil ? 'Wirklich beenden?' : (ride.player ? 'Workout beenden' : 'Fahrt beenden');

  renderPreview(ride.player ? ride.player.status(now) : null);

  if (state === 'fertig') setAlert(`Workout geschafft! ${formatTime(ride.player.totalS)} gefahren. ${ride.saveNote}`, 'info');
  else if (erg.error) setAlert(`Problem: ${erg.error}`);
  else if (ride.saveWarn && state === 'läuft') setAlert('Zwischenspeichern klappt gerade nicht. Die Fahrt wird eventuell nicht gespeichert.');
  else if (state === 'läuft' && target !== null && !control.ready) setAlert('Trainer nicht verbunden: Das Watt-Ziel wird gerade nicht an den Trainer geschickt.');
  else if (state === 'läuft' && target !== null && control.ready && !ergSupported) setAlert('Dieser Trainer meldet keinen ERG-Modus.');
  else setAlert('');
}

// ---------- Aufzeichnung ----------

const MIN_SAVE_S = 60; // Kürzere Fahrten (z. B. Tests) nicht speichern.
const AUTOSAVE_S = 30;

function currentValues(now) {
  const v = (key) => {
    const m = latest[key];
    return m.value === null || now - m.at > STALE_MS ? null : Math.round(m.value * 10) / 10;
  };
  // Kadenz nur vom Sensor: Die Zahl des D100 ist geschätzt und stimmt nicht.
  const p = v('power');
  const hr = v('hr');
  const cad = v('cad');
  return {
    p: p === null ? null : Math.round(p),
    hr: hr === null ? null : Math.round(hr),
    cad: cad === null ? null : Math.round(cad),
    // Mit Fahrwelt die virtuelle Geschwindigkeit: Sie kennt Gewicht und Steigung, die des Trainers nicht.
    // Festgelegt beim Start, damit die Distanz nicht aus zwei Quellen gemischt wird.
    spd: ride && ride.virtualSpeed && world.active ? Math.round(world.speedKmh * 10) / 10 : v('speed'),
    tgt: currentTargetW(now),
  };
}

function recordTick() {
  if (ride && world.active) {
    // Ein Fehler in der Welt darf Aufzeichnung, Töne und Anzeige nie aufhalten.
    try {
      const m = latest.power;
      const p = m.value !== null && Date.now() - m.at <= STALE_MS ? m.value : 0;
      world.tick(Date.now(), p, rideRunning() && !ride.finished);
    } catch (err) {
      if (!ride.worldError) log('Fahrwelt', `Fehler: ${err.message}`);
      ride.worldError = true;
    }
  }
  if (!ride || !ride.rec || ride.finished) return;
  const now = Date.now();
  ride.rec.tick(now, currentValues(now), rideRunning());
  // Zwischendurch speichern, damit bei einem Absturz oder leerem Akku nicht alles weg ist.
  const r = ride;
  const n = r.rec.samples.length;
  if (n >= MIN_SAVE_S && n - r.savedSamples >= AUTOSAVE_S && !r.saving && now >= r.nextSaveTry) {
    r.saving = true;
    saveRide(r.rec.toRecord(false))
      .then(() => {
        r.savedSamples = n;
        r.saveWarn = false;
      })
      .catch((err) => {
        // Nicht dauernd neu versuchen: kostet Rechenzeit und füllt das Protokoll.
        r.nextSaveTry = Date.now() + 30000;
        if (!r.saveWarn) log('Speichern', `Zwischenspeichern fehlgeschlagen: ${err.message}`);
        r.saveWarn = true;
      })
      .finally(() => { r.saving = false; });
  }
}

async function saveFinal(r) {
  if (!r.rec || r.finalSaved) return;
  r.finalSaved = true;
  const n = r.rec.samples.length;
  finishingId = r.rec.id;
  try {
    if (n < MIN_SAVE_S) {
      // Falls doch schon zwischengespeichert wurde, den Rest nicht liegen lassen.
      if (r.savedSamples) await deleteRide(r.rec.id);
      r.saveNote = 'Kürzer als eine Minute, darum nicht gespeichert.';
    } else {
      await saveRide(r.rec.toRecord(true));
      finishingId = null;
      r.saveNote = 'Gespeichert unter „Deine Fahrten“.';
      log('Speichern', `Fahrt gespeichert: ${r.rec.name}, ${n} s`);
      const st = strava.loadSettings();
      if (strava.isConnected(st) && st.auto !== false) {
        r.saveNote = 'Gespeichert und wird zu Strava hochgeladen.';
        uploadToStrava(r.rec.id); // nicht abwarten, das Beenden soll nicht hängen
      }
      syncFolder(); // ebenso nicht abwarten
    }
  } catch (err) {
    r.saveNote = `Speichern hat nicht geklappt: ${err.message}`;
    r.saveFailed = true;
    log('Speichern', `Fehler: ${err.message}`);
  }
  finishingId = null;
  renderHistory();
}

// ---------- Deine Fahrten ----------

const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

function rideDate(ms) {
  const d = new Date(ms);
  const pad = (v) => String(v).padStart(2, '0');
  return `${WD[d.getDay()]}, ${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()} · ${pad(d.getHours())}:${pad(d.getMinutes())} Uhr`;
}

async function renderHistory() {
  const list = $('#history-list');
  let rides;
  try {
    rides = await listRides();
  } catch (err) {
    list.textContent = '';
    const p = document.createElement('p');
    p.className = 'sub';
    p.textContent = `Gespeicherte Fahrten können in diesem Browser nicht gelesen werden (${err.message}).`;
    list.append(p);
    return;
  }
  list.textContent = '';
  if (!rides.length) {
    const p = document.createElement('p');
    p.className = 'sub';
    p.textContent = 'Noch keine Fahrten gespeichert. Jede Fahrt ab einer Minute landet automatisch hier.';
    list.append(p);
    return;
  }
  for (const r of rides) {
    const s = r.summary;
    const row = document.createElement('div');
    row.className = 'history-row';
    const info = document.createElement('div');
    info.className = 'history-info';
    const title = document.createElement('strong');
    title.textContent = r.name;
    const when = document.createElement('span');
    when.className = 'sub';
    when.textContent = rideDate(r.startedAt) + (r.complete ? '' : ' · unterbrochen, bis zum letzten Zwischenstand gespeichert');
    const stats = document.createElement('span');
    stats.className = 'history-stats';
    const parts = s ? [formatTime(s.timerS)] : [];
    if (s && s.avgPower !== null) parts.push(`Ø ${s.avgPower} W`);
    if (s && s.np !== null) parts.push(`NP ${s.np} W`);
    if (s && s.avgHr !== null) parts.push(`Ø ${s.avgHr} bpm`);
    if (s && s.avgCad !== null) parts.push(`Ø ${s.avgCad} U/min`);
    if (s && s.tss !== null) parts.push(`TSS ${s.tss}`);
    stats.textContent = parts.join(' · ');
    info.append(title, when, stats);
    const sv = r.strava;
    if (sv) {
      const line = document.createElement('span');
      line.className = `history-strava ${sv.status}`;
      if (sv.status === 'hochgeladen') {
        const a = document.createElement('a');
        a.href = strava.activityUrl(sv.activityId);
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Auf Strava ansehen';
        line.append('Strava: hochgeladen · ', a);
      } else if (sv.status === 'läuft') {
        // Ohne laufenden Upload war die Seite zu, bevor Strava fertig war.
        line.textContent = stravaBusy.has(r.id) ? 'Strava: wird hochgeladen …' : 'Strava: Upload wurde unterbrochen.';
      }
      else line.textContent = `Strava: nicht hochgeladen. ${sv.error || ''}`;
      info.append(line);
    }
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    // Die laufende Fahrt erst nach dem Beenden hochladen, sonst landet nur ein Teil auf Strava.
    const live = ride && ride.rec && ride.rec.id === r.id;
    if (strava.isConnected() && !live && r.complete !== false && !stravaBusy.has(r.id) && (!sv || sv.status !== 'hochgeladen')) {
      const up = document.createElement('button');
      up.textContent = sv ? 'Nochmals zu Strava' : 'Zu Strava hochladen';
      up.addEventListener('click', () => uploadToStrava(r.id));
      actions.append(up);
    }
    const fit = document.createElement('button');
    fit.className = 'secondary';
    fit.textContent = 'FIT-Datei herunterladen';
    fit.addEventListener('click', () => downloadFit(r.id));
    const del = document.createElement('button');
    del.className = 'secondary';
    del.textContent = 'Löschen';
    del.addEventListener('click', async () => {
      if (!confirm(`„${r.name}“ vom ${rideDate(r.startedAt)} wirklich löschen?`)) return;
      try {
        await deleteRide(r.id);
      } catch (err) {
        alert(`Löschen hat nicht geklappt: ${err.message}`);
      }
      renderHistory();
      renderFolder();
    });
    actions.append(fit, del);
    row.append(info, actions);
    list.append(row);
  }
}

async function downloadFit(id) {
  try {
    const record = await getRide(id);
    if (!record) throw new Error('Fahrt nicht gefunden.');
    const blob = new Blob([encodeFit(record)], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fitFileName(record);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) {
    alert(`Die FIT-Datei konnte nicht erstellt werden: ${err.message}`);
  }
}

renderHistory();

// ---------- Ordner für Claude ----------

let folderChain = Promise.resolve();

// Die laufende Fahrt erst in den Ordner, wenn sie fertig gespeichert ist.
// finishingId: Fahrt, deren letztes Speichern gerade läuft (sonst landet der Zwischenstand im Ordner).
let finishingId = null;
const isLiveRide = (id) => id === finishingId || Boolean(ride && ride.rec && ride.rec.id === id && !ride.finalSaved);

// Alle fertigen Fahrten, die noch nicht im Ordner liegen, hineinschreiben. Nie zwei Läufe gleichzeitig.
function syncFolder(ask = false) {
  const runSync = async () => {
    if (!folder.folderName()) return null;
    const rides = await listRides();
    const ids = rides.filter((r) => !isLiveRide(r.id)).map((r) => r.id);
    const res = await folder.sync({
      ids,
      getFull: getRide,
      encode: encodeFit,
      fileBase: (rec) => fitFileName(rec).replace(/\.fit$/, ''),
      ask,
    });
    if (res.written) log('Ordner', `${res.written} Fahrt(en) in „${folder.folderName()}“ gespeichert`);
    if (res.failed) log('Ordner', `${res.failed} Fahrt(en) nicht gespeichert: ${res.lastError && res.lastError.message}`);
    return res;
  };
  const p = folderChain.then(runSync, runSync);
  folderChain = p.catch(() => {});
  return p
    .then((res) => {
      const parts = [];
      if (res && res.written) parts.push(`${res.written === 1 ? 'Eine Fahrt' : `${res.written} Fahrten`} im Ordner gespeichert.`);
      if (res && res.failed) parts.push(`${res.failed === 1 ? 'Eine Fahrt konnte' : `${res.failed} Fahrten konnten`} nicht in den Ordner geschrieben werden. Ist der Ordner noch da und nicht schreibgeschützt?`);
      return renderFolder(parts.join(' '));
    })
    .catch((err) => {
      log('Ordner', `Speichern fehlgeschlagen: ${err.message}`);
      return renderFolder('Speichern im Ordner hat nicht geklappt. Ist der Ordner noch da? Sonst bitte „Anderen Ordner wählen“.');
    });
}

async function renderFolder(message = '') {
  $('#folder-msg').textContent = message;
  $('#folder-msg').hidden = !message;
  if (!folder.supported()) {
    $('#folder-unsupported').hidden = false;
    $('#folder-none').hidden = true;
    $('#folder-set').hidden = true;
    return;
  }
  const name = folder.folderName();
  $('#folder-none').hidden = Boolean(name);
  $('#folder-set').hidden = !name;
  if (!name) return;
  let perm = 'prompt';
  let missing = 0;
  try {
    perm = await folder.permission(false);
    const rides = await listRides();
    missing = await folder.missingCount(rides.filter((r) => !isLiveRide(r.id)).map((r) => r.id));
  } catch {
    // Anzeige trotzdem aufbauen
  }
  let text = `Speichert in „${name}“.`;
  if (perm === 'denied') text += ' Chrome hat den Zugriff gesperrt. Bitte den Ordner neu wählen.';
  else if (missing) text += ` ${missing === 1 ? 'Eine Fahrt fehlt' : `${missing} Fahrten fehlen`} dort noch.`;
  else if (perm !== 'granted') text += ' Chrome fragt beim nächsten Start einer Fahrt nach der Erlaubnis.';
  else text += ' Alles da.';
  $('#folder-status').textContent = text;
  $('#folder-sync').hidden = !missing || perm === 'denied';
}

async function chooseFolder() {
  try {
    await folder.choose();
  } catch (err) {
    if (err && err.name === 'AbortError') return; // Auswahl abgebrochen
    log('Ordner', `Auswahl fehlgeschlagen: ${err && err.message}`);
    await renderFolder('Diesen Ordner lässt Chrome nicht zu (z. B. Systemordner). Bitte einen eigenen Ordner, etwa in „Dokumente“, wählen.');
    return;
  }
  log('Ordner', `Gewählt: ${folder.folderName()}`);
  syncFolder(true);
}

$('#folder-choose').addEventListener('click', chooseFolder);
$('#folder-change').addEventListener('click', chooseFolder);
$('#folder-sync').addEventListener('click', async () => {
  // Erlaubnis sofort im Klick holen, bevor irgendetwas anderes wartet.
  await folder.permission(true).catch(() => {});
  syncFolder(true);
});
$('#folder-forget').addEventListener('click', async () => {
  if (!confirm('Fahrten nicht mehr in den Ordner speichern? Die Dateien, die schon dort liegen, bleiben.')) return;
  await folder.forget().catch(() => {});
  await renderFolder('Es wird nicht mehr in einen Ordner gespeichert.');
});

folder.load()
  .catch(() => null)
  .then(() => renderFolder())
  .then(() => syncFolder());

// ---------- Strava ----------

const stravaBusy = new Set();

async function setStravaStatus(id, status) {
  const record = await getRide(id);
  if (!record) return null;
  record.strava = { ...status, at: Date.now() };
  await saveRide(record);
  return record;
}

async function uploadToStrava(id) {
  if (stravaBusy.has(id)) return;
  stravaBusy.add(id);
  try {
    const before = await getRide(id);
    if (!before) return;
    const record = await setStravaStatus(id, { status: 'läuft', uploadId: before.strava && before.strava.uploadId });
    if (!record) return;
    renderHistory();
    const res = await strava.uploadFit({
      bytes: encodeFit(record),
      fileName: fitFileName(record),
      name: record.name,
      externalId: `${record.id}.fit`,
      uploadId: record.strava && record.strava.uploadId,
      // Upload-Nummer sofort merken, damit ein späterer Versuch nachfragen kann statt doppelt zu senden.
      onUploadId: (uploadId) => setStravaStatus(id, { status: 'läuft', uploadId }),
    });
    await setStravaStatus(id, { status: 'hochgeladen', activityId: res.activityId });
    log('Strava', `Hochgeladen: ${record.name} → Aktivität ${res.activityId}${res.duplicate ? ' (war schon da)' : ''}`);
  } catch (err) {
    log('Strava', `Upload fehlgeschlagen: ${err.message}`);
    const cur = await getRide(id).catch(() => null);
    await setStravaStatus(id, { status: 'fehler', error: err.message, uploadId: cur && cur.strava && cur.strava.uploadId }).catch(() => {});
  } finally {
    stravaBusy.delete(id);
    renderHistory();
  }
}

function renderStrava(message = '') {
  const s = strava.loadSettings();
  const connected = strava.isConnected(s);
  $('#strava-setup').hidden = connected;
  $('#strava-connected').hidden = !connected;
  $('#strava-id').value = s.clientId || '';
  $('#strava-secret').value = s.clientSecret || '';
  $('#strava-who').textContent = s.athlete ? `Verbunden als ${s.athlete}.` : 'Verbunden.';
  $('#strava-auto').checked = s.auto !== false;
  $('#strava-msg').textContent = message;
  $('#strava-msg').hidden = !message;
  $('#strava-callback').textContent = location.hostname;
}

$('#strava-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const clientId = $('#strava-id').value.trim();
  const clientSecret = $('#strava-secret').value.trim();
  if (!/^\d+$/.test(clientId) || clientSecret.length < 20) {
    renderStrava('Bitte die Client-ID (nur Ziffern) und das Client-Secret (lange Zeichenfolge) von Strava eintragen.');
    return;
  }
  try {
    strava.storeSettings({ ...strava.loadSettings(), clientId, clientSecret });
  } catch {
    renderStrava('Dieser Browser kann sich nichts merken (privates Fenster?). Bitte in einem normalen Chrome-Fenster öffnen.');
    return;
  }
  location.href = strava.authorizeUrl(clientId, strava.redirectUri(location), strava.newState());
});

$('#strava-auto').addEventListener('change', (e) => {
  strava.storeSettings({ ...strava.loadSettings(), auto: e.target.checked });
});

$('#strava-disconnect').addEventListener('click', () => {
  if (!confirm('Verbindung zu Strava trennen? Bereits hochgeladene Fahrten bleiben auf Strava.')) return;
  strava.disconnect();
  renderStrava('Getrennt. Du kannst jederzeit wieder verbinden.');
  renderHistory();
});

// Rückkehr von der Strava-Anmeldung: Code gegen Schlüssel tauschen und die Adresszeile aufräumen.
(async function handleStravaCallback() {
  const cb = strava.parseCallback(location.search, strava.takeState());
  if (!cb) {
    renderStrava();
    return;
  }
  history.replaceState(null, '', strava.redirectUri(location));
  if (cb.error) {
    renderStrava(cb.error);
    return;
  }
  renderStrava('Verbinde mit Strava …');
  try {
    await strava.finishConnect(cb.code);
    log('Strava', 'Verbunden');
    renderStrava('Mit Strava verbunden. Neue Fahrten werden ab jetzt automatisch hochgeladen.');
    renderHistory();
  } catch (err) {
    log('Strava', `Verbinden fehlgeschlagen: ${err.message}`);
    renderStrava(`Verbinden hat nicht geklappt: ${err.message}`);
  }
  $('#strava-panel').scrollIntoView();
})();

// ---------- Einblendung vor jedem Intervall ----------

let previewKey = null;

function renderPreview(st) {
  const box = $('#r-preview');
  const p = previewFor(st);
  if (!p) {
    box.hidden = true;
    previewKey = null;
    return;
  }
  const s = p.segment;
  $('#p-head').textContent = p.mode === 'gleich'
    ? `In ${p.inS} s: ${s.label} · ${formatTime(s.durationS)}`
    : `Jetzt: ${s.label} · ${formatTime(s.durationS)}`;
  // Inhalt nur beim Wechsel neu aufbauen, damit die Einblendung nicht flackert.
  const key = `${p.index}`;
  if (key !== previewKey) {
    previewKey = key;
    const pct = s.free ? null : (s.startPct + s.endPct) / 2;
    box.style.setProperty('--pz', pct === null ? '#4b5563' : zoneColor(pct));
    $('#p-feel').textContent = segmentFeel(s);
    const effort = segmentEffort(s);
    const dots = $('#p-dots');
    dots.textContent = '';
    for (let i = 1; i <= 10; i++) {
      const d = document.createElement('i');
      if (effort && i <= effort.level) d.className = 'on';
      dots.append(d);
    }
    dots.hidden = !effort;
    $('#p-effort').textContent = effort ? `Anstrengung ${effort.level} von 10 · ${effort.word}` : 'Anstrengung nach Gefühl';
    $('#p-note').textContent = s.note || '';
    $('#p-note').hidden = !s.note;
  }
  box.hidden = false;
}

// ---------- Bedienung ----------

async function startOrPause() {
  if (!ride) return;
  sound.unlock();
  const now = Date.now();
  if (ride.player) {
    const p = ride.player;
    if (p.state === 'bereit') {
      p.start(now);
      log('Workout', `Start: ${ride.workout.name}, FTP ${ftp} W`);
      tickRide();
      announce(p.status(now));
    } else if (p.state === 'läuft') {
      p.pause(now);
      if (erg.on && !erg.paused) await erg.togglePause();
    } else if (p.state === 'pause') {
      p.resume(now);
      // Erst das aktuelle Ziel übernehmen (oder ERG bei freier Fahrt ausschalten), dann weiterfahren,
      // damit nach „Überspringen“ in der Pause nicht kurz das alte Ziel anliegt.
      tickRide();
      if (erg.on && erg.paused) await erg.togglePause();
    }
  } else if (ride.freeStartedAt === null) {
    ride.freeStartedAt = now;
    if (erg.on && erg.paused) await erg.togglePause();
    else if (!erg.on && control.ready && ergSupported) await erg.enable();
  } else {
    ride.freeElapsedMs += now - ride.freeStartedAt;
    ride.freeStartedAt = null;
    if (erg.on && !erg.paused) await erg.togglePause();
  }
  renderRide();
  updateWakeLock();
}

function adjust(deltaW) {
  if (!ride) return;
  if (ride.player) {
    ride.player.adjustOffset(deltaW);
    tickRide();
  } else erg.adjust(deltaW);
  renderRide();
}

function scaleDown() {
  if (!ride) return;
  if (ride.player) {
    ride.player.scale(0.9);
    tickRide();
  } else erg.scale(0.9);
  renderRide();
}

function endRide() {
  if (!ride) return;
  const state = ride.player ? ride.player.state : (ride.freeStartedAt !== null || ride.freeElapsedMs ? 'läuft' : 'bereit');
  // Während der Fahrt zweimal klicken, damit ein versehentlicher Klick nichts abbricht.
  if ((state === 'läuft' || state === 'pause') && Date.now() > ride.endArmedUntil) {
    ride.endArmedUntil = Date.now() + 3000;
    renderRide();
    return;
  }
  if (ride.player && ride.player.state !== 'fertig') log('Workout', 'Vorzeitig beendet');
  closeRide();
}

$('#r-start').addEventListener('click', startOrPause);
$('#r-minus').addEventListener('click', () => adjust(-10));
$('#r-plus').addEventListener('click', () => adjust(10));
$('#r-pct').addEventListener('click', scaleDown);
$('#r-skip').addEventListener('click', () => {
  if (ride && ride.player && ride.player.state !== 'bereit' && ride.player.state !== 'fertig') {
    ride.player.skip(Date.now());
    tickRide();
    renderRide();
  }
});
$('#r-end').addEventListener('click', endRide);

document.addEventListener('keydown', (e) => {
  if (!ride || e.target.tagName === 'INPUT') return;
  const actions = {
    ' ': startOrPause,
    ArrowUp: () => adjust(10),
    ArrowDown: () => adjust(-10),
    PageDown: scaleDown,
    Escape: endRide,
    w: toggleWorld,
    W: toggleWorld,
  };
  const action = actions[e.key];
  if (!action) return;
  e.preventDefault();
  // Gedrückt gehaltene Tasten sollen nicht dauernd umschalten; Pfeile dürfen wiederholen.
  if (e.repeat && !e.key.startsWith('Arrow')) return;
  action();
});

function renderErg() {
  if (ride) renderRide();
  updateWakeLock();
}

// Bildschirm wach halten, solange gefahren wird (sonst schläft der Laptop mitten im Intervall ein).
let wakeLock = null;
let wakeLockBusy = false;
function wantWakeLock() {
  return erg.on || rideRunning();
}
async function updateWakeLock() {
  if (wakeLockBusy) return;
  wakeLockBusy = true;
  const want = wantWakeLock();
  try {
    if (want && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      const lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
      wakeLock = lock;
    } else if (!want && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  } catch (err) {
    log('Browser', `Bildschirm wach halten nicht möglich: ${err.message}`);
    wakeLockBusy = false;
    return; // nicht sofort erneut versuchen, sonst endlose Schleife bei dauerhafter Ablehnung
  } finally {
    wakeLockBusy = false;
  }
  // Zustand kann sich während des Wartens geändert haben.
  if (Boolean(wakeLock) !== wantWakeLock() && document.visibilityState === 'visible' && 'wakeLock' in navigator) {
    setTimeout(updateWakeLock, 0);
  }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') updateWakeLock(); });

loadWorkouts();

// ---------- Geräte ----------

// Beim Trainer hängt zusätzlich die ERG-Steuerung am Verbindungsstatus.
function trainerStatus() {
  const base = statusHandler('#dev-trainer', 'Trainer verbinden');
  return (state, detail) => {
    base(state, detail);
    if (state !== 'verbunden') control.detach();
    // Getrennt, aufgegeben oder Fehler: ERG aus, damit es beim nächsten Verbinden nicht überraschend
    // weiterläuft. Nur beim automatischen Wiederverbinden bleibt ERG an.
    if (['getrennt', 'verloren', 'fehler'].includes(state) && erg.on) {
      erg.on = false;
      erg.paused = false;
    }
    renderErg();
  };
}

const devices = {
  trainer: new BleDevice({
    label: 'Trainer',
    service: 0x1826, // Fitness Machine Service (FTMS)
    optionalServices: [0x180a, 0x1818],
    async setup(server, dev) {
      const ftms = await server.getPrimaryService(0x1826);
      const items = [];
      ergSupported = false;

      const featureDv = await tryRead(ftms, 0x2acc);
      if (featureDv) {
        log('Trainer', `Feature: ${toHex(featureDv)}`);
        const f = parseMachineFeature(featureDv);
        log('Trainer', `Misst: ${f.machine.join(', ') || '–'}`);
        log('Trainer', `Steuerbar: ${f.target.join(', ') || '–'}`);
        items.push(yesNo('ERG (Zielleistung setzen)', f.powerTargetSupported));
        ergSupported = f.powerTargetSupported;
        items.push(yesNo('Simulation (Steigung)', f.simulationSupported));
        items.push(`<li>Misst laut Trainer: ${escapeHtml(f.machine.join(', ') || '–')}</li>`);
      } else {
        items.push('<li>Fähigkeiten konnten nicht gelesen werden.</li>');
      }

      const rangeDv = await tryRead(ftms, 0x2ad8);
      if (rangeDv) {
        const r = parsePowerRange(rangeDv);
        log('Trainer', `Leistungsbereich: ${toHex(rangeDv)} → ${r.min} bis ${r.max} W, Schritt ${r.step} W`);
        items.push(`<li>Leistungsbereich laut Trainer: ${r.min} bis ${r.max} W</li>`);
        erg.setRange(r.min, r.max);
      }

      const info = await readDeviceInfo(server);
      if (info) {
        log('Trainer', `Geräteinfo: ${JSON.stringify(info)}`);
        if (info.firmware) items.push(`<li>Firmware: ${escapeHtml(info.firmware)}</li>`);
      }

      $('#trainer-info').innerHTML = items.join('');

      await dev.subscribe(ftms, 0x2ad2, (dv) => {
        const d = parseIndoorBikeData(dv);
        log('Trainer', `Daten ${toHex(dv)} → ${JSON.stringify(d)}`);
        if (d.power !== undefined) setMetric('power', d.power);
        if (d.speedKmh !== undefined) setMetric('speed', d.speedKmh);
        if (d.cadence !== undefined) setMetric('trainerCad', d.cadence);
        // Bluetooth-Pakete kommen auch in verdeckten Tabs zuverlässig, Timer werden dort gedrosselt:
        // so wechselt das Ziel trotzdem pünktlich.
        tickRide();
        recordTick();
      });

      // Statusmeldungen des Trainers nur protokollieren (zeigt, was er mit unseren Befehlen macht).
      try {
        await dev.subscribe(ftms, 0x2ada, (dv) => log('Trainer', `Status ${toHex(dv)}`));
      } catch {
        log('Trainer', 'Kein Status-Kanal');
      }

      if (ergSupported) {
        try {
          await control.attach(ftms, dev);
          // Nicht abwarten, damit setup() fertig wird und die Messwerte sofort laufen.
          erg.resync();
        } catch (err) {
          ergSupported = false;
          log('Trainer', `Steuerung nicht verfügbar: ${err.message}`);
        }
      }
      renderErg();
    },
  }, { log, onStatus: trainerStatus() }),

  hr: new BleDevice({
    label: 'Brustgurt',
    service: 0x180d, // Heart Rate Service
    optionalServices: [0x180a, 0x180f],
    async setup(server, dev) {
      const svc = await server.getPrimaryService(0x180d);
      await logBattery(server, 'Brustgurt');
      await dev.subscribe(svc, 0x2a37, (dv) => {
        const d = parseHeartRate(dv);
        log('Brustgurt', `Daten ${toHex(dv)} → ${d.bpm} bpm${d.contact === false ? ', kein Hautkontakt' : ''}`);
        // Ohne Hautkontakt meldet der Gurt Unsinn (oft 0), dann lieber „–“ anzeigen.
        if (d.contact !== false && d.bpm > 0) setMetric('hr', d.bpm);
      });
    },
  }, { log, onStatus: statusHandler('#dev-hr', 'Brustgurt verbinden') }),

  cad: new BleDevice({
    label: 'Kadenz',
    service: 0x1816, // Cycling Speed and Cadence Service
    optionalServices: [0x180a, 0x180f],
    async setup(server, dev) {
      const svc = await server.getPrimaryService(0x1816);
      await logBattery(server, 'Kadenz');
      cadenceCalc.reset();
      let noCrankWarned = false;
      await dev.subscribe(svc, 0x2a5b, (dv) => {
        const d = parseCscMeasurement(dv);
        log('Kadenz', `Daten ${toHex(dv)} → ${JSON.stringify(d)}`);
        if (d.crankRevs !== undefined) {
          setMetric('cad', cadenceCalc.update(d.crankRevs, d.crankTime, Date.now()));
        } else if (!noCrankWarned) {
          // Nur einmal pro Verbindung melden, sonst verdrängt die Meldung die wichtigen Einträge.
          noCrankWarned = true;
          log('Kadenz', 'Keine Kurbeldaten im Paket. Ist der Sensor im Geschwindigkeitsmodus?');
        }
      });
    },
  }, { log, onStatus: statusHandler('#dev-cad', 'Kadenzsensor verbinden') }),
};

async function logBattery(server, label) {
  try {
    const svc = await server.getPrimaryService(0x180f);
    const v = await tryRead(svc, 0x2a19);
    if (v) log(label, `Batterie: ${v.getUint8(0)} %`);
  } catch {
    // Kein Batteriedienst, ist in Ordnung.
  }
}

document.querySelectorAll('[data-connect]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const dev = devices[btn.dataset.connect];
    try {
      // Nach einem Abbruch das bekannte Gerät direkt neu verbinden, sonst Auswahlfenster zeigen.
      if (dev.device && btn.dataset.state === 'verloren') await dev.connect();
      else await dev.choose({ showAll: $('#show-all').checked });
    } catch (err) {
      if (dev.manualDisconnect) {
        // Der Nutzer hat während des Verbindens auf „Trennen“ geklickt, das ist kein Fehler.
        dev.onStatus('getrennt');
      } else if (err.name === 'NotFoundError') {
        log(dev.spec.label, 'Auswahl abgebrochen oder kein Gerät gefunden');
        dev.onStatus('getrennt');
      } else {
        log(dev.spec.label, `Fehler: ${err.name}: ${err.message}`);
        dev.onStatus('fehler', err.message);
      }
    }
  });
});

document.querySelectorAll('[data-disconnect]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    // ERG vor dem Trennen sauber beenden, damit der Trainer nicht auf dem letzten Ziel stehen bleibt.
    if (btn.dataset.disconnect === 'trainer' && erg.on) await erg.disable();
    devices[btn.dataset.disconnect].disconnect();
  });
});

// ---------- Simulator (zum Ausprobieren ohne Trainer) ----------

let simTimer = null;
$('#sim-toggle').addEventListener('click', () => {
  if (simTimer) {
    clearInterval(simTimer);
    simTimer = null;
    $('#sim-toggle').textContent = 'Simulator starten';
    log('Simulator', 'gestoppt');
    return;
  }
  log('Simulator', 'gestartet (Werte sind erfunden)');
  $('#sim-toggle').textContent = 'Simulator stoppen';
  let t = 0;
  simTimer = setInterval(() => {
    t += 1;
    // Folgt dem aktuellen Ziel, damit sich Workouts auch ohne Trainer ausprobieren lassen.
    const target = currentTargetW();
    const base = target ?? 150 + Math.round(20 * Math.sin(t / 5));
    setMetric('power', base + Math.round(Math.random() * 6) - 3);
    setMetric('hr', 120 + Math.round(10 * Math.sin(t / 30)));
    setMetric('cad', 85 + Math.round(Math.random() * 6));
    setMetric('speed', 30 + Math.random());
  }, 1000);
});

// ---------- Browser prüfen ----------

(async function checkBrowser() {
  const warn = $('#browser-warning');
  if (!('bluetooth' in navigator)) {
    warn.hidden = false;
    warn.textContent = 'Dieser Browser kann kein Bluetooth. Bitte die Seite am Laptop in Google Chrome oder Microsoft Edge öffnen.';
    document.querySelectorAll('[data-connect]').forEach((b) => { b.disabled = true; });
    log('Browser', 'Web Bluetooth nicht verfügbar');
    return;
  }
  try {
    const available = await navigator.bluetooth.getAvailability();
    if (!available) {
      warn.hidden = false;
      warn.textContent = 'Bluetooth scheint am Laptop ausgeschaltet zu sein. Bitte in den Windows-Einstellungen einschalten.';
    }
    log('Browser', `Web Bluetooth verfügbar, Bluetooth an: ${available}`);
  } catch (err) {
    log('Browser', `Verfügbarkeit unbekannt: ${err.message}`);
  }
  log('Browser', navigator.userAgent);
})();

renderErg();
