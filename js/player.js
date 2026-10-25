// Spielt ein Workout ab: berechnet aus der verstrichenen Zeit den aktuellen Abschnitt und das Ziel in Watt.
// Die Zeit kommt von außen (Date.now()), damit Pausen und Hintergrund-Tabs die Uhr nicht verfälschen.

export class WorkoutPlayer {
  constructor(workout, { ftp }) {
    this.workout = workout;
    this.ftp = ftp;
    this.starts = [];
    let t = 0;
    for (const s of workout.segments) {
      this.starts.push(t);
      t += s.durationS;
    }
    this.totalS = t;
    this.state = 'bereit'; // bereit | läuft | pause | fertig
    this.elapsedBeforeMs = 0;
    this.runningSince = null;
    this.offsetW = 0; // ±10 W gelten für den Rest des Workouts
    this.factor = 1; // −10 % ebenso
  }

  start(now) {
    if (this.state !== 'bereit') return;
    this.state = 'läuft';
    this.runningSince = now;
  }

  pause(now) {
    if (this.state !== 'läuft') return;
    this.elapsedBeforeMs += now - this.runningSince;
    this.runningSince = null;
    this.state = 'pause';
  }

  resume(now) {
    if (this.state !== 'pause') return;
    this.runningSince = now;
    this.state = 'läuft';
  }

  stop(now) {
    if (this.state === 'läuft') this.pause(now);
    this.state = 'fertig';
  }

  elapsedS(now) {
    const ms = this.elapsedBeforeMs + (this.runningSince !== null ? now - this.runningSince : 0);
    return Math.min(this.totalS, ms / 1000);
  }

  // Springt an den Anfang des nächsten Abschnitts.
  skip(now) {
    const st = this.status(now);
    if (st.index < 0 || st.index >= this.workout.segments.length - 1) return;
    this.elapsedBeforeMs = this.starts[st.index + 1] * 1000;
    if (this.runningSince !== null) this.runningSince = now;
  }

  adjustOffset(deltaW) {
    this.offsetW += deltaW;
  }

  scale(f) {
    this.factor *= f;
  }

  targetW(segment, tInSegS) {
    if (segment.free) return null;
    const frac = segment.durationS > 0 ? Math.min(1, Math.max(0, tInSegS / segment.durationS)) : 0;
    const pct = segment.startPct + (segment.endPct - segment.startPct) * frac;
    return Math.round(pct * this.ftp * this.factor + this.offsetW);
  }

  status(now) {
    const elapsedS = this.elapsedS(now);
    const segs = this.workout.segments;
    let index = segs.length - 1;
    for (let i = 0; i < segs.length; i++) {
      if (elapsedS < this.starts[i] + segs[i].durationS) {
        index = i;
        break;
      }
    }
    if (this.state !== 'fertig' && elapsedS >= this.totalS) this.state = 'fertig';
    const segment = segs[index];
    const segElapsedS = elapsedS - this.starts[index];
    const next = segs[index + 1] || null;
    return {
      state: this.state,
      elapsedS,
      totalS: this.totalS,
      index,
      segment,
      segElapsedS,
      segRemainingS: Math.max(0, segment.durationS - segElapsedS),
      targetW: this.targetW(segment, segElapsedS),
      next,
      nextTargetW: next ? this.targetW(next, 0) : null,
      progress: this.totalS ? elapsedS / this.totalS : 0,
    };
  }
}
