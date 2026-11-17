# Installation

Was ein Server braucht, das Paket prüfen und entpacken, der erste Start und der Einrichtungscode.

## Schritt für Schritt

Die Befehle laufen als root auf dem Server, für `/opt` und die Datei `docker/.env`. Bist du als anderer Benutzer angemeldet, wirst du vorher mit `sudo -i` zu root.

1. Auf dem Server Docker Engine ab 28.3.3 und Docker Compose ab 2.22 einrichten. Ältere Fassungen lassen Rechner im selben Netz an Ports, die nur auf `127.0.0.1` liegen.
2. Das Paket `opengewerk-X.Y.Z.tar.gz` von der Release-Seite laden, X.Y.Z ist die Fassung, und mit `cosign verify-blob` gegen seine Signatur prüfen. Die Befehle dazu stehen auf der Release-Seite.
3. Entpacken, etwa nach `/opt`: `tar --no-same-owner -xzf opengewerk-X.Y.Z.tar.gz -C /opt`. Das Paket bringt den Ordner `opengewerk` mit.
4. Im Ordner der Installation starten: `cd /opt/opengewerk && sh docker/start.sh`. Beim ersten Start fragt er nach der Adresse, unter der OpenGewerk im Browser geöffnet wird, etwa `https://opengewerk.example.org`, und erzeugt alle Passwörter und Schlüssel in `docker/.env`.
5. Einen Reverse Proxy mit TLS davorsetzen. OpenGewerk lauscht nur auf `127.0.0.1:23700`, von außen kommt man also nur über den Proxy herein. Vorlagen für Apache und nginx liegen im Paket unter `docker/proxy/`, mit der Weiterleitung von HTTP auf HTTPS.
6. Im Browser die Adresse mit `https://` öffnen und die Instanz einrichten: Einrichtungscode, Name des Betriebs, Name und E-Mail der Person, die ihn führt, und ein Passwort.

Den Einrichtungscode liest du auf dem Server in `docker/.env` unter `SETUP_CODE`. Richte die Instanz gleich nach dem ersten Start ein, und nur über HTTPS: Bis dahin hält nur dieser Code fremde Leute auf, und über HTTP gingen er und dein Passwort lesbar durchs Netz.
