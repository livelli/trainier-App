// Verbindung zu einem Bluetooth-Gerät mit automatischem Wiederverbinden.
// Jede Geräteart (Trainer, Brustgurt, Kadenzsensor) bekommt eine eigene Instanz.

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

export class BleDevice {
  // spec: { label, service, optionalServices, setup(server, bleDevice) }
  // setup() abonniert die Messwerte über bleDevice.subscribe() und wird nach jedem
  // (Wieder-)Verbinden erneut aufgerufen, weil Web Bluetooth nach einem Abbruch alle Dienste ungültig macht.
  constructor(spec, { log, onStatus }) {
    this.spec = spec;
    this.log = log;
    this.onStatus = onStatus;
    this.device = null;
    this.subscriptions = [];
    this.connecting = null; // laufender Verbindungsaufbau (Promise), damit nie zwei parallel laufen
    this.retrying = false; // eine Wiederverbindungs-Kette ist aktiv
    this.manualDisconnect = false;
    this.ignoreNextDisconnect = false;
    this.retryTimer = null;
    this._onDisconnected = () => this._handleDisconnect();
  }

  get connected() {
    return Boolean(this.device && this.device.gatt.connected);
  }

  // Muss direkt aus einem Klick heraus aufgerufen werden (Vorgabe von Chrome).
  async choose({ showAll = false } = {}) {
    const optionalServices = [this.spec.service, ...(this.spec.optionalServices || [])];
    const options = showAll
      ? { acceptAllDevices: true, optionalServices }
      : { filters: [{ services: [this.spec.service] }], optionalServices };

    const device = await navigator.bluetooth.requestDevice(options);
    if (this.device !== device) {
      if (this.device) {
        this.device.removeEventListener('gattserverdisconnected', this._onDisconnected);
        // Listener ist schon entfernt, daher keine Markierung für das Trennen-Ereignis setzen.
        if (this.device.gatt.connected) this.device.gatt.disconnect();
      }
      this.device = device;
      this.device.addEventListener('gattserverdisconnected', this._onDisconnected);
    }
    this.log(this.spec.label, `Gerät gewählt: ${device.name || '(ohne Namen)'} (${device.id})`);
    await this.connect();
  }

  connect() {
    if (!this.device) return Promise.reject(new Error('Kein Gerät gewählt'));
    if (!this.connecting) {
      this.connecting = this._connect().finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  async _connect() {
    clearTimeout(this.retryTimer);
    this.manualDisconnect = false;
    this.onStatus('verbinde');
    try {
      const server = await this.device.gatt.connect();
      this.log(this.spec.label, 'Verbunden');
      this._clearSubscriptions();
      await this.spec.setup(server, this);
    } catch (err) {
      // Halb aufgebaute Verbindung schließen, damit ein neuer Versuch sauber beginnt.
      if (this.device.gatt.connected) {
        this.ignoreNextDisconnect = true;
        this.device.gatt.disconnect();
      }
      throw err;
    }
    if (this.manualDisconnect) {
      // Der Nutzer hat während des Verbindungsaufbaus auf „Trennen“ geklickt.
      this.disconnect();
      return;
    }
    this.onStatus('verbunden', this.device.name);
  }

  async subscribe(service, uuid, handler) {
    const ch = await service.getCharacteristic(uuid);
    const listener = (e) => handler(e.target.value);
    ch.addEventListener('characteristicvaluechanged', listener);
    this.subscriptions.push({ ch, listener });
    await ch.startNotifications();
    return ch;
  }

  _clearSubscriptions() {
    for (const { ch, listener } of this.subscriptions) {
      ch.removeEventListener('characteristicvaluechanged', listener);
    }
    this.subscriptions = [];
  }

  disconnect() {
    this.manualDisconnect = true;
    this.retrying = false;
    clearTimeout(this.retryTimer);
    if (this.connected) this.device.gatt.disconnect();
    this.onStatus('getrennt');
  }

  _handleDisconnect() {
    if (this.ignoreNextDisconnect) {
      this.ignoreNextDisconnect = false;
      return;
    }
    this.log(this.spec.label, 'Verbindung getrennt');
    // Während eines Verbindungsaufbaus oder einer laufenden Kette kümmert sich der Aufrufer um den nächsten Versuch.
    if (this.manualDisconnect || this.retrying || this.connecting) return;
    this.retrying = true;
    this._scheduleRetry(0);
  }

  _scheduleRetry(index) {
    if (!this.retrying || this.manualDisconnect) return;
    if (index >= RETRY_DELAYS_MS.length) {
      this.retrying = false;
      this.onStatus('verloren');
      return;
    }
    this.onStatus('wiederverbinden', `Versuch ${index + 1} von ${RETRY_DELAYS_MS.length}`);
    this.retryTimer = setTimeout(async () => {
      if (!this.retrying || this.manualDisconnect) return;
      try {
        await this.connect();
        this.retrying = false;
      } catch (err) {
        this.log(this.spec.label, `Wiederverbinden fehlgeschlagen: ${err.message}`);
        this._scheduleRetry(index + 1);
      }
    }, RETRY_DELAYS_MS[index]);
  }
}

// Liest einen Wert und gibt null zurück, wenn das Gerät ihn nicht anbietet.
export async function tryRead(service, uuid) {
  try {
    const ch = await service.getCharacteristic(uuid);
    return await ch.readValue();
  } catch {
    return null;
  }
}

// Liest Hersteller, Modell und Firmware aus dem Geräteinformationsdienst, falls vorhanden.
export async function readDeviceInfo(server) {
  try {
    const svc = await server.getPrimaryService(0x180a);
    const dec = new TextDecoder();
    const info = {};
    for (const [key, uuid] of [['hersteller', 0x2a29], ['modell', 0x2a24], ['firmware', 0x2a26], ['hardware', 0x2a27]]) {
      const v = await tryRead(svc, uuid);
      if (v) info[key] = dec.decode(v).replace(/\0/g, '').trim();
    }
    return info;
  } catch {
    return null;
  }
}
