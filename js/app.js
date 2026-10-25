import { BleDevice, tryRead, readDeviceInfo } from './ble.js';
import { FtmsControl } from './ftms.js';
import { ErgController } from './erg.js';
import { parseZwo, totalDuration, formatTime, cadenceTarget, formatCadence } from './workout.js';
import { Sound, soundCue, SOUND_LABELS } from './sound.js';
import { WorkoutPlayer } from './player.js';
import { powerZone } from './zones.js';
import { normalizeEntry, planDate, sortByPlan, defaultBriefing } from './plan.js';
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
  };
  if (!workout) erg.setTarget(Math.round(ftp * 0.55));
  $('#setup-screen').hidden = true;
  $('#ride-screen').hidden = false;
  $('#r-name').textContent = workout ? workout.name : 'Freie Fahrt';
  $('#r-profile-box').hidden = !workout;
  $('#r-skip').hidden = !workout;
  $('#r-sound').hidden = !workout;
  buildProfile();
  renderRide();
  window.scrollTo(0, 0);
}

async function closeRide() {
  // Erst die Fahrt abmelden, dann ERG ausschalten: sonst schaltet der Takt ERG
  // wieder ein, während der Trainer den Stopp noch bestätigt.
  const r = ride;
  ride = null;
  sound.silence();
  if (r && r.player && r.player.state !== 'fertig') r.player.stop(Date.now());
  if (erg.on) await erg.disable();
  $('#ride-screen').hidden = true;
  $('#setup-screen').hidden = false;
  $('#ride-screen').classList.remove('done');
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
  renderRide();
  updateWakeLock();
}

setInterval(() => {
  tickRide();
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

  if (state === 'fertig') setAlert(`Workout geschafft! ${formatTime(ride.player.totalS)} gefahren. Speichern kommt in der nächsten Version.`, 'info');
  else if (erg.error) setAlert(`Problem: ${erg.error}`);
  else if (state === 'läuft' && target !== null && !control.ready) setAlert('Trainer nicht verbunden: Das Watt-Ziel wird gerade nicht an den Trainer geschickt.');
  else if (state === 'läuft' && target !== null && control.ready && !ergSupported) setAlert('Dieser Trainer meldet keinen ERG-Modus.');
  else setAlert('');
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
