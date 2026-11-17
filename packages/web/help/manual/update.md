# Update

Vorher sichern, das neue Paket an dieselbe Stelle entpacken und derselbe Befehl wie beim ersten Start. Die Datei `.env` bleibt, wie sie ist.

## Schritt für Schritt

1. Sichern: `docker compose -f docker/compose.yaml --profile backup run --rm backup backup.sh`
2. Das Paket der neuen Fassung laden und gegen seine Signatur prüfen.
3. An dieselbe Stelle entpacken: `tar --no-same-owner -xzf opengewerk-X.Y.Z.tar.gz`
4. Starten: `sh docker/start.sh`. Er holt die Abbilder der neuen Fassung, führt die Migrationen aus und startet danach.

Lies vorher die Versionshinweise. Steht dort, dass die Geräte vor dem Update senden sollen, was bei ihnen wartet, dann zuerst das.
