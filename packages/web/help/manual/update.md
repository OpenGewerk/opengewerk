# Update

Vorher sichern, das neue Paket an dieselbe Stelle entpacken und derselbe Befehl wie beim ersten Start. Die Datei `.env` bleibt, wie sie ist. Die Befehle gehen von einer Installation in `/opt/opengewerk` aus.

## Schritt für Schritt

1. Im Ordner der Installation sichern: `cd /opt/opengewerk && docker compose -f docker/compose.yaml --profile backup run --rm backup backup.sh`
2. Das Paket der neuen Fassung laden und gegen seine Signatur prüfen.
3. In den Ordner über der Installation entpacken, also nach `/opt`: `tar --no-same-owner -xzf opengewerk-X.Y.Z.tar.gz -C /opt`. Das Paket legt den Inhalt in den Ordner `opengewerk` und überschreibt dort die Dateien der alten Fassung.
4. Starten: `cd /opt/opengewerk && sh docker/start.sh`. Er holt die Abbilder der neuen Fassung, führt die Migrationen aus und startet danach.

Lies vorher die Versionshinweise. Steht dort, dass die Geräte vor dem Update senden sollen, was bei ihnen wartet, dann zuerst das.
