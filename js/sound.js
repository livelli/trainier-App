// Tonsignale während des Workouts: drei kurze Piepser vor einem Wechsel, ein langer beim Wechsel,
// auf Wunsch zusätzlich eine kurze Ansage. Der Ton braucht einen Klick (Start), sonst blockiert Chrome ihn.

export const SOUND_MODES = ['ansage', 'piepsen', 'aus'];
export const SOUND_LABELS = { ansage: 'Ton: Piepsen + Ansage', piepsen: 'Ton: nur Piepsen', aus: 'Ton: aus' };

// Entscheidet aus dem letzten und dem aktuellen Stand, welches Signal fällig ist.
// prev: { index, remaining } oder null; st: Status des Players (index, segRemainingS, next, state).
export function soundCue(prev, st) {
  const now = { index: st.index, remaining: Math.ceil(st.segRemainingS) };
  if (st.state === 'fertig') return { cue: prev && prev.index !== -1 ? 'fertig' : null, state: { index: -1, remaining: 0 } };
  if (st.state !== 'läuft') return { cue: null, state: prev ?? now };
  if (!prev || prev.index === -1) return { cue: null, state: now };
  if (now.index !== prev.index) return { cue: 'wechsel', state: now };
  // Countdown nur, wenn noch ein Abschnitt folgt und der aktuelle lang genug ist, um ihn anzukündigen.
  if (st.next && st.segment.durationS >= 10 && now.remaining <= 3 && now.remaining >= 1 && now.remaining !== prev.remaining) {
    return { cue: 'countdown', state: now };
  }
  return { cue: null, state: now };
}

export class Sound {
  constructor(mode = 'ansage') {
    this.mode = SOUND_MODES.includes(mode) ? mode : 'ansage';
    this.ctx = null;
  }

  // Muss in einem Klick aufgerufen werden.
  unlock() {
    if (this.mode === 'aus') return;
    try {
      if (!this.ctx) this.ctx = new AudioContext();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  nextMode() {
    this.mode = SOUND_MODES[(SOUND_MODES.indexOf(this.mode) + 1) % SOUND_MODES.length];
    if (this.mode === 'aus') window.speechSynthesis?.cancel();
    return this.mode;
  }

  _beep(freq, durationS, delayS = 0) {
    if (!this.ctx || this.mode === 'aus') return;
    const t = this.ctx.currentTime + delayS;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.4, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + durationS);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + durationS + 0.02);
  }

  countdown() { this._beep(880, 0.15); }

  change() { this._beep(1320, 0.5); }

  finish() {
    this._beep(1047, 0.2);
    this._beep(1319, 0.2, 0.22);
    this._beep(1568, 0.5, 0.44);
  }

  say(text) {
    if (this.mode !== 'ansage' || !text || !window.speechSynthesis) return;
    // Eine fehlende oder kaputte Sprachausgabe darf das Workout nie stören.
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'de-DE';
      u.rate = 1.05;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch { /* dann eben nur Piepser */ }
  }
}
