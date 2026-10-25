# Trainer-App

Eigene Trainings-Web-App für den Van Rysel D100 (Bluetooth FTMS), einen Bluetooth-Brustgurt und einen Bluetooth-Kadenzsensor. Läuft in Google Chrome oder Microsoft Edge am Laptop, ohne Installation.

## Stand

**Phase 1: Verbindungstest.** Die Seite verbindet Trainer, Brustgurt und Kadenzsensor und zeigt Watt, Herzfrequenz und Kadenz an. Den Trainer steuert sie noch nicht. ERG, Workouts, Aufzeichnung, Zonen, Export und Verlauf folgen in den nächsten Phasen.

## Test am Trainer

1. MyWhoosh, Zwift und OnelapFit auf allen Geräten schließen, am Handy Bluetooth kurz ausschalten.
2. Die App-Seite in Chrome am Laptop öffnen.
3. Nacheinander „Trainer verbinden“, „Brustgurt verbinden“ und „Kadenzsensor verbinden“ klicken und jeweils das Gerät im Auswahlfenster wählen.
4. Zwei bis drei Minuten locker treten.
5. „Protokoll speichern“ klicken und die Datei an Claude schicken.

Taucht ein Gerät im Auswahlfenster nicht auf, den Haken bei „Alle Bluetooth-Geräte in der Auswahl zeigen“ setzen und erneut versuchen.

## Entwicklung

Reines HTML, CSS und JavaScript ohne Build-Schritt. Tests für die Auswertung der Bluetooth-Daten:

```
npm test
```

Lokal starten: `python3 -m http.server` im Ordner und `http://localhost:8000` in Chrome öffnen (Web Bluetooth funktioniert auf `localhost` auch ohne HTTPS).
