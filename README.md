# Trainer-App

Eigene Trainings-Web-App für den Van Rysel D100 (Bluetooth FTMS), einen Bluetooth-Brustgurt und einen Bluetooth-Kadenzsensor. Läuft in Google Chrome oder Microsoft Edge am Laptop, ohne Installation.

## Stand

**Phase 4: Workouts.** Die App verbindet Trainer, Brustgurt und Kadenzsensor, spielt Workouts im Cockpit-Design ab und stellt den Trainer dabei automatisch im ERG-Modus auf das jeweilige Ziel. Freie Fahrt mit fester Wattzahl geht auch. Fahrten werden noch nicht gespeichert; Aufzeichnung, Export und Verlauf folgen.

## Workouts

Workouts liegen als Zwift-Dateien (`.zwo`) im Ordner `workouts/` und stehen in `workouts/index.json`. Alle Werte sind Anteile der FTP (z. B. `Power="0.90"` = 90 % FTP), die FTP stellt man in der App ein. Unterstützt werden `Warmup`, `Cooldown`, `SteadyState`, `Ramp`, `IntervalsT` und `FreeRide`. Eigene `.zwo`-Dateien lassen sich in der App auch direkt öffnen.

## Fahren

1. MyWhoosh, Zwift und OnelapFit auf allen Geräten schließen.
2. Die App in Chrome am Laptop öffnen, Trainer und Brustgurt (und Kadenzsensor) verbinden.
3. Workout wählen, „Start“ drücken. Tastatur: Leertaste = Start/Pause/Weiter, Pfeil hoch/runter = ±10 W, Bild runter = −10 %, Esc zweimal = beenden.

## Entwicklung

Reines HTML, CSS und JavaScript ohne Build-Schritt. Tests für die Auswertung der Bluetooth-Daten:

```
npm test
```

Lokal starten: `python3 -m http.server` im Ordner und `http://localhost:8000` in Chrome öffnen (Web Bluetooth funktioniert auf `localhost` auch ohne HTTPS).
