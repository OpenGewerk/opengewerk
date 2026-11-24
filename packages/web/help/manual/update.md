# Update

Unter **Aktualisierung** im Bereich der Instanz steht, welche Fassung läuft und ob es eine neuere gibt. Die Instanz sieht dafür einmal am Tag auf GitHub nach. Aktualisiert wird nur, wenn du den Knopf drückst und mit Passwort und Code bestätigst. Dann sichert die Instanz zuerst Datenbank und Dateispeicher, lädt die neue Fassung, prüft ihre Signatur, holt die Abbilder, migriert und startet neu. Für etwa eine Minute ist sie dabei nicht erreichbar. Wie es ausging, steht danach auf der Seite, und alle Betreiber bekommen eine E-Mail.

Das geht auf einem Linux-Server mit einem Paket aus einem Release. Unter Docker Desktop auf Windows oder macOS und in einem Checkout des Quelltexts aktualisierst du von Hand, so wie unten beschrieben.

## Von Hand

In einem Checkout des Quelltexts holst du die neue Fassung mit `git pull` und startest mit `sh docker/start.sh`; er baut die Abbilder dann selbst. Die Schritte unten gelten für eine Installation aus einem Paket.

Vorher sichern, das neue Paket an dieselbe Stelle entpacken und derselbe Befehl wie beim ersten Start. Die Datei `.env` bleibt, wie sie ist. Die Befehle gehen von einer Installation in `/opt/opengewerk` aus und laufen als root; als anderer Benutzer wirst du vorher mit `sudo -i` zu root.

1. Im Ordner der Installation sichern: `cd /opt/opengewerk && docker compose -f docker/compose.yaml --profile backup run --rm backup backup.sh`
2. Das Paket der neuen Fassung laden und gegen seine Signatur prüfen.
3. In den Ordner über der Installation entpacken, also nach `/opt`: `tar --no-same-owner -xzf opengewerk-X.Y.Z.tar.gz -C /opt`. Das Paket legt den Inhalt in den Ordner `opengewerk` und überschreibt dort die Dateien der alten Fassung.
4. Starten: `cd /opt/opengewerk && sh docker/start.sh`. Er holt die Abbilder der neuen Fassung, führt die Migrationen aus und startet danach.

Lies vorher die Versionshinweise. Steht dort, dass die Geräte vor dem Update senden sollen, was bei ihnen wartet, dann zuerst das.
