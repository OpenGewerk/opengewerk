# Sicherung und Rückspielen

Die Instanz sichert jede Nacht die Datenbank und den Dateispeicher, ohne dass jemand daran denkt. Die Uhrzeit stellst du im Bereich der Instanz unter „Einstellungen“ ein. War der Server zur Uhrzeit aus, holt sie die Sicherung nach.

## Von Hand

- Sichern: `docker compose -f docker/compose.yaml --profile backup run --rm backup backup.sh`
- Prüfen, ob die letzte Sicherung vollständig ist: `docker compose -f docker/compose.yaml --profile backup run --rm backup verify.sh latest`
- Zurückspielen: `docker compose -f docker/compose.yaml --profile backup run --rm backup restore.sh latest`

Liegt eine Sicherung nur auf derselben Platte wie die Instanz, hilft sie nicht, wenn die Platte ausfällt. Kopiere sie regelmäßig an einen zweiten Ort.
