# Installation

Was ein Server braucht, das Paket prüfen und entpacken, der erste Start und der Einrichtungscode.

## Schritt für Schritt

1. Auf dem Server Docker und Docker Compose ab 2.22 einrichten.
2. Das Paket `opengewerk-X.Y.Z.tar.gz` von der Release-Seite laden, X.Y.Z ist die Fassung, und mit `cosign verify-blob` gegen seine Signatur prüfen. Die Befehle dazu stehen auf der Release-Seite.
3. Entpacken, etwa nach `/opt`: `tar --no-same-owner -xzf opengewerk-X.Y.Z.tar.gz -C /opt`. Das Paket bringt den Ordner `opengewerk` mit.
4. Im Ordner der Installation starten: `cd /opt/opengewerk && sh docker/start.sh`. Beim ersten Start fragt er nach der Adresse, unter der OpenGewerk im Browser geöffnet wird, und erzeugt alle Passwörter und Schlüssel in `docker/.env`.
5. Im Browser die Adresse öffnen und die Instanz einrichten: Einrichtungscode, Name des Betriebs, Name und E-Mail der Person, die ihn führt, und ein Passwort.

Den Einrichtungscode liest du auf dem Server in `docker/.env` unter `SETUP_CODE`. Richte die Instanz gleich nach dem ersten Start ein: Bis dahin hält nur dieser Code fremde Leute auf.
