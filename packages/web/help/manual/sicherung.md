# Sicherung und Rückspielen

Die Instanz sichert jede Nacht die Datenbank und den Dateispeicher, ohne dass jemand daran denkt. Die Uhrzeit stellst du im Bereich der Instanz unter „Einstellungen“ ein. War der Server zur Uhrzeit aus, holt sie die Sicherung nach.

## Von Hand

Die Befehle laufen im Ordner der Installation, etwa `/opt/opengewerk`.

- Sichern: `docker compose -f docker/compose.yaml --profile backup run --rm backup backup.sh`
- Prüfen, ob die letzte Sicherung vollständig ist: `docker compose -f docker/compose.yaml --profile backup run --rm backup verify.sh latest`
- Zurückspielen: zuerst die Anwendung anhalten, `docker compose -f docker/compose.yaml stop app`, dann `docker compose -f docker/compose.yaml --profile backup run --rm backup restore.sh latest`, und erst wenn das ohne Fehler durchlief, die Anwendung wieder starten, `docker compose -f docker/compose.yaml start app`. Bricht `restore.sh` ab, bleibt die Anwendung angehalten: Datenbank und Dateispeicher können dann schon zum Teil ersetzt sein. Behebe die Ursache und spiel die Sicherung noch einmal zurück.

Nach dem Zurückspielen gilt der Stand der Sicherung. Was danach eingetragen wurde, ist weg; solange die Anwendung angehalten ist, kann auch niemand etwas eintragen, das dabei verloren geht.

Liegt eine Sicherung nur auf derselben Platte wie die Instanz, hilft sie nicht, wenn die Platte ausfällt. Kopiere sie regelmäßig an einen zweiten Ort.
