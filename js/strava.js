// Verbindung zu Strava: Anmeldung (OAuth) und Upload der FIT-Datei.
// Client-ID, Client-Secret und Zugangsschlüssel liegen nur im Browser auf diesem Laptop (localStorage),
// nie im Code oder im öffentlichen Repository.

const KEY = 'trainerApp.strava';
const AUTH_URL = 'https://www.strava.com/oauth/authorize';
const TOKEN_URL = 'https://www.strava.com/oauth/token';
const API = 'https://www.strava.com/api/v3';
const SCOPE = 'activity:write';
const STATE = 'trainer-app-strava';

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

export function storeSettings(s) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function isConnected(s = loadSettings()) {
  return Boolean(s.clientId && s.clientSecret && s.refreshToken);
}

// Die Seite selbst ist die Rücksprungadresse (ohne ?code=… von früher).
export function redirectUri(loc) {
  return `${loc.origin}${loc.pathname}`;
}

export function authorizeUrl(clientId, redirect, state) {
  const q = new URLSearchParams({
    client_id: String(clientId),
    response_type: 'code',
    redirect_uri: redirect,
    approval_prompt: 'auto',
    scope: SCOPE,
    state,
  });
  return `${AUTH_URL}?${q}`;
}

// Liest die Antwort von Strava nach der Anmeldung aus der Adresszeile.
// Ergebnis: null (keine Strava-Antwort), { error } oder { code }.
export function parseCallback(search, expectedState) {
  const q = new URLSearchParams(search);
  const state = q.get('state') || '';
  if (!state.startsWith(STATE)) return null;
  if (state !== expectedState) return { error: 'Die Anmeldung bei Strava passt nicht zu diesem Fenster. Bitte nochmals auf „Mit Strava verbinden“ klicken.' };
  if (q.get('error')) return { error: q.get('error') === 'access_denied' ? 'Du hast den Zugriff bei Strava abgelehnt.' : q.get('error') };
  const code = q.get('code');
  if (!code) return null;
  const scopes = (q.get('scope') || '').split(',');
  if (!scopes.includes(SCOPE)) return { error: 'Bei Strava fehlt das Häkchen für „Aktivitäten hochladen“. Bitte nochmals verbinden und es anhaken.' };
  return { code };
}

const NETWORK_HINT = 'Strava ist nicht erreichbar. Prüfe das Internet. Falls es dauerhaft so bleibt, blockiert der Browser die Verbindung zu Strava; die FIT-Datei kannst du weiterhin herunterladen und selbst hochladen.';

async function call(url, options) {
  try {
    return await fetch(url, options);
  } catch {
    throw new Error(NETWORK_HINT);
  }
}

async function tokenRequest(body) {
  const res = await call(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  // Ungültiger oder widerrufener Zugang (400 bei Refresh-Token, 401 bei falschem Secret).
  if (res.status === 400 || res.status === 401) {
    throw new Error('Strava kennt diese Verbindung nicht mehr. Bitte „Verbindung trennen“ und neu verbinden, dabei Client-ID und Client-Secret prüfen.');
  }
  if (!res.ok) throw new Error(stravaError(res.status, data));
  return data;
}

function stravaError(status, data) {
  if (status === 401) return 'Strava hat den Zugang abgelehnt. Bitte „Verbindung trennen“ und neu verbinden.';
  if (status === 429) return 'Strava meldet zu viele Anfragen. Bitte später nochmals versuchen.';
  const first = data && Array.isArray(data.errors) && data.errors[0];
  const extra = first ? ` (${[first.resource, first.field, first.code].filter(Boolean).join(' ')})` : '';
  const detail = data && (data.message || data.error);
  return `Strava-Fehler ${status}${detail ? `: ${detail}` : ''}${extra}`;
}

// Zufälliger state gegen untergeschobene Anmelde-Links; gilt nur in diesem Tab bis zur Rückkehr.
const STATE_KEY = 'trainerApp.stravaState';

export function newState() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const state = `${STATE}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  sessionStorage.setItem(STATE_KEY, state);
  return state;
}

export function takeState() {
  const v = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);
  return v;
}

export async function finishConnect(code) {
  const s = loadSettings();
  if (!s.clientId || !s.clientSecret) throw new Error('Client-ID und Client-Secret fehlen. Bitte erneut eintragen.');
  const data = await tokenRequest({
    client_id: s.clientId,
    client_secret: s.clientSecret,
    code,
    grant_type: 'authorization_code',
  });
  const athlete = data.athlete || {};
  storeSettings({
    ...loadSettings(),
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at,
    athlete: [athlete.firstname, athlete.lastname].filter(Boolean).join(' '),
    auto: s.auto ?? true,
  });
}

// Strava macht den alten Refresh-Token sofort ungültig, darum nie zwei Erneuerungen gleichzeitig.
let refreshing = null;

async function refresh(s) {
  const data = await tokenRequest({
    client_id: s.clientId,
    client_secret: s.clientSecret,
    refresh_token: s.refreshToken,
    grant_type: 'refresh_token',
  });
  // Neu lesen: In der Zwischenzeit kann getrennt oder „automatisch“ umgestellt worden sein.
  const now = loadSettings();
  if (now.refreshToken !== s.refreshToken) throw new Error('Nicht mit Strava verbunden.');
  storeSettings({ ...now, accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: data.expires_at });
  return data.access_token;
}

async function accessToken() {
  const s = loadSettings();
  if (!isConnected(s)) throw new Error('Nicht mit Strava verbunden.');
  // Der Schlüssel gilt 6 Stunden, danach mit dem Refresh-Token einen neuen holen.
  if (s.accessToken && s.expiresAt - 120 > Date.now() / 1000) return s.accessToken;
  if (!refreshing) refreshing = refresh(s).finally(() => { refreshing = null; });
  return refreshing;
}

export function disconnect() {
  const s = loadSettings();
  // Client-ID und Secret behalten, damit ein neues Verbinden nur einen Klick braucht.
  storeSettings({ clientId: s.clientId, clientSecret: s.clientSecret, auto: s.auto });
}

// Wertet eine Upload-Antwort aus: fertig mit Aktivität, Fehler, Duplikat oder noch in Arbeit.
export function uploadState(data) {
  if (data.activity_id) return { done: true, activityId: data.activity_id };
  if (data.error) {
    // z. B. „fahrt-123.fit duplicate of activity 9876543210“ oder mit Link auf /activities/9876543210
    const dup = /duplicate of\D*?(\d{5,})/i.exec(data.error);
    if (dup) return { done: true, activityId: Number(dup[1]), duplicate: true };
    return { done: true, error: String(data.error).replace(/<[^>]+>/g, '') };
  }
  return { done: false };
}

export function activityUrl(id) {
  return `https://www.strava.com/activities/${id}`;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Wartet, bis Strava einen Upload verarbeitet hat (meist wenige Sekunden).
async function pollUpload(id, token, data = null) {
  for (let i = 0; i < 30; i++) {
    if (data) {
      const st = uploadState(data);
      if (st.done) {
        if (st.error) throw new Error(`Strava konnte die Fahrt nicht verarbeiten: ${st.error}`);
        return st;
      }
      await wait(2000);
    }
    const res = await call(`${API}/uploads/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(stravaError(res.status, data));
  }
  throw new Error('Strava verarbeitet die Fahrt noch. Später nochmals auf „Nochmals zu Strava“ klicken.');
}

// Lädt eine FIT-Datei hoch. Gibt es schon eine Upload-Nummer von einem früheren Versuch,
// wird zuerst dort nachgefragt statt die Datei nochmals zu schicken.
export async function uploadFit({ bytes, fileName, name, externalId, uploadId = null, onUploadId = () => {} }) {
  const token = await accessToken();
  if (uploadId) {
    try {
      return await pollUpload(uploadId, token);
    } catch {
      // Unbekannt oder fehlgeschlagen: neu hochladen.
    }
  }
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), fileName);
  form.append('data_type', 'fit');
  form.append('name', name);
  form.append('trainer', '1');
  form.append('external_id', externalId);
  const res = await call(`${API}/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(stravaError(res.status, data));
  if (data.id) await onUploadId(data.id);
  return pollUpload(data.id, token, data);
}
