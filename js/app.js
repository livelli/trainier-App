import { BleDevice, tryRead, readDeviceInfo } from './ble.js';
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
  show('trainerCad', '#m-trainer-cad', (v) => `${Math.round(v)} U/min`);
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

// ---------- Geräte ----------

const devices = {
  trainer: new BleDevice({
    label: 'Trainer',
    service: 0x1826, // Fitness Machine Service (FTMS)
    optionalServices: [0x180a, 0x1818],
    async setup(server, dev) {
      const ftms = await server.getPrimaryService(0x1826);
      const items = [];

      const featureDv = await tryRead(ftms, 0x2acc);
      if (featureDv) {
        log('Trainer', `Feature: ${toHex(featureDv)}`);
        const f = parseMachineFeature(featureDv);
        log('Trainer', `Misst: ${f.machine.join(', ') || '–'}`);
        log('Trainer', `Steuerbar: ${f.target.join(', ') || '–'}`);
        items.push(yesNo('ERG (Zielleistung setzen)', f.powerTargetSupported));
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
      });

      // Statusmeldungen des Trainers nur protokollieren (hilft in Phase 2 beim ERG).
      try {
        await dev.subscribe(ftms, 0x2ada, (dv) => log('Trainer', `Status ${toHex(dv)}`));
      } catch {
        log('Trainer', 'Kein Status-Kanal');
      }
    },
  }, { log, onStatus: statusHandler('#dev-trainer', 'Trainer verbinden') }),

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
  btn.addEventListener('click', () => devices[btn.dataset.disconnect].disconnect());
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
    setMetric('power', 150 + Math.round(20 * Math.sin(t / 5)) + Math.round(Math.random() * 10));
    setMetric('hr', 120 + Math.round(10 * Math.sin(t / 30)));
    setMetric('cad', 85 + Math.round(Math.random() * 6));
    setMetric('speed', 30 + Math.random());
    setMetric('trainerCad', 30);
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
