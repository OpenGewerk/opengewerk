# Sicherung und Rückspielen

Die Instanz sichert jede Nacht die Datenbank und den Dateispeicher, ohne dass jemand daran denkt. Die Uhrzeit stellst du im Bereich der Instanz unter „Einstellungen“ ein. War der Server zur Uhrzeit aus, holt sie die Sicherung nach.

## Von Hand

Die Befehle laufen als root im Ordner der Installation, etwa `/opt/opengewerk`; als anderer Benutzer wirst du vorher mit `sudo -i` zu root.

- Sichern: `docker compose -f docker/compose.yaml --profile backup run --rm backup backup.sh`
- Prüfen, ob das Protokoll der laufenden Instanz noch zu dem passt, was die letzte Sicherung gesehen hat, ob es also niemand nachträglich umgeschrieben hat: `docker compose -f docker/compose.yaml --profile backup run --rm backup verify.sh latest`. Dabei wird nichts zurückgespielt; ob sich eine Sicherung zurückspielen lässt, zeigt nur ein Zurückspielen.
- Zurückspielen: zuerst die Anwendung und die nächtliche Sicherung anhalten, `docker compose -f docker/compose.yaml stop app backup-schedule`, dann `docker compose -f docker/compose.yaml --profile backup run --rm backup restore.sh latest`, und erst wenn beides ohne Fehler durchlief, mit `sh docker/start.sh` starten. Verbinde die drei Befehle mit `&&`, dann läuft keiner, wenn der davor scheitert. Bricht `restore.sh` ab, bleibt die Anwendung angehalten: Datenbank und Dateispeicher können dann schon zum Teil ersetzt sein. Behebe die Ursache und spiel die Sicherung noch einmal zurück.
- Eine verschlüsselte Sicherung braucht den privaten Schlüssel. Du reichst ihn nur für diesen Lauf hinein, mit `-v /root/age-schluessel.txt:/run/age-schluessel:ro -e BACKUP_AGE_IDENTITY=/run/age-schluessel` hinter `run --rm`.
- Eine Sicherung geht in dieselbe Fassung zurück, von der sie stammt; in eine neuere Instanz lässt sie sich derzeit nicht zurückspielen. Eine Sicherung von vor einem Update geht nach dem Update also nicht mehr zurück.
- Auf einer neuen Maschine entpackst du zuerst das Paket der Fassung, von der die Sicherung stammt, und aktualisierst erst nach dem Zurückspielen. Dann legst du die `docker/.env` der alten Instanz an ihren Platz, vor jedem Start, sonst lassen sich zweite Faktoren und gespeicherte Passwörter nicht mehr öffnen. Dann sorgst du dafür, dass das Archiv dort liegt, wohin `BACKUP_TARGET` in dieser `.env` zeigt: Ein Ziel auf einer anderen Maschine hängst du ein, und Kopien, die du von Hand gemacht hast, legst du in ein Verzeichnis und trägst dessen absoluten Pfad als `BACKUP_TARGET` ein. Dann startest du die Instanz einmal mit `sh docker/start.sh`, damit der Dateispeicher der Anwendung gehört. Das Archiv nennst du dann mit seinem Namen und `--skip-origin-check` statt `latest`, denn das Verzeichnis der eigenen Sicherungen lag auf der alten Maschine.

Nach dem Zurückspielen gilt der Stand der Sicherung. Was danach eingetragen wurde, ist weg; solange die Anwendung angehalten ist, kann auch niemand etwas eintragen, das dabei verloren geht.

Liegt eine Sicherung nur auf derselben Platte wie die Instanz, hilft sie nicht, wenn die Platte ausfällt. Besser zeigt `BACKUP_TARGET` gleich auf eine andere Maschine, etwa ein eingehängtes NAS; sonst kopiere die Sicherungen regelmäßig an einen zweiten Ort. Die Datei `docker/.env` gehört einmal an einen sicheren Ort dazu: Ohne sie lässt sich eine Instanz auf einer neuen Maschine nicht vollständig zurückholen.
