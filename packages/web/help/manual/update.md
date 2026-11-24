# Update

Unter **Aktualisierung** im Bereich der Instanz steht, welche Fassung läuft und ob es eine neuere gibt. Die Instanz sieht dafür einmal am Tag auf GitHub nach. Aktualisiert wird nur, wenn du den Knopf drückst und mit Passwort und Code bestätigst. Dann sichert die Instanz zuerst Datenbank und Dateispeicher, lädt die neue Fassung, prüft ihre Signatur, holt die Abbilder, migriert und startet neu. Für etwa eine Minute ist sie dabei nicht erreichbar. Wie es ausging, steht danach auf der Seite, im Protokoll der Instanz und im Änderungsprotokoll jedes Betriebs, und alle Betreiber bekommen eine E-Mail.

Das geht auf einem Linux-Server mit einem Paket aus einem Release. Der Dienst, der das erledigt, kommt mit der Fassung, die das Update aus dem Bereich der Instanz einführt: Auf diese Fassung aktualisierst du einmal von Hand, so wie unten beschrieben, danach geht es über den Knopf. Unter Docker Desktop auf Windows oder macOS und in einem Checkout des Quelltexts aktualisierst du von Hand, so wie unten beschrieben, in derselben Shell, in der du die Instanz eingerichtet hast (unter Windows also in Git Bash).

## Von Hand

**In einem Checkout des Quelltexts** arbeitest du im Ordner des Checkouts. Dort sicherst du zuerst mit `docker compose -f docker/compose.yaml --profile backup run --rm backup backup.sh`. Dann holst du die neue Fassung mit `git pull`, oder, wenn der Checkout auf einem Tag steht, mit `git fetch --tags` und `git checkout` auf den Tag der neuen Fassung, etwa `git checkout v0.3.1`, und startest dort mit `sh docker/start.sh`; er baut die Abbilder dann selbst.

**Unter Docker Desktop auf Windows** arbeitest du in Git Bash mit deinem eigenen Benutzer, `sudo` brauchst du dort nicht, und Docker Desktop muss laufen. Die Schritte sind dieselben wie unten, nur im Ordner, in den du das Paket beim ersten Mal entpackt hast, etwa `C:\opengewerk`, in Git Bash `/c/opengewerk`: dort sichern, das neue Paket in den Ordner darüber entpacken (`tar -xzf opengewerk-X.Y.Z.tar.gz -C /c`) und dort `sh docker/start.sh`. Unter macOS genauso im Terminal, mit dem Ordner über deiner Installation als Ziel, etwa `tar -xzf opengewerk-X.Y.Z.tar.gz -C ~` für eine Installation in `~/opengewerk`.

**Auf einem Linux-Server** gilt, was folgt.

Vorher sichern, das neue Paket an dieselbe Stelle entpacken und derselbe Befehl wie beim ersten Start. Die Datei `.env` bleibt, wie sie ist. Die Befehle gehen von einer Installation in `/opt/opengewerk` aus und laufen als root; als anderer Benutzer wirst du vorher mit `sudo -i` zu root.

1. Im Ordner der Installation sichern: `cd /opt/opengewerk && docker compose -f docker/compose.yaml --profile backup run --rm backup backup.sh`
2. Das Paket der neuen Fassung laden und gegen seine Signatur prüfen.
3. In den Ordner über der Installation entpacken, also nach `/opt`: `tar --no-same-owner -xzf opengewerk-X.Y.Z.tar.gz -C /opt`. Das Paket legt den Inhalt in den Ordner `opengewerk` und überschreibt dort die Dateien der alten Fassung.
4. Starten: `cd /opt/opengewerk && sh docker/start.sh`. Er holt die Abbilder der neuen Fassung, führt die Migrationen aus und startet danach.

Das Paket entpackt immer in einen Ordner `opengewerk`. Heißt deiner anders, entpackst du es an einen anderen Ort und kopierst den Inhalt des Ordners `opengewerk` über deinen; die `.env` ist nicht im Paket und bleibt, wie sie ist.

Lies vorher die Versionshinweise. Steht dort, dass die Geräte vor dem Update senden sollen, was bei ihnen wartet, dann zuerst das.
