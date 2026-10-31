// Fahrwelt: rechnet die virtuelle Fahrt und zeichnet sie.
// Die Welt steuert nichts. ERG, Töne und Aufzeichnung laufen unabhängig weiter,
// auch wenn die Grafik ruckelt oder der Tab im Hintergrund ist.

import { stepSpeed, coastDown } from './physics.js';
import { at } from './route.js';
import { drawWorld, drawMiniMap, drawElevation } from './render.js';

const fmtKm = (m) => `${(m / 1000).toFixed(1).replace('.', ',')} km`;
const fmtPct = (g) => `${g >= 0 ? '' : '−'}${Math.abs(g * 100).toFixed(1).replace('.', ',')} %`;

export class World {
  constructor({ canvas, mapCanvas, elevCanvas, els = {} }) {
    this.canvas = canvas;
    this.mapCanvas = mapCanvas;
    this.elevCanvas = elevCanvas;
    this.els = els;
    this.route = null;
    this.visible = false;
    this.raf = 0;
    this.reset();
  }

  reset() {
    this.dist = 0;
    this.v = 0;
    this.lastTick = 0;
    this.stamp = 0;
  }

  /** Neue Fahrt auf einer Strecke beginnen. Die Physik läuft, gezeichnet wird erst mit show(). */
  start(route, { massKg, quality }) {
    this.route = route;
    this.massKg = massKg;
    this.quality = quality;
    this.reset();
  }

  /** Zeichnen an- und abschalten, ohne die Fahrt auf der Strecke zurückzusetzen. */
  show() {
    if (!this.route) return;
    this.visible = true;
    this.lastSide = 0;
    if (!this.raf) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  hide() {
    this.visible = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  stop() {
    this.hide();
    this.route = null;
  }

  get active() {
    return Boolean(this.route);
  }

  get speedKmh() {
    return this.v * 3.6;
  }

  get grade() {
    return this.route ? at(this.route, 'grade', this.dist) : 0;
  }

  /**
   * Physik einen Schritt weiter. Wird mehrmals pro Sekunde aufgerufen (Takt und Trainer-Daten).
   * moving = Fahrt läuft (nicht Pause, nicht fertig).
   */
  tick(now, powerW, moving) {
    if (!this.route) return;
    const dt = this.lastTick ? Math.min(2, (now - this.lastTick) / 1000) : 0;
    this.lastTick = now;
    if (dt <= 0) return;
    if (moving) this.v = stepSpeed(this.v, powerW, this.grade, this.massKg, dt);
    else this.v = coastDown(this.v, dt);
    this.dist += this.v * dt;
    this.stamp = now;
  }

  /** Zwischen zwei Physik-Schritten weiterrollen, damit das Bild flüssig bleibt. */
  viewDist() {
    if (!this.stamp) return this.dist;
    const ahead = Math.min(0.6, Math.max(0, (Date.now() - this.stamp) / 1000));
    return this.dist + this.v * ahead;
  }

  frame(t) {
    this.raf = 0;
    if (!this.route || !this.visible) return;
    const d = this.viewDist();
    try {
      drawWorld(this.canvas, this.route, d, this.quality);
      // Karte, Profil und Zahlen ändern sich langsam: viermal pro Sekunde reicht.
      if (!this.lastSide || t - this.lastSide > 250) {
        this.lastSide = t;
        if (this.mapCanvas) drawMiniMap(this.mapCanvas, this.route, d);
        if (this.elevCanvas) drawElevation(this.elevCanvas, this.route, d);
        this.renderText(d);
      }
    } catch (err) {
      // Ein Zeichenfehler darf die Fahrt nie stören.
      console.error('Fahrwelt', err);
    }
    this.raf = requestAnimationFrame((tt) => this.frame(tt));
  }

  renderText(d) {
    const set = (key, text) => {
      const el = this.els[key];
      if (el && el.textContent !== text) el.textContent = text;
    };
    const r = this.route;
    const lapPos = ((d % r.length) + r.length) % r.length;
    const lap = Math.floor(d / r.length) + 1;
    set('speed', this.speedKmh.toFixed(1).replace('.', ','));
    set('grade', fmtPct(this.grade));
    set('dist', fmtKm(d));
    set('elev', `${Math.round(at(r, 'elev', d))} m`);
    set('route', `${r.name} · ${fmtKm(lapPos)} von ${fmtKm(r.length)}${lap > 1 ? ` · Runde ${lap}` : ''}`);
  }
}
