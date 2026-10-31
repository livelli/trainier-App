// Virtuelle Geschwindigkeit aus Leistung, Gewicht und Steigung (wie Zwift oder Rouvy).
// Der Trainer meldet zwar eine Geschwindigkeit, die kennt aber weder Gewicht noch Steigung.

export const DEFAULT_RIDER_KG = 75;
export const DEFAULT_BIKE_KG = 9;

const G = 9.81;
const RHO = 1.225; // Luftdichte kg/m³
const CDA = 0.32; // Luftwiderstandsfläche, Rennrad mit Händen oben
const CRR = 0.005; // Rollwiderstand auf Asphalt
const MAX_V = 25; // 90 km/h, mehr ist auch bergab unrealistisch

/** Summe aus Roll-, Steigungs- und Luftwiderstand in Newton. */
export function resistance(v, grade, massKg) {
  const th = Math.atan(grade);
  return massKg * G * (CRR * Math.cos(th) + Math.sin(th)) + 0.5 * RHO * CDA * v * v;
}

/** Geschwindigkeit (m/s), bei der die Leistung genau den Widerstand ausgleicht. */
export function steadySpeed(powerW, grade, massKg) {
  let lo = 0;
  let hi = MAX_V;
  for (let i = 0; i < 60; i++) {
    const v = (lo + hi) / 2;
    if (resistance(v, grade, massKg) * v < powerW) lo = v;
    else hi = v;
  }
  return lo;
}

/**
 * Einen Zeitschritt weiterrechnen, mit Schwung: Nach einem Intervall wird man nicht
 * sofort langsam, bergab rollt man auch mit wenig Leistung schneller.
 */
export function stepSpeed(v, powerW, grade, massKg, dt) {
  const p = Math.max(0, powerW || 0);
  let t = Math.max(0, Math.min(dt, 5));
  while (t > 1e-9) {
    const h = Math.min(0.05, t);
    // Bei kleiner Geschwindigkeit wäre Leistung/Geschwindigkeit unendlich: unten begrenzen.
    const drive = p / Math.max(v, 1);
    const a = (drive - resistance(v, grade, massKg)) / (massKg * 1.04); // +4 % für drehende Laufräder
    v = Math.min(MAX_V, Math.max(0, v + a * h));
    t -= h;
  }
  // Nur in der Ebene oder bergauf stehen bleiben; bergab rollt man auch ohne Treten los.
  if (p === 0 && v < 0.3 && resistance(0, grade, massKg) >= 0) v = 0;
  return v;
}

/** In der Pause rollt man aus und bremst sanft, nach etwa 6 bis 8 Sekunden steht man. */
export function coastDown(v, dt) {
  const next = v * Math.exp(-0.5 * Math.max(0, dt));
  return next < 0.5 ? 0 : next;
}
