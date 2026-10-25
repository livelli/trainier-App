// Leistungszonen in Prozent der FTP (7 Zonen nach Coggan, wie in Zwift und MyWhoosh üblich).
export const POWER_ZONES = [
  { zone: 1, name: 'Erholung', upTo: 0.55, color: '#7c8794' },
  { zone: 2, name: 'Grundlage', upTo: 0.75, color: '#3b82f6' },
  { zone: 3, name: 'Tempo', upTo: 0.90, color: '#22c55e' },
  { zone: 4, name: 'Schwelle', upTo: 1.05, color: '#eab308' },
  { zone: 5, name: 'VO2max', upTo: 1.20, color: '#f97316' },
  { zone: 6, name: 'Anaerob', upTo: 1.50, color: '#ef4444' },
  { zone: 7, name: 'Sprint', upTo: Infinity, color: '#a855f7' },
];

// Die Grenze gehört zur unteren Zone (z. B. genau 55 % ist noch Zone 1).
export function powerZone(watts, ftp) {
  const pct = watts / ftp;
  return POWER_ZONES.find((z) => pct <= z.upTo + 1e-9);
}
