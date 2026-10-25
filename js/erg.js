// ERG-Logik: merkt sich Ziel und Zustand und schickt dem Trainer immer nur den neuesten Zielwert.
// Wer schnell mehrmals +10 W drückt, erzeugt so keinen Stau an Bluetooth-Befehlen.

export class ErgController {
  constructor({ control, log, onChange }) {
    this.control = control;
    this.log = log;
    this.onChange = onChange || (() => {});
    this.on = false;
    this.paused = false;
    this.target = 100;
    this.min = 50;
    this.max = 600;
    this.sentTarget = null;
    this.busy = false;
    this.error = null;
  }

  setRange(min, max) {
    if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
      this.min = min;
      this.max = max;
      this.target = this.clamp(this.target);
      this.onChange();
    }
  }

  clamp(w) {
    return Math.min(this.max, Math.max(this.min, Math.round(w)));
  }

  setTarget(w) {
    if (!Number.isFinite(w)) return;
    this.target = this.clamp(w);
    this.onChange();
    this._flush();
  }

  adjust(delta) {
    this.setTarget(this.target + delta);
  }

  scale(factor) {
    this.setTarget(this.target * factor);
  }

  async enable() {
    this.on = true;
    this.paused = false;
    this.error = null;
    this.sentTarget = null;
    this.onChange();
    await this._tryStart();
    await this._flush();
  }

  async disable() {
    this.on = false;
    this.paused = false;
    this.error = null;
    this.onChange();
    if (!this.control.ready) return;
    await this._stopTrainer();
  }

  // Stopp schicken; klappt das nicht, wenigstens die kleinste Leistung setzen und den Fahrer warnen.
  async _stopTrainer() {
    try {
      await this.control.stop();
      return;
    } catch (err) {
      this.log('ERG', `Stopp nicht bestätigt: ${err.message}`);
    }
    try {
      await this.control.setTargetPower(this.min);
      this.sentTarget = this.min;
      this._fail(new Error(`Trainer hat das Ausschalten nicht bestätigt und hält jetzt ${this.min} W. Notfalls Trainer aus- und einschalten.`));
    } catch (err) {
      this._fail(new Error(`Trainer hat das Ausschalten nicht bestätigt. Notfalls aufhören zu treten oder den Trainer vom Strom nehmen. (${err.message})`));
    }
  }

  async togglePause() {
    if (!this.on) return;
    if (this.paused) {
      this.paused = false;
      this.sentTarget = null;
      this.onChange();
      await this._tryStart();
      await this._flush();
      return;
    }
    this.paused = true;
    this.onChange();
    await this._pauseTrainer();
    // Wurde während der Pause schon wieder „Weiter“ gedrückt, das Ziel sicher erneut senden.
    if (this.on && !this.paused) {
      this.sentTarget = null;
      await this._flush();
    }
  }

  async _pauseTrainer() {
    try {
      await this.control.pause();
    } catch (err) {
      // Kann der Trainer keine Pause, wenigstens auf die kleinste Leistung gehen.
      this.log('ERG', `Pause nicht unterstützt (${err.message}), setze ${this.min} W`);
      try {
        await this.control.setTargetPower(this.min);
        this.sentTarget = this.min;
      } catch (err2) {
        this._fail(err2);
      }
    }
  }

  // Nach jedem (Wieder-)Verbinden: Der Trainer kann das alte Ziel vergessen oder behalten haben,
  // deshalb den Zustand der App ausdrücklich herstellen.
  async resync() {
    this.sentTarget = null;
    if (!this.control.ready) return;
    if (this.on && !this.paused) {
      await this._tryStart();
      await this._flush();
    } else if (this.on && this.paused) {
      await this._pauseTrainer();
    } else {
      try {
        await this.control.stop();
      } catch (err) {
        this.log('ERG', `Stopp beim Verbinden nicht bestätigt: ${err.message}`);
      }
    }
  }

  async _tryStart() {
    if (!this.control.ready) return;
    try {
      await this.control.start();
    } catch (err) {
      // Viele Trainer brauchen keinen Start-Befehl, daher nur protokollieren.
      this.log('ERG', `Start nicht bestätigt: ${err.message}`);
    }
  }

  async _flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.on && !this.paused && this.control.ready && this.sentTarget !== this.target) {
        const t = this.target;
        try {
          await this.control.setTargetPower(t);
          this.sentTarget = t;
          this.error = null;
          this.log('ERG', `Ziel ${t} W gesetzt`);
        } catch (err) {
          this._fail(err);
          break;
        }
      }
    } finally {
      this.busy = false;
      this.onChange();
    }
  }

  _fail(err) {
    this.error = err.message;
    this.log('ERG', `Fehler: ${err.message}`);
    this.onChange();
  }
}
