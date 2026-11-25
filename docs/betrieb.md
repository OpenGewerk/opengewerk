# Betrieb

Wie eine Instanz aufgesetzt, eingerichtet, gesichert, zurückgespielt und aktualisiert wird, und was davor gehört. Den kürzesten Weg zur laufenden Instanz zeigt die [README](../README.md#schnellstart).

Betriebsfähigkeit gehört zum Produkt, nicht in eine Anleitung. Auf einer
Maschine mit Docker reicht ein Befehl, beim ersten Start wie bei jedem weiteren
(unter Windows in Git Bash):

```bash
sh docker/start.sh
```

**Aus einem Release oder aus dem Quelltext** (#155). Ein Release bringt ein
Paket `opengewerk-<fassung>.tar.gz` mit dem Ordner `opengewerk/docker` und
veröffentlichte, signierte Abbilder für x86_64 und ARM64; die Pakete stehen
unter [Releases](https://github.com/OpenGewerk/opengewerk/releases). Entpackt und mit
demselben Befehl gestartet, baut eine solche Installation nichts, sondern holt
die Abbilder ihrer Fassung aus `ghcr.io/opengewerk`. Die Fassung steht in
`docker/compose.yaml` an jedem Abbild, und so nimmt jeder `docker
compose`-Befehl weiter unten dieselbe. Gebraucht werden Docker Engine ab 28.3.3
und Docker Compose ab 2.22. Ein Checkout des Repositorys hat an derselben Stelle `source`
und baut die Abbilder aus dem Quelltext, für Entwicklung und Vorschau. Wer im
Checkout lieber eine veröffentlichte Fassung betreibt, trägt sie in der `.env`
als `OPENGEWERK_VERSION` ein.

**Ein Paket nennt seine Abbilder mit Digest und prüft ihre Signatur** (#687). In
`docker/compose.yaml` eines Pakets steht jedes Abbild von OpenGewerk als
`<abbild>:<fassung>@sha256:...`, genau die Bytes, die der Release gebaut und
signiert hat. Bevor `start.sh` sie holt, prüft es mit `cosign` ihre Signatur
gegen den Workflow "Release" dieser Fassung; schlägt das fehl, wird nichts geholt
und nichts gestartet. Ohne `cosign` auf der Maschine sagt der Start, wie man von
Hand prüft, und läuft weiter. Ein solches Paket startet immer seine eigene
Fassung: `OPENGEWERK_VERSION` in der `.env` gilt nur für einen Checkout.

**Das Paket selbst ist ebenso signiert.** Es legt fest, welche Abbilder der
Start prüft und gegen welchen Workflow, also gehört es vor dem Entpacken
geprüft: neben `opengewerk-<fassung>.tar.gz` liegt auf der Release-Seite
`opengewerk-<fassung>.tar.gz.sigstore.json`, und `cosign verify-blob` mit dem
Befehl aus den Hinweisen jedes Releases bestätigt, dass das Paket aus dem
Workflow "Release" genau dieses Tags stammt. Die Prüfsumme daneben sagt nur,
dass beides zusammen hochgeladen wurde.

**Beim ersten Start füllt er die `.env` selbst aus.** Er legt `docker/.env` aus
der Vorlage an und erzeugt jedes Passwort und jeden Schlüssel darin, 32
Zufallsbytes als Hex, jeden für sich, dazu den Einrichtungscode für die erste
Einrichtung im Browser, acht Zeichen zum Abtippen (siehe "Der erste Zugang").
In der Konsole stehen nur die Namen, nie die Werte, und die Datei ist danach nur
für ihren Besitzer lesbar. Gefragt wird einzig nach der Adresse, unter der
OpenGewerk im Browser geöffnet wird; ohne Terminal kommt sie aus
`OPENGEWERK_ADDRESS`. Danach richtet er die Datenbank ein und startet die
Instanz. Jeder weitere Aufruf lässt Gesetztes stehen, ergänzt nur, was eine
neuere Vorlage mitbringt, und startet in der Reihenfolge, die ein Update
braucht. `sh docker/setup.sh` richtet nur die Datei ein, ohne zu starten.

**Die Skripte gehören dem Fundament** (ADR 0010, `opengewerk-haustechnik#14`).
Wie die Anwendung heißt und womit ihre eigenen Variablen beginnen, lesen
`setup.sh` und `start.sh` aus `docker/application.env`; Abbilder,
Compose-Projekt und Standardport stehen in `docker/compose.yaml`, die Adresse
der Vorlage in `docker/.env.example`. Eine weitere Anwendung der Organisation
startet dieselben Skripte gegen ihren eigenen Ordner, indem sie ihn in
`APPLICATION_DIRECTORY` nennt, und hält ihre Variablen über deren Anfang von
denen dieser Anwendung getrennt.

Ebenso prüfen die drei CI-Läufe auf einem ganzen Stapel, "Betrieb über Docker
Compose", "Sicherung und Rückspielen" und "Update einer laufenden Instanz",
mit den Schritten aus `docker/test-stack.sh`. Was nur diese Anwendung weiß,
etwa die Datensätze, die eine Sicherung zurückbringen muss, steht in
`docker/test-material.sh`. Ein Schritt läuft auch von Hand, mit
`sh docker/test-stack.sh <schritt>`, und zwar gegen den Stapel dieses Ordners:
`lose-data` löscht dessen Volumes, wie es der Lauf will.

Wer die `.env` lieber von Hand füllt, erzeugt jeden Schlüssel einzeln mit
`openssl rand -hex 32`; als `SETUP_CODE` taugt jeder Code ab acht Zeichen,
Leerzeichen und Bindestriche nicht gezählt. `VAPID_PRIVATE_KEY` ist kein
Zufallswert, sondern ein Schlüssel auf P-256; der Befehl dafür steht in
`docker/.env.example`. Eine Instanz, die noch einen
Platzhalter aus der Vorlage findet, startet nicht: sie nennt die Variable, nie
ihren Wert, und verweist auf das Skript.

Jede Zeile der `.env` hat die Form `NAME=Wert`, ohne `export` davor und ohne
Leerzeichen um das `=`. Ein Wert beginnt mit einem sichtbaren Zeichen aus
ASCII; einer, der mit einem Umlaut beginnt, steht in Anführungszeichen. Ein
Wert in Anführungszeichen endet auf seiner Zeile, hat keinen `\` darin und
dahinter höchstens einen Kommentar mit einem Leerzeichen davor. Jeder Name
steht nur einmal da, und gespeichert wird als UTF-8 ohne BOM. `TRUSTED_ORIGINS`
enthält nur die Adressen, durch Komma getrennt, ohne Anführungszeichen,
Leerzeichen, Kommentar oder `$`, und `OPENGEWERK_VERSION` nur die Fassung,
auf Wunsch in Anführungszeichen, ohne `$` und ohne Tabulator.
Docker Compose nimmt auch anderes an, liest
es aber anders als die Skripte, die dann eine andere Adresse nennen oder sehen
würden als die, mit der die Anwendung läuft. `sh docker/start.sh` hält deshalb
bei einer anderen Form an, nennt die Nummer der Zeile (bei einem Nullbyte nur
die Datei), nie ihren Wert, und lässt die Datei, wie sie ist (#996).

**Eingestellt wird in der Oberfläche, nicht in der `.env`.** Briefkopf, Steuern,
Mailserver und alles, was ein Betrieb sonst festlegt, stehen im Büro. In der
`.env` bleibt nur, was gebraucht wird, bevor die Oberfläche läuft: die
Passwörter der Datenbank, `SESSION_SECRET`, der Token des Renderers, der
Einrichtungscode, der Schlüssel für Push-Nachrichten, die Adresse der Instanz, Port, Fassung und mitstartende Dienste
für Docker Compose, der Schalter `CLOSED` und die Angaben der Sicherung, die
auch dann laufen muss, wenn die Anwendung es nicht tut.

Danach läuft eine migrierte Instanz auf `127.0.0.1:23700`, und
`curl http://127.0.0.1:23700/health` antwortet mit
`{"status":"bereit","database":true,"version":"0.6.5"}`, aus einem Checkout mit
`"version":null`. Dieselbe Fassung steht im Fuß der Anmeldung (#259). Im
Browser steht dort die Oberfläche: `/` für das Büro, `/m` für die Baustelle.

Die Protokolle der Container zeigt `docker compose -f docker/compose.yaml logs`.
Docker legt sie unter `/var/lib/docker/containers/` ab, mit dem Treiber `local`
rotiert und komprimiert, und jeder Container behält höchstens fünf Dateien zu
10 MB, also etwa 50 MB (#211). Die Grenze steht in `docker/compose.yaml`; an der
Docker-Konfiguration der Maschine muss dafür niemand etwas ändern.

## Der erste Zugang

Im Browser, und sonst nirgends nötig. Eine Instanz, auf der es weder einen
Betrieb noch ein Konto gibt, zeigt statt der Anmeldung die Einrichtung: den
Einrichtungscode, Name des Betriebs, Name und E-Mail der Person, die ihn führt,
und ein Passwort, das sie selbst wählt. Daraus entstehen in einem Zug der
Betrieb, das Konto und die Zugehörigkeit dazwischen, alle drei in einer
Transaktion.

**Die Einrichtung gleich nach dem ersten Start erledigen.** Bis dahin kann jeder,
der die Adresse erreicht, den Bildschirm öffnen, und was ihn aufhält, ist allein
der Einrichtungscode (#215). Der steht in `docker/.env` unter `SETUP_CODE`, zu
lesen also nur für jemanden, der an den Server kommt, und genau der soll
einrichten. `setup.sh` erzeugt ihn beim ersten Start mit den übrigen Schlüsseln,
acht Zeichen wie `K7Q4-9PXM` ohne die verwechselbaren 0, O, 1, I und L, und gibt
ihn wie jeden Wert nicht aus; `start.sh` sagt nach dem Start einer leeren Instanz
nur, wo er steht. Ablesen lässt er sich auf dem Server etwa mit
`grep SETUP_CODE docker/.env`. Klein- und Großschreibung, Leerzeichen und der
Bindestrich spielen beim Eintippen keine Rolle. Nach fünf falschen Codes nimmt
die Instanz von derselben Adresse eine Viertelstunde lang keinen mehr an, über
alle Adressen zusammen nach hundert; hinter einem Reverse Proxy gilt als Adresse
der letzte Eintrag in `X-Forwarded-For`, eine IPv6-Adresse zählt mit ihrem ganzen
/64. Fehlt `SETUP_CODE` in der `.env`,
startet die Instanz trotzdem, lehnt aber die Einrichtung ab, bis
`sh docker/start.sh` ihn eingetragen hat. Nach der Einrichtung öffnet der Code
nichts mehr.

Direkt danach kommt der zweite Faktor, denn das erste Konto ist ein `owner`, und
für diese Rolle ist er Pflicht (ADR 0006). Ein QR-Code für die
Authenticator-App, derselbe Schlüssel darunter zum Abtippen und zehn
Wiederherstellungscodes, die einmal zu sehen sind. Erst wenn ein Code aus der App
gestimmt hat, gilt der Faktor als eingerichtet: ein falsch abgetippter Schlüssel
sperrt sonst die einzige Person aus, die diese Instanz hat.

**Die Einrichtung verschwindet, sobald es einen Betrieb oder ein Konto gibt.**
Die Bedingung ist eine Abfrage an die Datenbank und kein Schalter, den jemand
zurückstellen kann, und sie wird unter einer Sperre gestellt: zwei Leute, die
den Bildschirm gleichzeitig öffnen, legen einen Betrieb an und nicht zwei. Ein
zweiter Versuch bekommt 409 und den Satz dazu. `CLOSED=true` schaltet sie mit
ab, dann gibt es die Route gar nicht. Der Einrichtungscode ist dazu eine zweite
Bedingung und kein Schalter: wer ihn zurücksetzt oder ändert, öffnet damit
keine eingerichtete Instanz.

## Jeder weitere Zugang

Im Büro, unter "Zugänge", und nur für den Inhaber: wer Rollen vergeben kann,
kann sich selbst die Rolle des Inhabers geben, deshalb liegt das nicht bei der
Bürokraft. Dort stehen die Konten des Betriebs mit Rollen, Zustand und der
letzten Anmeldung, daneben die offenen Einladungen.

**Ein Passwort vergibt das Büro nicht.** Wer angelegt wird, bekommt einen
Einmal-Link, und den gibt das Büro weiter, wie es die Person eben erreicht. Auf
der anderen Seite wählt sie ihr Passwort selbst; niemand im Betrieb bekommt es
je zu sehen. Ein Passwort, das ein Kollege kennt und das dann drei Jahre bleibt,
ist schlechter als eines, das niemand kennt.

Hat der Betrieb einen Mailserver, geht der Link auf Wunsch gleich per E-Mail an
die Person, und dann sieht ihn auch im Büro niemand. Unter den offenen
Einladungen steht, ob die E-Mail angekommen ist; wie das Token dabei entsteht,
steht unter "Benachrichtigung per E-Mail und Push".

Der Link gilt sieben Tage, funktioniert genau einmal und lässt sich zurückziehen.
Gespeichert wird von ihm nur eine Prüfsumme, er steht also genau in dem Moment
auf dem Bildschirm, in dem er entsteht, und danach nie wieder. Wer ihn verlegt,
erzeugt einen neuen; der alte wird dabei ungültig.

**Gesperrt statt gelöscht.** Ein gesperrter Zugang kommt nicht mehr hinein, und
zwar sofort: die laufenden Sitzungen dieses Betriebs werden beendet, nicht erst
beim Ablauf. In jeder Historie und im Audit-Log bleibt die Person sichtbar, denn
ein gelöschtes Konto nähme allem den Namen, was sie je geschrieben hat. Wer in
zwei Betrieben arbeitet, wird in beiden getrennt gesperrt: die Sperre hängt an
der Zugehörigkeit und nicht am Konto.

**Der letzte Inhaber lässt sich weder sperren noch entmachten.** Sonst schließt
sich ein Betrieb aus seiner eigenen Benutzerverwaltung aus, und der Weg zurück
führt über psql.

Wer Inhaber wird, braucht ab dem nächsten Aufruf einen zweiten Faktor. Der
Bildschirm sagt das, bevor das Häkchen gesetzt wird, und nicht der 403 danach.

Über die Kommandozeile geht es weiterhin, und dafür bleibt es auch: das ist der
Rückweg, wenn sich jemand ausgesperrt hat, und der einzige Weg auf einer
Maschine ohne Browser.

```bash
docker compose -f docker/compose.yaml exec app node dist/add-staff.js <betriebs-id> monteur@betrieb.de "Max Beispiel" technician
```

**Das Passwort fragt der Befehl verdeckt ab**, zweimal, wie `passwd`. Es
erscheint weder auf dem Bildschirm noch in der Prozessliste oder im Verlauf der
Shell. Hat es jemand anderes gewählt als die Person selbst, gehört es beim
ersten Anmelden ersetzt, unter "Konto" im Büro. Aus einem Skript heraus, ohne
Terminal, kommt es aus `OPENGEWERK_PASSWORD`, mit derselben Untergrenze von
zwölf Zeichen; ein Skript, das eine Instanz aufsetzt, erzeugt es also selbst,
etwa mit `openssl rand -hex 16`. Als Argument geht es nicht und soll es nicht:
ein Argument steht in der Prozessliste und im Verlauf der Shell, wo es
monatelang liegen bleibt.

Ein Passwort erzeugen und ausgeben tut der Befehl nicht. Ein ausgegebenes
Passwort steht im Verlauf des Terminals und gilt, bis jemand es ersetzt.

Gab es das Konto schon, fragt der Befehl nach keinem Passwort und rührt das
bisherige nicht an. Nur die Rollen im genannten Betrieb ändern sich.

**Ein Passwort ändern und zurückholen.** Unter "Konto" ändert jeder sein
Passwort mit dem bisherigen als Bestätigung; alle anderen Geräte des Zugangs
sind danach abgemeldet. Wer es vergessen hat, fordert auf der Anmeldung mit
"Passwort vergessen?" einen Link an. Er kommt über den Mailserver der Instanz
und über den Mailserver keines Betriebs, gilt eine Stunde und einmal, und danach
ist jedes Gerät abgemeldet. Die Antwort ist dieselbe, ob es zu der Adresse einen
Zugang gibt oder nicht. Ein eingerichteter zweiter Faktor gilt danach weiter. Hat
die Instanz keinen Mailserver, bleibt die Kommandozeile:

```bash
docker compose -f docker/compose.yaml exec app node dist/reset-password.js monteur@betrieb.de
```

Wie `add-staff` fragt der Befehl das neue Passwort verdeckt ab, und aus einem
Skript heraus kommt es aus `OPENGEWERK_PASSWORD`. Alle Geräte des Zugangs sind
danach abgemeldet.

Jedes neue Passwort, über den Link oder mit `reset-password`, steht im
Änderungsprotokoll jedes Betriebs, in dem der Zugang arbeitet, mit Zeitpunkt und
ohne den Link. Einen Tag lang lassen sich danach für diesen Zugang keine App und
kein Passkey einrichten; ein zweiter Faktor, den er schon hat, gilt weiter. So
bleibt Zeit zu bemerken, wenn jemand anderes das Passwort zurückgesetzt hat.

**Eine neue E-Mail-Adresse gilt erst mit ihrem Link.** Wer unter "Konto" eine
neue Adresse einträgt oder als Inhaber die Adresse eines Zugangs unter
"Zugänge" berichtigt, ändert sie nicht sofort: an die neue Adresse geht über
den Mailserver der Instanz ein Link, der einen Tag und einmal gilt, und erst er
macht sie zur Adresse des Kontos. Bis dahin meldet sich das Konto mit der
bisherigen an, und beide Bildschirme zeigen die wartende Adresse mit "Mail
erneut senden" und "Verwerfen". Danach steht die Änderung im
Änderungsprotokoll jedes Betriebs, in dem der Zugang arbeitet, als wer sie
angefordert hat, und die bisherige Adresse bekommt einen Hinweis. Ohne
Mailserver der Instanz ändert sich keine Adresse; der Name schon.

Ein Konto, das nur über seine Adresse gefunden wird, findet die Anwendung nur
über eine bestätigte: beim Benennen als Betreiber, bei `add-staff` und
`add-tenant` für ein Konto, das es schon gibt, und beim Einlösen einer
Einladung per Link. Bestätigt ist jede Adresse, die es beim Update auf diese
Fassung schon gab, und jede, die ein Link der Instanz bestätigt hat. Eine
Einladung, per Link oder per Mail, legt ein Konto mit einer Adresse an, die
noch nicht bestätigt ist: die Mail geht über den Mailserver des Betriebs, und
das zeigt nicht, wem das Postfach gehört. Unter "Konto" geht dafür mit
"Adresse bestätigen" ein Link an sie.

Einen zweiten Faktor kann jedes Konto auch später einrichten, auf dem Bildschirm
"Konto" im Büro. Für `owner` ist er Pflicht und die Anwendung fragt von selbst
danach, für alle anderen ist er eine Empfehlung.

Hat ein Konto einen zweiten Faktor, ändert es ihn nur aus einer Anmeldung mit
ihm: eine App einrichten, einen Passkey hinzufügen oder löschen und Name oder
E-Mail ändern geht nicht mit dem Passwort allein. Wer seinen einzigen zweiten
Faktor verloren hat, bekommt ihn vom Inhaber seines Betriebs unter "Zugänge"
zurückgesetzt. Arbeitet das Konto auch in einem anderen Betrieb der Instanz
oder betreibt es die Instanz, geht das nur auf dem Server:

```bash
docker compose -f docker/compose.yaml exec app node dist/reset-second-factor.js monteur@betrieb.de
```

Die App und alle Passkeys des Kontos sind danach entfernt und alle Geräte
abgemeldet, das Passwort bleibt. Bei der nächsten Anmeldung richtet der Zugang
einen neuen zweiten Faktor ein, wo eine Rolle ihn verlangt. Das Zurücksetzen
steht wie das Einrichten einer App im Änderungsprotokoll jedes Betriebs, in dem
der Zugang arbeitet.

`TRUSTED_ORIGINS` ist die Liste der Adressen, von denen aus ein Browser eine
Anfrage schicken darf, die etwas ändert, und damit der Schutz davor, dass ein
Formular auf einer fremden Seite hier etwas auslöst. Das gilt für die Anmeldung
und für jede Route der Anwendung; dazu nimmt jede davon nur JSON an, außer dem
Logo, das als Bild kommt. Nur Herkunft, also Schema, Host und notfalls Port: ein
Pfad oder ein Schrägstrich am Ende passt nie zu dem, was ein Browser sendet, und
die Sperre sähe konfiguriert aus, ohne etwas zu tun. Seit es eine Oberfläche
gibt, ist das die erste Zeile, die eine Installation anfassen muss: steht dort
nicht die Adresse, unter der die Anwendung erreichbar ist, scheitern im Browser
die Anmeldung und jede Änderung, während `curl` durchgeht. Wer die Oberfläche mit
Vite gegen einen eigenen Server entwickelt, trägt die Adresse von Vite dazu ein,
etwa `http://localhost:5173`; die Vorschau kennt sie von selbst.
Mit `http://` startet die Anwendung nur, wenn die Adresse auf dieser Maschine
liegt, also `localhost`, `127.0.0.1` oder `[::1]` (#984). Für jede andere
verlangt sie `https://`, sonst gingen Einrichtungscode und Passwörter lesbar
durchs Netz. Ebenso wenig nimmt sie einen Namen mit einem Punkt am Ende
(`https://betrieb.example.`), denn ein Browser schickt den Punkt nur mit, wenn
er auch in der Adresszeile steht, und keinen Port, den Browser sperren.
Steht in einer bestehenden Installation eine solche Adresse, erfasst ab dann
niemand mehr etwas, und jedes Gerät sendet unter der alten Adresse, was bei ihm
wartet, bis keines mehr "Änderungen warten auf dem Gerät" zeigt: Der Browser
hält den Postausgang je Adresse, unter der neuen sieht er ihn nicht mehr. Die
alte Adresse bleibt erreichbar, bis das geschafft ist. Danach kommt, wo nötig,
TLS an den Reverse Proxy, Vorlagen liegen unter `docker/proxy/`, dann die neue
Adresse in `TRUSTED_ORIGINS`, und erst danach wird wieder erfasst. Wer das vor
dem Update vergisst, dem bricht schon die Migration ab, vor der ersten Änderung,
und die Datenbank bleibt auf dem Stand davor; nach dem Ändern der Adresse läuft
`sh docker/start.sh` durch. Steht `TRUSTED_ORIGINS` auch in der Umgebung der Shell,
gilt dieser Wert vor der `.env` und ist dort ebenso zu ändern.

Der erste Eintrag aus `TRUSTED_ORIGINS` steht auch auf jedem QR-Etikett einer
Anlage (#308), gedruckt, für die zehn Jahre, die ein Aufkleber im Zählerschrank
hängt. Zieht die Instanz auf eine andere Adresse um, öffnet ein altes Etikett
seine Anlage in der App weiter, denn die liest nur den Code; die Kamera eines
Telefons öffnet dagegen die alte Adresse im Browser, und die braucht dann eine
Weiterleitung auf die neue, `/a/<code>` auf `/a/<code>`. Wer das nicht will,
sperrt die alten Etiketten im Büro und druckt neue.

`SESSION_SECRET` gehört in die Sicherung der Installation. Wird es getauscht,
sind alle abgemeldet und jeder schon eingerichtete zweite Faktor ist nicht mehr
lesbar.

`CLOSED=true` schaltet die Instanz zu: sie startet, migriert, beantwortet ihren
Health-Check und lehnt jede Anfrage an die Daten ab, die Anmeldung
eingeschlossen. Für ein Rückspielen oder ein Wartungsfenster, in dem die Instanz
erreichbar sein soll, ohne etwas herauszugeben.

**Hex und nicht base64 bei den Passwörtern**, und das ist kein Geschmack. Die
Passwörter stehen in Verbindungsadressen, und ein `/` oder `@` darin teilt die
Adresse an der falschen Stelle: aus `postgres://opengewerk_owner:ab/cd@postgres/...`
wird ein Zugriff auf einen Rechner namens `opengewerk_owner`. Die Fehlermeldung
lautet dann "getaddrinfo ENOTFOUND", und darauf kommt niemand von selbst.
`openssl rand -base64` liefert regelmäßig beide Zeichen. OpenGewerk erkennt
diesen Fall beim Start und sagt, woran es liegt.

## Der Bereich der Instanz und weitere Betriebe

Was keinem Betrieb gehört, sondern der Instanz, steht in einem eigenen Bereich
(#188): unter dem Namen oben rechts über "Instanz verwalten", unter `/instanz`.
Dort stehen die Betriebe der Instanz, der Mailserver der Instanz, die
Mailserver im eigenen Netz, die ein Betrieb benutzen darf, die Uhrzeit der
nächtlichen Sicherung, wer die Instanz betreibt, und ein Protokoll jeder
Änderung daran. Über den Mailserver der Instanz gehen die E-Mails an einen
Zugang, der Link zu einem neuen Passwort und der Hinweis auf einen neuen
Passkey: ein Zugang gehört der Instanz und keinem Betrieb, und wer einen Betrieb
führt, soll solche E-Mails nicht über einen eigenen Mailserver lesen können.
Ohne ihn geht keine davon hinaus. Aus einem Betrieb sieht der
Bereich nur seinen Namen, den Tag der Anlage, seine Inhaber, die Zahl der
Zugänge und wie viel er im Dateispeicher belegt, nichts, was in ihm steht. Wer einen Betrieb führt, liest die Liste
aus den Rollen des Betriebs: Inhaber ist dort, wer eine Rolle hält, die den
Betrieb führt, wie immer sie heißt.

Wer den Mailserver der Instanz einrichtet, bestimmt damit, über welchen Server
die Links zu neuen Passwörtern gehen. Deshalb lässt er sich nur nach der
Bestätigung mit Passwort und Code ändern oder entfernen, jede Änderung steht im
Änderungsprotokoll jedes Betriebs, aus dem der Betreiber sie nicht wieder
herausnehmen kann, und geht per E-Mail an die Inhaber aller Betriebe, über den
Mailserver von vorher und nicht über den neuen.
Jedes neue Passwort steht ebenso im Protokoll jedes Betriebs des Zugangs (siehe
"Ein Passwort ändern und zurückholen").

Wer einen weiteren Betreiber benennt, kann damit den Mailserver der Instanz in
andere Hände geben. Deshalb verlangen auch das Benennen und Entfernen eines
Betreibers und ein Betrieb mit Einladung für jemand anderen die Bestätigung mit
Passwort und Code, und jede Änderung an den Betreibern geht per E-Mail an alle
Betreiber und an den entfernten, über den Mailserver der Instanz. Das
gespeicherte Passwort eines Mailservers geht nur an den Server und den
Benutzernamen, für die es eingegeben wurde, und ohne Verschlüsselung nur über
genau die gespeicherte Verbindung; wer den Port wechselt und dabei auf "ohne
Verschlüsselung" stellt, gibt das Passwort neu ein.

Der Bereich selbst gehört zum Fundament (ADR 0010) und ist in jeder Anwendung
der Organisation derselbe. Was diese Anwendung dazu sagt, sind ihre Wörter:
"Betreiber" für den, der die Instanz betreibt, "Betrieb" und "Inhaber".

**Betreiber ist das Konto der Ersteinrichtung**, in derselben Transaktion wie
Betrieb und Konto. Auf einer Instanz, die schon vorher lief, findet Migration
0051 dieses Konto im Protokoll des ersten Betriebs. Weitere benennt ein
Betreiber unter "Betreiber", und von der Kommandozeile geht es auch, etwa auf
einer Instanz, deren Betreiber sich ausgesperrt haben:

```bash
docker compose -f docker/compose.yaml exec app node dist/appoint-operator.js inhaber@betrieb.de
```

Das Konto muss es schon geben. Für den Bereich ist ein zweiter Faktor Pflicht
wie für den Inhaber, und ein Inhaber erreicht ihn nicht, nur weil er Inhaber
ist. Sich selbst und den letzten Betreiber entfernt niemand.

**Einen weiteren Betrieb** (#142) legt ein Inhaber unter "Konto", "Betriebe"
für sich selbst an und ist dort sofort Inhaber, mit dem zweiten Faktor, den er
schon hat; das Recht heißt `tenant.create`. Für jemand anderen legt ihn ein
Betreiber im Bereich der Instanz an, mit einem Einladungslink, der die Person
zum Inhaber macht und wie jede Einladung einmal und sieben Tage gilt. Ohne
Browser geht es auf der Kommandozeile, und das Passwort eines neuen Kontos
fragt der Befehl verdeckt ab wie `add-staff`:

```bash
docker compose -f docker/compose.yaml exec app node dist/add-tenant.js "Elektro Weber OHG" anna@elektro-weber.de "Anna Weber"
```

Ein neuer Betrieb startet leer wie nach der Ersteinrichtung. Angelegt wird er
von der Funktion `create_tenant` in der Datenbank, denn die Anwendungsrolle
darf in `tenants` keine Zeile schreiben; für den Namen gilt dieselbe Regel wie
bei der Ersteinrichtung und unter "Briefkopf".

**Grenzen für einen Betrieb** stehen im Bereich der Instanz unter
"Einstellungen", Karte "Betriebe". "Speicher je Betrieb" begrenzt, was ein
Betrieb im Dateispeicher ablegt, alles zusammen, in GB; leer heißt ohne Grenze,
und so beginnt jede Instanz. Ein Betrieb an seiner Grenze bekommt beim
Hochladen eine Absage, alle anderen legen weiter ab. Wie viel jeder belegt,
steht in der Liste der Betriebe. Arbeiten mehrere Betriebe auf der Instanz,
hält eine Grenze einen davon ab, den Speicher für alle zu füllen; ohne sie
schützt nur die freie Reserve von 2 GB, die dann für alle zugleich gilt.
"Inhaber dürfen weitere Betriebe anlegen" ist an, bis der Betreiber den Haken
nimmt; ein Konto legt höchstens fünf eigene Betriebe an, gezählt aus dem
Protokoll der Instanz. Ohne den Haken legt einen weiteren Betrieb nur noch der
Betreiber an. Jeder Betrieb verlängert die Durchgänge der Hintergrundläufe und
den Start der Instanz, und gelöscht wird keiner.

**Gewechselt wird ohne neue Anmeldung** (#242), in der Kopfleiste, im Menü am
Telefon und unter "Konto", sobald eine Person mehr als einen Betrieb hat. Der
Wechsel schickt vorher hinaus, was im Postausgang des ersten Betriebs wartet,
beendet die Arbeit dort in dessen Protokoll und startet die Seite im anderen
Betrieb neu, mit dessen lokaler Ablage. Jede Anfrage einer Seite nennt im Kopf
`x-opengewerk-tenant` den Betrieb, in dem sie arbeitet, und der Server lehnt
sie ab, wenn die Sitzung inzwischen in einem anderen steht: ein zweiter Tab,
der nach einem Wechsel noch im alten Betrieb steht, schickt seinen Postausgang
so nicht in den neuen, sondern fragt neu und lädt den Betrieb der Sitzung.

**Das Protokoll der Instanz** steht in `instance_changes`, geschrieben vom
Trigger `record_instance_change` an `instance_operators`, `instance_settings`
und `tenants`, mit Person und Weg wie im Audit-Log eines Betriebs, aber ohne
Hashkette: es gehört keinem Betrieb, und eine Kette je Betrieb schützt dort
nichts. Ändern und Löschen sind wie beim Audit-Log gesperrt. Die Routen des
Bereichs liegen unter `/instance`, und ein Test hält fest, dass jede, die einen
Betreiber verlangt, dort liegt und nichts sonst verlangt.

## E-Mail

In der `.env` steht dafür höchstens eine Zeile, und meist bleibt sie leer. Jeder Betrieb richtet seinen Mailserver im Büro unter "E-Mail-Einstellungen" ein, mit seinem eigenen Postfach und seiner eigenen Anmeldung; wie das aussieht, steht oben unter "Benachrichtigung per E-Mail und Push". Wer die Instanz betreibt, muss dafür nur eines wissen: das Passwort eines Postfachs wird unter einem Schlüssel aus `SESSION_SECRET` versiegelt. Das ist ein Grund mehr, warum dieser Wert in die Sicherung gehört. Wird er getauscht, müssen alle Betriebe ihr Passwort unter "E-Mail-Einstellungen" neu eingeben, bis dahin warten ihre Nachrichten.

`STARTTLS` verlangt die Verschlüsselung, statt sie nur anzunehmen: ein Server, der auf Port 587 ohne antwortet, bekommt kein Passwort im Klartext. `TLS` ist Port 465, "Keine" ist für einen Relay auf derselben Maschine oder im selben Netz, der dafür im Bereich der Instanz freigegeben ist. Eine geschlossene Instanz (`CLOSED=true`) verschickt nichts.

**Ein Mailserver im eigenen Netz braucht die Freigabe des Betreibers.** OpenGewerk verbindet sich nur mit Mailservern im Internet, und nur auf den Ports für E-Mail: 25, 465, 587 und die Ausweichports 2465, 2525 und 2587. Ein Server unter einer internen Adresse, also diese Maschine, das eigene Netz oder ein Dienst der Instanz wie die Datenbank, wird abgelehnt, bei "Verbindung prüfen" wie beim Versand. Der Name wird dafür einmal aufgelöst, und die Verbindung geht genau an die geprüfte Adresse; das Zertifikat wird weiter gegen den Namen geprüft. Wer einen Mailserver im eigenen Netz betreibt, gibt ihn im Bereich der Instanz frei, unter "Einstellungen", "Mailserver im eigenen Netz", mit Namen oder Adresse, einen je Zeile, und für diese Server gilt dann jeder Port. Das steht dort und nicht im Büro eines Betriebs, denn es ist eine Grenze der Instanz: auf einer Instanz mit mehreren Betrieben öffnete sonst jeder Inhaber das Netz des Betreibers für sich. Stand er bisher in `MAIL_INTERNAL_HOSTS` in der `.env`, übernimmt der nächste Start ihn einmal dorthin, neben das, was dort schon steht; danach ändert ein Wert in der `.env` nichts mehr. Eine Prüfung sagt, welche Art Fehler es war, und nennt die drei Ziffern einer SMTP-Antwort, nie den Text, den das Gegenüber geschickt hat; und ein Betrieb kann die Verbindung höchstens dreißigmal in zehn Minuten prüfen.

## Vier Dienste, und was sie kosten

| Dienst | Abbild | Speicher im Leerlauf |
| --- | --- | --- |
| Anwendung | 291 MB | 81 MiB unter einem Limit von 1 GB, 195 MiB ohne Limit |
| PostgreSQL 18 | 433 MB | 33 MiB |
| Renderer (abschaltbar) | 3,9 GB | 342 MiB |
| Nächtliche Sicherung | 452 MB, davon 433 MB mit PostgreSQL geteilt | 1,8 MiB |

Gemessen am 19.09.2026 mit `docker stats --no-stream` auf einer leeren
Instanz. Die zwei Zahlen bei der Anwendung sind die wichtigste Angabe hier:
Node wählt seinen Heap nach dem verfügbaren Speicher, und auf einer Maschine
mit 30 GB nimmt es sich mehr, als es braucht. Bekommt der Container ein Limit,
schrumpft der Bedarf auf ein Drittel. Für das Ziel aus ADR 0002, zwei Gigabyte
für alles, ist damit reichlich Luft: Anwendung und Datenbank zusammen bleiben
unter 120 MiB, nachgemessen mit `mem_limit` von 1 GB und 768 MB.

Seit #688 hat die Anwendung in `docker/compose.yaml` eine solche Grenze,
Auslagerung eingeschlossen, und ihr Heap endet bei drei Vierteln davon
(`--max-old-space-size-percentage=75`). Läuft sie voll, beendet Docker die
Anwendung und startet sie neu; ohne Grenze beendet der Kernel einer Maschine,
der der Speicher ausgeht, irgendeinen Prozess, und das kann die Datenbank
sein. Von Haus aus sind es 10 GB, weil die größte Arbeit der Anwendung so viel
braucht: eine DATANORM-Lieferung an der Grenze von 400 MB für einen
Lieferanten, dessen Katalog schon in der Instanz liegt, gemessen am 20.10.2026
mit 7 GB. Auf einer kleineren Maschine gehört die Grenze unter ihren Speicher,
mit Platz für Datenbank und Renderer, etwa für eine mit 4 GB in `docker/.env`:

```bash
OPENGEWERK_MEMORY_LIMIT=2g
```

Eine DATANORM-Lieferung dieser Größe lässt sich dann nicht mehr einlesen,
kleinere schon. Der Heap folgt der Grenze von selbst.

Gelesen und verglichen wird eine Lieferung seit #297 in einem eigenen Thread,
damit die Anwendung währenddessen weiter antwortet. Er bekommt die Hälfte des
Heaps der Anwendung; reicht sie für eine Lieferung nicht, endet nur dieser
Thread, und die Vorschau sagt, dass der Speicher der Instanz nicht reicht.
Beim Hochladen liegen außerdem bis zu zwei Dateien eines Imports gleichzeitig
im Speicher, je bis zu 200 MB und beim Zusammensetzen noch einmal so viel,
zusammen also bis zu rund 800 MB.

Jeder Dienst gibt außerdem alle Rechte von root ab, die Docker sonst lässt,
und kann über ein setuid-Programm keine neuen gewinnen. Bis auf die Sicherung
läuft jeder mit einem Dateisystem, in das nichts schreibt, und die Datenbank
von Anfang an als ihr eigener Benutzer. Wo ein Dienst etwas davon behält,
steht der Grund an ihm in `docker/compose.yaml`, und die CI prüft, dass keiner
ohne diese Zeilen ist.

Der Renderer ist der Grund, warum er ein eigener Container ist. Er kostet
allein mehr Speicher als der Rest zusammen und fast vier Gigabyte auf der
Platte, und beim ersten Start lädt `start.sh` dieses Abbild mit, was je nach
Leitung ein paar Minuten dauert. **Trotzdem startet er von Haus aus mit**, denn
ohne ihn gibt es kein einziges PDF: kein Angebot, keine Rechnung, kein
ZUGFeRD-PDF und keine Mail mit einem Beleg darin. Zusammen bleiben die drei
Dienste im Leerlauf unter 600 MiB, auch ohne Limit für die Anwendung; das Ziel
aus ADR 0002 sind zwei Gigabyte.

Eingeschaltet ist er in `docker/.env` mit `COMPOSE_PROFILES=renderer`. Wer
wirklich nie ein PDF braucht, lässt den Wert leer:

```bash
COMPOSE_PROFILES=
```

Die Zeile zu löschen hilft nicht: `setup.sh` trägt vor jedem Start jede Zeile
der Vorlage nach, die in der `.env` fehlt, und damit auch diese. Ohne Renderer
läuft alles andere weiter, und ein Versuch, ein PDF zu erzeugen, bekommt eine
Meldung, die sagt, wie er startet und wo er abgeschaltet ist. Das ist die
Zusage aus ADR 0007.

> Das Abbild `ghcr.io/browserless/chromium` bringt eine fertige PDF-Schnittstelle
> mit, ist mit 3,9 GB aber deutlich größer als die 300 MB, mit denen ADR 0007
> gerechnet hat. Die Dokumentenerzeugung aus #71 läuft über dieses Abbild, und
> ein Beleg braucht dort gemessen unter einer halben Sekunde. Ob ein
> schlankeres Chromium die Schnittstelle ersetzen kann, ist damit nicht
> entschieden, nur leichter zu entscheiden: die Naht dafür ist `Renderer` in
> `packages/server/src/documents/renderer.ts`, und ein Wechsel ändert keine
> Vorlage.
>
> Das Abbild steht seit #153 auf einer festen Fassung mit Digest, in
> `docker/compose.yaml` und im Job "E-Rechnung gegen KoSIT und Mustang" derselben;
> ein Schritt dort prüft, dass beide übereinstimmen. Ein Update ist ein Pull
> Request, der beide Stellen ändert, und die CI druckt damit, bevor es eine
> Installation tut. `chromium` ist schon das schlankste Abbild von browserless,
> die übrigen bringen Firefox und WebKit mit. Kleiner ginge es nur mit einem
> eigenen Dienst um Chromium herum statt der fertigen Schnittstelle, und das lohnt
> sich erst, wenn Platz oder Speicher wirklich knapp werden.

## Zwei Rollen, nicht eine

Der Container migriert nicht beim Start, sondern in einem eigenen Schritt davor,
und der meldet sich mit einer anderen Rolle an:

- `opengewerk_owner` besitzt die Tabellen und führt die Migrationen aus.
- `opengewerk_app` ist die Rolle, mit der die Anwendung arbeitet. Sie darf
  nichts anlegen und nichts ändern am Schema, und für sie gilt die
  Mandantentrennung.

Die Trennung ist der Grund, warum eine Anwendung mit den Zugangsdaten des
Eigentümers gar nicht erst startet: für den Eigentümer einer Tabelle greift
Row-Level Security nur über `FORCE`, und eine Instanz, die als er verbindet,
hätte eine Absicherung, die aussieht wie eine und keine ist. OpenGewerk weist
so eine `DATABASE_URL` beim Start zurück, statt sie hinzunehmen.

Angelegt werden beide Rollen einmalig von `docker/postgres-init/10-roles.sh`,
beim ersten Start des Datenbank-Containers. Die Migration legt `opengewerk_app`
bewusst ohne Passwort und ohne Anmelderecht an: Zugangsdaten gehören nicht in
eine Datei, die in jedem Klon dieses Repositories liegt.

## Sicherung und Rückspielen

Ein Backup, das nie zurückgespielt wurde, ist kein Backup. Deshalb liegt hier
beides als Skript vor, und der Rückspielweg prüft danach nach, ob wirklich
alles zurückgekommen ist.

```bash
docker compose -f docker/compose.yaml --profile backup run --rm backup backup.sh
```

Das ist die Sicherung von Hand, etwa vor einem Update. Jede Nacht sichert die
Instanz ohnehin von selbst, siehe unten.

Das Ergebnis ist ein Archiv mit vier Teilen und einem Manifest:

| Teil | Inhalt |
| --- | --- |
| `database.dump` | die Datenbank, `pg_dump` im Custom-Format |
| `storage.tar` | der inhaltsadressierte Dateispeicher |
| `storage-late.tar` | jede Datei, die der Dateispeicher nach dem Dump hat und `storage.tar` nicht |
| `audit-chains.tsv` | je Mandant der Kopf der Audit-Hashkette |
| `manifest.json` | Zeitstempel, PostgreSQL-Version und eine Prüfsumme je Teil |

**Datenbank und Dateien liegen im selben Lauf, und der Dateispeicher wird um
die Datenbank herum gesichert** (#991). Ein Beleg zeigt per Hash auf eine Datei.
Würden die Dateien nur vorher gesichert, könnte der Dump eine Zeile für eine
Datei enthalten, die erst zwischen den beiden Schritten hochgeladen wurde, und
das Archiv hätte die Datei nicht: eine zurückgespielte Rechnung, die auf nichts
zeigt. Würden sie nur nachher
gesichert, könnte das Aufräumen (siehe unten) eine Datei, deren letzte Zeile
gleich nach dem Dump ging, herausnehmen, bevor die Sicherung sie liest. Deshalb
kommt zuerst der Dateispeicher in `storage.tar`, dann die Datenbank, dann
jede Datei, die der Speicher jetzt hat und `storage.tar` nicht, in
`storage-late.tar`. Welche das sind, liest die Sicherung aus dem ersten Teil,
nicht aus einer Uhr. Der schlimmste Fall ist eine Datei, auf die niemand
verweist, und die kostet Plattenplatz und sonst nichts. Das gilt, solange die
Sicherung den Speicher schneller liest, als die Frist des Aufräumens dauert;
ist sie danach schon zwölf Stunden unterwegs, bricht sie deshalb ab. Ein Archiv von vor dieser Änderung hat keinen
späten Teil und geht wie bisher zurück.

**Eine Sicherung läuft höchstens zwölf Stunden** (#999). Bleibt ein Teil
hängen, etwa `pg_dump` hinter einer Sperre oder das Schreiben auf ein Ziel,
das nicht mehr antwortet, endet die Sicherung zwölf Stunden nach ihrem Start
mit allem, was sie gestartet hat, und räumt auf wie nach jedem anderen Fehler.
Die geplante Sicherung versucht es in der nächsten Nacht wieder. Dafür braucht
sie eine eigene Prozessgruppe: Die geplante und eine mit
`docker compose --profile backup run --rm backup backup.sh` gestartete haben
eine. Ruft ein eigenes Skript `backup.sh` in einem Container auf, gilt nur die
Grenze für das Lesen des Dateispeichers. Antwortet das Ziel auch beim
Aufräumen nicht mehr, gibt die Sicherung dort nach spätestens 35 Sekunden auf
und nennt die Datei, die liegen bleibt. Ein Prozess, der im Kernel
ununterbrechbar auf ein Laufwerk wartet, etwa beim Zurückschreiben auf ein
NFS-Laufwerk mit `hard`, das nicht mehr antwortet, endet weder mit TERM noch mit
KILL; dann endet die Sicherung erst, wenn das Laufwerk wieder antwortet. Die
Uhrzeit fragt der Zeitplan mit Grenzen ab (#1003): Hängt die Datenbank an einer
Sperre, gilt 02:30.

**Eine Datei, auf die niemand mehr verweist, geht nach einem Tag** (#657). Einmal
am Tag nimmt die Anwendung die Bytes jeder Datei aus dem Speicher, die kein
Betrieb mehr hält und die seit einem Tag niemand abgelegt hat, dazu Reste
abgebrochener Schreibvorgänge. Eine Sicherung, die eine solche Datei noch
enthält, bringt sie beim Zurückspielen mit ihrer Zeile zurück; eine ohne Zeile
geht am nächsten Tag wieder. Eine geschlossene Instanz räumt nicht auf.

**Die Sicherung meldet sich als Superuser an**, nicht als Eigentümer der
Tabellen. Row-Level Security ist auf jeder Tabelle mit `FORCE` gesetzt und gilt
damit auch für den Eigentümer; ein Dump unter dieser Rolle käme entweder mit
einer Fehlermeldung zurück oder, schlimmer, leer. Die eine Ausnahme ist die
Suchtabelle der Artikel, die nur wiederholt, was in `articles` steht (ADR 0015). Eine Sicherung, die weniger
sehen darf als alles, ist keine.

**Auf das Ziel kommt nur das fertige Archiv.** Dump und Dateispeicher entstehen
im Container, nur für root lesbar, und gehen in einem Strom gepackt und
verschlüsselt in eine verborgene Datei auf dem Ziel, die erst am Ende den Namen
eines Archivs bekommt. Scheitert ein Schritt, auch age, bleibt auf dem Ziel
nichts liegen, kein halbes Archiv und keine Teile im Klartext. Die Ausnahme
ist ein Aufräumen, das auf dem Ziel scheitert, etwa weil es nicht mehr antwortet
oder nur noch lesbar ist: Dann bleibt die Datei dort, und die Sicherung nennt
sie (#999). Das ist die verborgene Datei oder, wenn die Sicherung erst nach dem
Umbenennen scheiterte, das Archiv unter seinem Namen. Wird der Dienst
`backup-schedule` angehalten, während eine Sicherung läuft, etwa bei einem
Update, räumt sie vorher auf, auch wenn sie das schon tut; Docker wartet darauf
bis zu zwei Minuten (#1004). Für eine Sicherung von Hand im Dienst `backup` gilt
dasselbe, mit Strg+C wie mit `docker stop` (#1007). Platz braucht die
Sicherung dafür im Container, also dort, wo Docker seine Container hält, etwa so
viel wie Dump und Dateispeicher zusammen; `TMPDIR` im Dienst verlegt das. Die
Archive auf dem Ziel sind nur für ihren Besitzer lesbar, wer sie von dort
weiterkopiert, tut das als root.

**Jede Sicherung steht in einem Verzeichnis auf der Instanz.** Name und SHA-256
ihres Archivs kommen in `archives.sha256` im Volume `backup-status`, das nur die
Dienste der Sicherung beschreiben und das nie auf dem Ziel liegt. Die Prüfsumme
entsteht im Container an dem Strom, der auf das Ziel geht, und wird nicht von
dort zurückgelesen: was dort inzwischen liegt, könnte ein anderes Archiv sein.
Gegen dieses Verzeichnis prüfen Zurückspielen und Prüfen jedes Archiv, siehe unten. Es behält
auch Archive, die die Aufbewahrung vom Ziel genommen hat, damit ein ausgelagertes
und zurückgeholtes Archiv prüfbar bleibt; eine Zeile sind rund hundert Bytes.

## Jede Nacht, ohne dass jemand daran denkt

Eine Sicherung, an die jemand denken muss, fehlt genau an dem Tag, an dem sie
gebraucht wird (#130). Der Dienst `backup-schedule` startet mit der Instanz und
sichert jeden Tag zu einer festen Uhrzeit deutscher Zeit, ohne andere Wahl um
02:30 Uhr, mit demselben `backup.sh` und denselben Einstellungen wie die
Sicherung von Hand. War der Rechner um diese Zeit aus, holt er die Sicherung
nach, sobald er wieder läuft, und zwar genau einmal: fällig ist sie, wenn die
letzte vor dem letzten Termin fertig wurde. Ein Neustart am Nachmittag sichert
deshalb nicht noch einmal.

**Die Uhrzeit ist eine Einstellung der Instanz** (#188), nicht eines Betriebs:
eine Instanz kann mehrere Betriebe tragen, und die Stunde für alle legt fest,
wer die Instanz betreibt, im Bereich der Instanz unter "Einstellungen". Der
Dienst liest sie vor jeder Prüfung neu aus der Datenbank, eine Änderung gilt
also nach spätestens fünf Minuten und ohne Neustart; antwortet die Datenbank
nicht, gilt 02:30.

**Eine Instanz ohne Betrieb sichert der Zeitplan nicht.** Nach einem
Plattenverlust kommt sie leer zurück, und eine Sicherung davon wäre die neueste,
die `restore.sh latest` nimmt; vierzehn Nächte später wäre die letzte mit Daten
entfernt. Von Hand lässt sie sich weiterhin sichern.

**Das Büro sieht, wann zuletzt gesichert wurde.** Jede Sicherung hält danach in
einem eigenen kleinen Volume fest, wann sie fertig wurde. Die Anwendung liest
nur diesen Eintrag, und zwar lesend, nicht die Archive, denn die enthalten alle
Betriebe der Instanz. Unter "Einstellungen", "Sicherung" stehen Zeitpunkt,
Archiv und ob es verschlüsselt ist; ist die letzte Sicherung älter als zwei
Tage, steht oben im Büro eine Warnung, für den Inhaber und das Büro. Warum
eine ausblieb, zeigt:

```bash
docker compose -f docker/compose.yaml logs backup-schedule
```

## Zurückspielen

```bash
docker compose -f docker/compose.yaml stop app backup-schedule \
  && docker compose -f docker/compose.yaml --profile backup run --rm backup restore.sh latest \
  && sh docker/start.sh
```

Die Anwendung ist dabei angehalten, damit niemand etwas einträgt, das das
Zurückspielen gleich wieder überschreibt, und die nächtliche Sicherung auch:
Sie legte sonst womöglich ein halb zurückgespieltes Archiv als neuestes ab, das
ein späteres `latest` nähme. `start.sh` startet beide wieder. Läuft die
Anwendung doch, sperrt `restore.sh` sie für die Dauer aus. Jeder Schritt läuft
nur, wenn der davor gelang: Ließ sich die Anwendung nicht anhalten, wird nichts
zurückgespielt, und bricht `restore.sh` erst nach der Datenbank ab, beim
Kopieren des Dateispeichers oder an der Prüfung der Audit-Ketten, kann die
Datenbank schon ersetzt und der Dateispeicher zum Teil ersetzt sein (siehe
unten). Dann bleibt die
Anwendung angehalten, bis die Ursache behoben und die Sicherung noch einmal
zurückgespielt ist. Darauf achten auch `start.sh` und die Sicherung (#1012): Ist
die Anwendung ausgesperrt, ohne dass ein Rückspielen sie zum Warten auf die
Migrationen vermerkt hat, bricht `start.sh` nach den Migrationen ab und startet
weder sie noch die nächtliche Sicherung. Und `backup.sh` sichert nichts, solange
die Anwendung ausgesperrt ist, weder nachts noch von Hand; ein halber Stand würde
sonst die neueste Sicherung, die `latest` nimmt. Gestartet wird sie mit `start.sh` wie nach einem Update:
Stammt die Sicherung von einer älteren Fassung, laufen zuerst die Migrationen,
und fehlt der Container noch, etwa auf einer neuen Maschine, legt es ihn an.

Sicherung und Rückspielen schließen sich aus, auch eine Sicherung von Hand. Jede
Sicherung hält eine geteilte Sperre auf `.running` im Volume `backup-status`,
vom ersten Lesen bis zum Ende; das Rückspielen hält sie allein, bevor es etwas
ändert, bis es fertig ist. Läuft gerade eine Sicherung, lehnt `restore.sh` ab
und ändert nichts, und solange es läuft, beginnt keine Sicherung. Sonst läse
eine Sicherung womöglich die Datenbank vor und den Dateispeicher nach dem
Rückspielen. Mehrere Sicherungen laufen weiter nebeneinander. Läuft schon ein
anderes Rückspielen, lehnt ein zweites ebenso ab und rät nicht zu `start.sh`:
Das würde die Migrationen auf der Datenbank ausführen, die das andere gerade
ersetzt. Erst wenn das andere fertig ist, gilt seine Meldung.

**Eine verschlüsselte Sicherung** braucht den privaten Schlüssel, und der liegt
nicht auf dieser Maschine (siehe „Verschlüsselung und Aufbewahrung“). Er wird
nur für diesen einen Lauf hineingereicht, als Datei, die nur root lesen kann:

```bash
docker compose -f docker/compose.yaml stop app backup-schedule \
  && docker compose -f docker/compose.yaml --profile backup run --rm \
    -v /root/age-schluessel.txt:/run/age-schluessel:ro \
    -e BACKUP_AGE_IDENTITY=/run/age-schluessel \
    backup restore.sh latest \
  && sh docker/start.sh
```

Danach gehört die Datei wieder von der Maschine.

**Zuerst die Herkunft.** Das Ziel liegt in der Regel auf einer anderen Maschine,
und wer dort schreiben kann, kann ein Archiv neben die anderen legen. Ein
passendes Manifest sagt nur, dass es heil ist, und die Verschlüsselung sagt
nichts darüber, wer es gemacht hat: der Empfänger ist ein öffentlicher
Schlüssel. Deshalb nimmt `restore.sh` nur ein Archiv, das mit derselben
Prüfsumme im Verzeichnis `archives.sha256` dieser Instanz steht, und eine
Installation, die verschlüsselt (`BACKUP_AGE_RECIPIENT` ist gesetzt), nimmt kein
unverschlüsseltes. Beides wird gefragt, bevor etwas entschlüsselt, entpackt oder
gesperrt wird; ein abgelehntes Archiv stammt nicht von dieser Instanz oder ist
nicht mehr, wie sie es geschrieben hat. Das Archiv wird dafür einmal vom Ziel in
den Container kopiert, und geprüft und gelesen wird nur diese Kopie: eine Datei,
die auf dem Ziel geprüft wurde, könnte beim Lesen schon eine andere sein. Die
Kopie ist verschlüsselt, wenn das Archiv es ist, und braucht so viel Platz wie
das Archiv.

**Dann der Dateispeicher, vor der Datenbank** (#1000). `restore.sh` packt beide
Teile des Speichers in einen Ordner im Container aus und prüft dort jede Datei:
nur Dateien und Ordner, jede Datei mit Namen und Ort, wie der Speicher sie
anlegt, und ihr Inhalt passend zu ihrem Hash. Was keine Datei des Speichers ist,
nimmt es heraus und nennt es. Passt der Inhalt einer Datei nicht zu ihrem Namen,
bricht es ab, bevor es die Anwendung aussperrt oder die Datenbank anfasst;
Datenbank und Dateispeicher bleiben dann, wie sie waren. Erst nach der Datenbank
kommt der geprüfte Stand in den Dateispeicher. Im Container braucht das kurz
etwa doppelt so viel Platz wie der Dateispeicher.

**Auf einer neuen Maschine** fehlt das Verzeichnis, es lag mit dem Volume
`backup-status` auf der alten. Dort kommt zuerst die `docker/.env` der alten
Instanz an ihren Platz, vor jedem Start: Mit einer neuen ließen sich zweite
Faktoren und gespeicherte Passwörter nicht mehr öffnen, weil `SESSION_SECRET`
ein anderes wäre, und die Passwörter der Datenbank passten nicht zu dem, was
der erste Start anlegt. `setup.sh` lässt eine vorhandene `.env` stehen und
ergänzt nur, was fehlt. Ebenso vor dem ersten Start muss das Archiv dort
liegen, wohin `BACKUP_TARGET` zeigt: Ein Ziel auf einer anderen Maschine wird
zuerst eingehängt, und wer mit der Vorgabe, dem Volume `backups`, gesichert und
die Archive von Hand kopiert hat, legt die Kopien in ein Verzeichnis und trägt
dessen absoluten Pfad als `BACKUP_TARGET` ein. Das Volume der neuen Maschine ist
leer, und `restore.sh` sucht ein Archiv nur dort. Dann startet die Instanz einmal leer, damit es den
Dateispeicher gibt und er dem Benutzer der Anwendung gehört: `restore.sh` leert
und füllt diesen Ordner mit den Rechten seines Eigentümers, und legte erst die
Sicherung das Volume an, gehörte er root. Danach spielt

```bash
sh docker/start.sh \
  && docker compose -f docker/compose.yaml stop app backup-schedule \
  && docker compose -f docker/compose.yaml --profile backup run --rm backup restore.sh --skip-origin-check <archiv> \
  && sh docker/start.sh
```

das Archiv trotzdem zurück, mit allen Prüfungen, die danach kommen. Ist es
verschlüsselt, kommen die beiden Angaben für den Schlüssel aus dem Beispiel
oben (`-v /root/age-schluessel.txt:/run/age-schluessel:ro` und
`-e BACKUP_AGE_IDENTITY=/run/age-schluessel`) auch hier hinter `run --rm`. Der Schalter
heißt, was er tut: die Herkunft prüft dann nur noch, wer ihn tippt. Also ein
Archiv mit seinem Namen nennen, dessen Zeit und Größe zu den eigenen Sicherungen
passen, statt `latest`, und den Schalter nur setzen, wo das Verzeichnis wirklich
fehlt. Archive von vor dem Update, mit dem das Verzeichnis kam, stehen nicht
darin und brauchen ihn ebenso. Er ist mit Absicht keine Einstellung in der
`.env`: dort schaltete er die Prüfung für immer ab.

**Die Datenbank spielt der Eigentümer der Tabellen zurück**, `opengewerk_owner`,
nicht der Superuser. Ein Dump ist eine Folge von Anweisungen, und als Superuser
liefe jede davon mit allen Rechten, auch eine, die einen Wechsel der Rolle
zurücknimmt. Als Eigentümer kann ein Dump, was eine Migration kann, und mehr
braucht ein Dump dieser Datenbank nicht; der Dienst `backup` bekommt dafür
`OPENGEWERK_OWNER_PASSWORD` aus der `.env`. Der Superuser sperrt die Anwendung
aus und liest danach für die Prüfungen alle Mandanten.

**Vor dem Dump wird geleert, und beides läuft in einer Transaktion** (#988). Der
Lauf verwirft zuerst alles, was dem Eigentümer gehört: das Schema `drizzle` mit
dem Protokoll der Migrationen, in `public` die Erweiterungen, Tabellen, Sichten,
Sequenzen, Funktionen und Typen. Der Dump landet dann wie in einer neuen
Datenbank, auch wenn er von einer älteren Fassung stammt und spätere Migrationen
Tabellen angelegt haben, die er nicht kennt. Bis dahin räumte
`pg_restore --clean` auf, und das verwirft nur, was im Dump steht; an einer
späteren Tabelle, die an einer Tabelle des Dumps hing, brach es ab und ließ ein
halbes Schema zurück. Den Dump schreibt der Lauf dafür zuerst als SQL in den
Container, und das braucht dort etwa viermal so viel Platz wie der Dump; fehlt
er, scheitert der Lauf, bevor er die Datenbank anfasst. Meldet `psql` beim
Einspielen einen Fehler, fragt der Lauf die Datenbank, wie die Transaktion
ausging: Bricht die Verbindung nach dem Abschluss ab, aber bevor die Antwort
ankommt, steht die Sicherung womöglich schon drin. Nur eine Transaktion, die
sicher abgebrochen ist, gilt als nicht geschehen. Scheitert also eine
Anweisung, beim Leeren oder beim
Einspielen, steht die Datenbank da wie vorher, und die Anwendung bekommt ihre
Anmeldung zurück. Scheitert der Lauf erst danach, beim Kopieren des
Dateispeichers oder an der Prüfung der Audit-Ketten, bleibt sie ausgesperrt, und
die Meldung sagt das. Ein Anhalten mit Strg+C oder `docker stop` endet genauso:
Der laufende Schritt bricht ab, ein abgebrochenes Einspielen fragt die Datenbank
noch nach dem Ausgang, und die Anwendung bekommt ihre Anmeldung nur zurück, wenn
die Datenbank nicht ersetzt ist (#1007). Ebenso bleibt sie ausgesperrt, wenn
sie schon vor dem Lauf ausgesperrt war, weil ein früherer nicht durchlief. Wartete
ein früherer auf die Migrationen, nimmt der Lauf dessen Vermerk gleich nach dem
Aussperren von der Rolle, bevor er etwas ändert, und schreibt ihn nur zurück,
wenn er scheitert, bevor die Datenbank ersetzt ist (#1012). So kann kein
Vermerk auf einem halben Stand stehen bleiben, auf dem `start.sh` sonst die
Anmeldung zurückgäbe; lässt er sich nicht zurückschreiben, nennt die Meldung den
Befehl dafür. Ein
Lauf, der durchgeht, gibt die Anmeldung zurück oder überlässt das dem Start,
siehe unten. Lässt sie sich nicht zurückgeben, etwa weil die Verbindung abbricht,
sagt der Lauf das, nennt den Befehl dafür und endet mit einem Fehler (#1007).
Wer den Stand nach einem Fehler trotzdem so nehmen will, gibt sie ebenso von
Hand zurück:

```bash
docker compose -f docker/compose.yaml exec postgres psql -U postgres -c "alter role opengewerk_app login"
```

Nach einem Erfolg startet die Instanz im Ordner der Installation mit
`sh docker/start.sh`. Stammt die Sicherung von einer älteren Fassung als die
Datenbank davor, hatte diese keine Migrationen, oder war die Anwendung schon vor
dem Lauf ausgesperrt, bleibt sie auch nach dem Erfolg ausgesperrt, mit einem Vermerk an ihrer Rolle: Sie
liefe sonst womöglich auf einem Schema, das älter ist als sie. `start.sh` bringt die Datenbank mit den Migrationen auf den Stand der
Fassung, gibt der Anwendung dann die Anmeldung zurück und startet sie. Das tut
es nur mit Docker Engine ab 28.3.3: Auf einer älteren bleibt die Anwendung
ausgesperrt, bis Docker aktualisiert ist, die Daten sind dann aber schon
zurückgespielt. Der Container des Rückspielens sieht die Engine nicht, deshalb
sagt `restore.sh` das vor dem Aussperren.

Der Lauf prüft drei Dinge, von denen jedes eine Frage beantwortet, die die
anderen nicht beantworten können. Die ersten beiden laufen, bevor er die
Anwendung aussperrt und die Datenbank anfasst; das dritte, nachdem die
Datenbank zurück ist:

1. **Das Manifest**, ob das Archiv heil angekommen ist. Eine beschädigte
   Sicherung wird abgelehnt, bevor sich etwas ändert.
2. **Die Dateihashes** (#1000). Ein inhaltsadressierter Speicher kann das allein
   beantworten, denn der Name einer Datei ist der SHA-256 ihres Inhalts. ADR
   0007 verlangt eine Stichprobe; geprüft werden alle, weil das bei den
   Datenmengen eines Handwerksbetriebs Sekunden kostet und eine Stichprobe
   "wahrscheinlich" sagt, wo das hier "ja" sagt.
3. **Die Audit-Ketten**, ob das Log dasselbe Log ist.

**Die Anwendung wird ausgesperrt, nicht um Abwesenheit gebeten.** Der erste
Entwurf zählte offene Verbindungen und schützte vor nichts: der
Verbindungspool schließt eine ungenutzte Verbindung nach Sekunden, die Zählung
steht also auf null, während die Anwendung läuft. Stattdessen bekommt
`opengewerk_app` für die Dauer des Laufs `NOLOGIN`, bestehende Verbindungen
werden beendet, und der Eigentümer, der zurückspielt, und der Superuser, der
prüft, sind davon nicht betroffen. Die gesamte Datenbank zu sperren ginge
nicht, das schlösse auch sie aus.

**Im Dateispeicher arbeitet das Rückspielen mit den Rechten seines Eigentümers**,
dem Benutzer der Anwendung, nicht als root. Ob die Anwendung wirklich angehalten
ist, sieht `restore.sh` nicht. Liefe sie noch, könnte sie zwischen zwei
Schritten einen Ordner gegen einen Link tauschen, und root folgte ihm aus dem
Speicher hinaus, zu den Archiven etwa. Mit den Rechten des Eigentümers führt ein
solcher Link nur dorthin, wo dieser Benutzer im Container der Sicherung
schreiben darf, und die Passwörter der Datenbank bekommt er nicht mit. Dafür
hat der Dienst `backup` die Capabilities `SETUID` und `SETGID`, dazu `KILL`,
damit ein Anhalten auch diese Schritte erreicht. Abgelehnt, bevor
sich etwas ändert, wird ein Rückspielen in drei Fällen:

- Der Dienst kann nicht als Eigentümer arbeiten, weil ihm diese Capabilities
  fehlen, etwa in einer eigenen `compose.yaml`. Gehört der Speicher root, ist
  das gleich.
- Der Eigentümer darf in das Ziel der Sicherungen oder in das Verzeichnis
  `BACKUP_STATUS_PATH` schreiben, siehe unten beim NAS.
- Im Speicher liegt ein Ordner, den der Eigentümer nicht leeren darf, der
  Speicher selbst eingeschlossen: einer, der ihm nicht gehört, etwa nach einem
  halben Kopieren vor #1000 root, oder einer, den er nicht lesen oder
  beschreiben darf. Ebenso, wenn er den Speicher gar nicht erreicht, weil er
  einen Ordner darüber nicht betreten darf. Die Meldung nennt die Befehle, die den Speicher seinem
  Eigentümer zurückgeben.

Ordner, die eine Sicherung ohne Schreibrecht für ihren Eigentümer enthält,
bekommen es vor dem Auspacken, sonst kämen die Dateien darin nicht zurück.

## Die Sicherung als Zeuge für das Audit-Log

Die Hashkette im Audit-Log macht eine kleine Korrektur unmöglich zu verstecken.
Gegen jemanden, der den Trigger abschalten kann, hilft sie allein nicht: er
ändert einen Eintrag, rechnet alle folgenden neu, und die Kette geht wieder
auf. Genau dafür liegt der Kopf jeder Kette in der Sicherung, also außerhalb
der Datenbank.

```bash
docker compose -f docker/compose.yaml --profile backup run --rm backup verify.sh latest
```

Das hält das Log der laufenden Instanz gegen die Sicherung, ohne etwas
zurückzuspielen, und beantwortet nicht "geht die Kette auf", sondern "ist
Eintrag Nummer N noch derselbe, den diese Sicherung gesehen hat". Wie beim
Zurückspielen nur gegen ein Archiv aus dem Verzeichnis dieser Instanz, mit
demselben Schalter für eine neue Maschine: gegen Köpfe, die jemand anderes auf
das Ziel gelegt hat, ginge ein umgeschriebenes Log durch.

Am 19.09.2026 gegengeprüft: nach einer gefälschten Änderung mit anschließend
neu berechneter Kette meldet die Prüfung in der Datenbank
`gebrochen bei: nirgends`, und `verify.sh` nennt trotzdem den betroffenen
Mandanten samt beider Fingerabdrücke. Der unbeteiligte zweite Mandant bleibt
dabei unauffällig.

## Verschlüsselung und Aufbewahrung

Ein Archiv wird mit einem **öffentlichen** Schlüssel verschlüsselt (age). Das
ist nicht dasselbe wie eine Passphrase: die Maschine, die sichert, kann ihre
eigenen älteren Sicherungen nicht lesen. Wer den Server übernimmt, bekommt das
Archiv nicht mit dazu.

```bash
docker compose -f docker/compose.yaml --profile backup run --rm --no-deps backup age-keygen
```

Die Zeile mit `age1…` ist der öffentliche Schlüssel und gehört als
`BACKUP_AGE_RECIPIENT` in die `.env`. Die Zeile mit `AGE-SECRET-KEY-…` gehört
woanders hin, nicht auf diese Maschine: ein Schlüssel, der neben dem Archiv
liegt, schützt vor nichts. Zum Zurückspielen wird er für genau diesen einen
Lauf hineingereicht, wie unter „Zurückspielen“ gezeigt.

Ohne gesetzten Empfänger läuft die Sicherung trotzdem, gibt aber eine Warnung
aus. Sie enthält Kundendaten, Belege und das Audit-Log.

`BACKUP_KEEP` legt fest, wie viele Generationen bleiben (Vorgabe 14). Ältere
werden nach jedem Lauf entfernt.

Ein Archiv heißt nach der Datenbank, die es enthält, `opengewerk-<zeit>.tar.gz`,
verschlüsselt mit `.age` dahinter. Aufbewahrung, Prüfung und Rückspielen sehen
nur Archive genau dieser Form, ein Ziel, das eine weitere Anwendung mitbenutzt,
behält also deren Archive. Das gilt auch, wenn statt `latest` ein Archiv mit
seinem Namen genannt wird: eines, das nicht so heißt, lehnen `restore.sh` und
`verify.sh` ab, bevor sie die Datenbank fragen. Zwei Anwendungen der
Organisation halten ihre Mandanten in Tabellen desselben Namens, und das Archiv
der einen würde in der Datenbank der anderen deren Mandanten ersetzen. Wer das
Abbild der Sicherung in einer anderen Anwendung benutzt, setzt `BACKUP_PREFIX`,
wenn der Name ihrer Datenbank nicht der Anfang ihrer Archive sein soll.

**`BACKUP_TARGET` gehört auf eine andere Maschine.** Das ist der Regelfall und
keine Möglichkeit. Die Vorgabe ist ein Docker-Volume auf derselben Platte wie
die Daten: es überlebt ein `docker compose down` und einen Bedienfehler, aber
keinen Plattendefekt, keinen Brand und keinen Diebstahl des Rechners. Ein
Verzeichnis, das von einer anderen Maschine eingehängt ist, etwa von einem NAS
über NFS oder SMB, kommt als absoluter Pfad in die `.env`:

```bash
BACKUP_TARGET=/mnt/sicherung/opengewerk
```

Eingehängt wird es auf dem Server selbst, und zwar so, dass es einen Neustart
übersteht, also über `/etc/fstab` oder eine systemd-Einheit und nicht von Hand.
Ist es beim Start nicht da, schreibt die Sicherung in das leere Verzeichnis
darunter, auf dieselbe Platte, und das Büro merkt davon nichts; wer ein NAS
nimmt, prüft deshalb nach dem ersten Neustart, dass die Archive dort ankommen.
Das Verzeichnis gehört root und gibt anderen kein Schreibrecht. Darf der
Benutzer der Anwendung hineinschreiben, lehnt `restore.sh` das Rückspielen ab,
denn es arbeitet im Dateispeicher mit den Rechten dieses Benutzers, siehe oben.
Ausprobiert wird das, nicht aus den Rechten abgelesen. Es trifft also auch eine
Freigabe, die beim Einhängen jede Datei diesem Benutzer zuordnet, wie SMB mit
`uid=`, eine, die jeden Benutzer gleich behandelt, wie NFS mit `all_squash`
oder SMB mit `noperm`, und eine ACL, die ihm das Schreiben erlaubt. Scheitert die
Probe aus einem anderen Grund als fehlendem Recht, etwa weil das Ziel voll ist,
lehnt `restore.sh` ebenso ab, denn Löschen braucht keinen Platz. Wandert eine Kopie zusätzlich außer Haus, ist auch ein Brand im Büro
überstanden. Verschlüsselt sollte ein Archiv, das die Maschine verlässt, in
jedem Fall sein.

## Aktualisieren

Ein Update ist das, was Leitentscheidung 6 verspricht: Abbild tauschen,
Migration läuft, Dienst startet. Aus einem Release heißt das: das Paket der
neuen Fassung mit `cosign verify-blob` prüfen (siehe oben), an dieselbe Stelle
entpacken, mit
`tar --no-same-owner -xzf opengewerk-<fassung>.tar.gz`, die `.env` bleibt, und
derselbe Befehl wie beim ersten Start, `sh docker/start.sh`. Er ergänzt die
`.env` um das, was die neue Fassung braucht, holt ihre Abbilder und macht dann
zwei Aufrufe, deren Reihenfolge der ganze Punkt ist:

```bash
docker compose -f docker/compose.yaml run --rm migrate
docker compose -f docker/compose.yaml up -d
```

In einem Checkout kommt die neue Fassung mit `git pull`, und statt zu holen
baut der Befehl vorher Anwendung, Sicherung und den Dienst für Aktualisierungen
aus dem Quelltext
(`docker compose -f docker/compose.yaml build migrate backup-schedule updater`).
Das gilt, solange `OPENGEWERK_VERSION` in der `.env` leer ist. Steht dort eine
Fassung, holt der Befehl deren Abbilder und baut nichts, und die Instanz bleibt
nach `git pull` auf dieser Fassung; vor dem Start wird die Zeile geleert oder
auf die neue Fassung gesetzt. Eine Fassung vor 0.9.0 passt dort nicht mehr: Für
sie gibt es kein Abbild des Dienstes für Aktualisierungen, den ein Checkout ab
0.9.0 mitstartet.

Läuft die Migration durch, tauscht der zweite Aufruf die Container, und nach
wenigen Sekunden antwortet die Instanz wieder. Schlägt sie fehl, bricht der
erste Aufruf mit dem Grund ab, der zweite wird nie erreicht, und die laufende
Instanz beantwortet weiter Anfragen. Die Datenbank steht dabei unverändert auf
dem Stand davor: alle ausstehenden Migrationen laufen in einer einzigen
Transaktion, ein halbes Update gibt es nicht.

**Nicht `docker compose up -d` allein**, obwohl der Migrationsdienst auch dort
davorhängt. Compose erzeugt zuerst alle Container neu, deren Abbild sich
geändert hat, und startet sie erst danach. Der laufende Anwendungscontainer ist
also schon weg, wenn die Migration überhaupt anfängt. Geht sie schief, steht
die Instanz still, statt weiter zu antworten. Nachgemessen am 19.09.2026; der
Unterschied ist genau ein Aufruf mehr.

Daraus folgt eine Regel für die Migrationen selbst: **eine Migration muss auch
zur vorherigen Fassung passen.** Zwischen den beiden Aufrufen läuft die alte
Anwendung einen Moment lang auf dem neuen Schema. Eine Spalte hinzufügen ist
deshalb unbedenklich, eine umbenennen oder entfernen nicht. Das braucht zwei
Fassungen: in der ersten die neue Spalte anlegen und beschreiben, in der
zweiten die alte entfernen.

Sprünge über mehrere Stände hinweg funktionieren, ein Betrieb aktualisiert
nicht jede Woche. Der Lauf spielt alles ein, was seit dem Stand der Datenbank
dazugekommen ist, und tut gegen eine schon aktuelle Datenbank nichts. Die CI
fährt genau das: eine Instanz auf einem älteren Stand, Daten darauf, zwei
Migrationen darüber, danach derselbe Bestand und dieselbe Audit-Kette.

Zwei Fälle lehnt der Lauf ab, statt sie stillschweigend zu übergehen:

- **Eine gemergte Migration wurde nachträglich geändert.** Geprüft werden die
  Hashes in der Datenbank gegen die Dateien im Abbild. Ohne diese Prüfung
  passiert schlicht nichts, und genau das ist das Problem: das Werkzeug
  vergleicht nur Zeitstempel, findet nichts Neueres und meldet Erfolg. Wer die
  Änderung gemacht hat, hält sie für eingespielt.
- **Das Abbild ist älter als die Datenbank**, ein zurückgedrehtes Update also.
  Zurück geht nicht, das ältere Abbild kennt die Spalten nicht, die der neuere
  Stand angelegt hat. Der Weg zurück führt über die Sicherung von vor dem
  Update.

Vor ein Update gehört eine Sicherung, siehe oben. Sie ist auch der Weg zurück,
wenn eine Migration zwar durchläuft, das Ergebnis aber nicht stimmt. Zurück
geht es in dieser Reihenfolge: zuerst die neue Fassung anhalten,

```bash
docker compose -f docker/compose.yaml stop app backup-schedule
```

dann die Sicherung von vor dem Update zurückspielen, mit ihrem Namen und noch
mit der neuen Fassung, denn bis 0.8.0 spielt `restore.sh` nicht in eine
Datenbank zurück, die weiter ist als die Sicherung:

```bash
docker compose -f docker/compose.yaml --profile backup run --rm backup restore.sh <archiv>
```

Anders als unter "Zurückspielen" folgt hier noch kein `start.sh`: Das der
neuen Fassung brächte die Datenbank mit ihren Migrationen gleich wieder auf
den neuen Stand, und die alte Fassung lehnte sie danach ab. Eine verschlüsselte
Sicherung bekommt ihren Schlüssel wie dort. Nur wenn `restore.sh` ohne Fehler
durchlief, geht es weiter: Scheitert es, bleibt die Anwendung angehalten, und
war die Datenbank schon ersetzt, auch ausgesperrt, bis die Ursache behoben und
die Sicherung noch einmal zurückgespielt ist; weder das alte Paket noch der
Befehl unten kommen vorher. Danach das Paket der alten Fassung an dieselbe Stelle entpacken. Das Zurückspielen lässt die Anwendung dabei ausgesperrt, bis die
Migrationen gelaufen sind, und erst das `start.sh` einer Fassung nach 0.8.0
gibt sie dann frei. Geht es zurück auf 0.8.0 oder früher, gibt man die
Anmeldung deshalb vor dem Start von Hand zurück, und zwar erst, wenn die neue
Fassung angehalten ist; sonst arbeitet sie bis zum Start auf dem älteren
Schema:

```bash
docker compose -f docker/compose.yaml exec postgres psql -U postgres -c "alter role opengewerk_app login; comment on role opengewerk_app is null"
```

Dann `sh docker/start.sh`.

**Aus dem Bereich der Instanz** (#1093). Unter „Aktualisierung“ im Bereich der
Instanz steht, welche Fassung läuft und ob es eine neuere gibt, mit ihren
Versionshinweisen. Dahinter steht der Dienst `updater` aus `docker/compose.yaml`,
der mit jeder Instanz startet. Er fragt einmal am Tag die API von GitHub nach dem
neuesten Release; geht das schief, versucht er es nach einer Stunde wieder.
Aktualisiert wird nur, wenn ein Betreiber den Knopf drückt und mit Passwort und
Code bestätigt. Dann startet der Dienst einen Container aus seinem eigenen
Abbild, neben Compose und nicht darunter, damit er den Neustart übersteht. Der
geht die Schritte von oben: zuerst die Sicherung mit `backup.sh`, ohne die nichts
weitergeht. Dann das Paket der neuen Fassung, mit `cosign verify-blob` gegen den
Workflow "Release" genau ihres Tags geprüft, auf Verweise und auf Pfade außerhalb
seines Ordners untersucht und Datei für Datei über die Installation gelegt, jede
erst unter eigenem Namen, damit eine volle Platte keine abschneidet; die `.env`
bleibt, und jede Datei gehört danach dem Besitzer des Ordners. Dann `sh docker/start.sh`
der neuen Fassung. Fertig ist der Lauf erst, wenn die Anwendung über `/health`
die neue Fassung nennt. Wie er ausging, zeigt die Seite mit den Schritten und dem
Ende des Protokolls. Es steht außerdem im Protokoll der Instanz und im
Änderungsprotokoll jedes Betriebs, und alle Betreiber bekommen eine E-Mail,
sofern der Mailserver der Instanz eingerichtet ist.

Der Dienst braucht den Socket von Docker und kann damit auf der Maschine, was
root kann; anders geht ein Update nicht. Deshalb erreicht ihn nichts von außen:
er hat keinen Port und ein Netz für sich allein. Mit der Anwendung spricht er nur
über zwei Volumes. In `update-requests` schreibt die Anwendung den Auftrag, und
nur sie darf dort schreiben; in `update-status` schreibt der Dienst, was er
gefunden hat und wie der Lauf steht, und die Anwendung liest es nur. Die Fassung
nimmt der Dienst nicht aus dem Auftrag. Es muss die neueste sein, die er selbst
gefunden hat, neuer als die Fassung, die läuft, und nicht älter als die Dateien
der Installation; nach einem Lauf, der nach dem Entpacken abbrach, geht so
dieselbe Fassung noch einmal. Der Auftrag darf höchstens zehn Minuten alt sein; ein Auftrag, der einen Stillstand des Dienstes überdauert hat,
startet so kein Update, mit dem niemand mehr rechnet.

Das geht nur mit einem Paket aus einem Release, das seine Abbilder mit Digest
nennt, und nur dort, wo der Dienst den Pfad der Installation auf der Maschine
kennt. Den schreibt `sh docker/start.sh` auf Linux als `OPENGEWERK_DIRECTORY` in
die `.env`, nach einem Umzug des Ordners den neuen. Unter Docker Desktop auf
Windows oder macOS bleibt er leer, weil die Engine dort andere Pfade sieht als
die Konsole, ebenso bei einem Pfad mit anderen Zeichen als Buchstaben, Ziffern
und `. _ - /`. Dann und in einem Checkout sagt die Seite, wie von Hand
aktualisiert wird. Läuft Docker ohne root, nennt `DOCKER_SOCKET` in der `.env`
seinen Socket, etwa `/run/user/1000/docker.sock`. Was der Dienst tut, zeigt
`docker compose -f docker/compose.yaml logs updater`.

**Releases** (#155). Eine Fassung erscheint mit einem Tag `v0.x.y` auf `main`;
die erste war 0.1.0 am 24.09.2026. Der Workflow "Release" baut dann Anwendung,
Sicherung und den Dienst für Aktualisierungen für x86_64 und ARM64, legt sie unter
dieser Fassung in `ghcr.io/opengewerk/opengewerk`, `ghcr.io/opengewerk/backup` und
`ghcr.io/opengewerk/updater` ab, signiert sie ohne Schlüssel über Sigstore und
schreibt die Release-Seite aus dem Abschnitt des CHANGELOG, mit dem Paket,
seiner Prüfsumme und seiner Signatur (`.sigstore.json`, ebenfalls ohne
Schlüssel). Im Paket steht die Fassung in `docker/compose.yaml` an der
Stelle von `source`; ist der Abschnitt länger, als eine Release-Seite fasst,
verweist sie auf den CHANGELOG des Tags. Ohne einen Abschnitt `## [0.x.y]` im
CHANGELOG oder für einen Tag, der nicht auf einem Stand von `main` steht,
bricht er ab. Ob ein Abbild wirklich aus diesem Repository stammt, zeigt
`cosign verify` mit dem Befehl aus den Hinweisen jedes Releases. Ein Tag wird
nie neu vergeben: eine Fassung ist, was unter ihrem Tag steht, und dafür steht
ihre Signatur. Ein zweiter Job spiegelt Anwendung, Sicherung und den Dienst für
Aktualisierungen mit ihren Signaturen nach Docker Hub, als `opengewerk/opengewerk`,
`opengewerk/backup` und `opengewerk/updater`, dort mit `latest` für die neueste
Fassung (#281). Das Paket holt weiter aus ghcr.io, denn Docker Hub
begrenzt anonyme Pulls; eine ältere Fassung holt der Workflow "Docker Hub" von Hand
nach, vor 0.9.0 ohne den Dienst für Aktualisierungen, den es da noch nicht gab.

Eine Fassung, die eine Sicherheitslücke schließt, trägt in ihrem Abschnitt des
CHANGELOG den Unterabschnitt `### Sicherheit`, und ihre Release-Seite beginnt
dann mit einem Hinweis darauf. Welche Fassungen eine Korrektur bekommen, nämlich
nur die jeweils neueste, und wie sie ausgeliefert wird, steht in der
[SECURITY.md](https://github.com/OpenGewerk/.github/blob/main/SECURITY.md) der
Organisation.

## Reverse Proxy

Vor die Anwendung gehört ein Reverse Proxy mit TLS. Sie lauscht absichtlich nur
auf `127.0.0.1`: eine Anwendung, die Rechnungen führt, steht nicht
unverschlüsselt im Netz. Das hält Docker erst ab Engine 28.3.3: Vor 28.0.0
erreichen Rechner im selben Netzsegment auch einen Port auf `127.0.0.1`, und 28.2.0 bis
28.3.2 öffnen ihn nach einem Neuladen von firewalld wieder (CVE-2025-54388). Zwei Vorlagen liegen unter `docker/proxy/`, auch im
Installationspaket: [`apache.conf`](../docker/proxy/apache.conf) für Apache 2.4
und [`nginx.conf`](../docker/proxy/nginx.conf) für nginx. Jede ist für sich
vollständig, mit der Weiterleitung von HTTP auf HTTPS, dem Zertifikat unter dem
Pfad, den certbot anlegt, dem Proxy auf `127.0.0.1:23700` samt Host, Protokoll
und `X-Forwarded-For`, den Grenzen je Pfad und einer Zeitgrenze für lange
Drucke. Wie sie eingesetzt wird, steht in ihrem Kopf, und jede Zeile, die zur
eigenen Instanz passen muss, trägt einen Kommentar; der Name darin ist
`opengewerk.example.org`. Die CI prüft beide bei jedem Pull Request mit
`nginx -t` und `httpd -t`, jeweils in der ältesten Fassung, die eine noch
unterstützte Distribution mitbringt, und in der neuesten
(`docker/test-proxy.sh`).

Was darüber hinaus zu wissen ist, auch für einen anderen Proxy wie Caddy:

- **Der Proxy ergänzt `X-Forwarded-For`, statt es durchzureichen.** Die
  Grenzen je Adresse, etwa fünf falsche Passwörter in der Minute, zählen nach
  dem letzten Eintrag dieses Headers, denn die Verbindung selbst kommt für jede
  Anfrage vom Proxy. Der letzte Eintrag ist der, den der Proxy selbst anhängt;
  was ein Client davor schreibt, zählt nicht. Eine IPv6-Adresse zählt mit ihrem
  ganzen /64. Reicht der Proxy den Header nur weiter, wählt ein Client seine
  Adresse selbst, und alle Anfragen ohne den Header zählen zusammen in einem
  Zähler, mit derselben Grenze wie eine Adresse: dann sperren wenige
  Fehlversuche eines Fremden die Anmeldung für alle. Die Anwendung schreibt das
  beim ersten Mal als Warnung ins Log. Apache mit `ProxyPass` und Caddy hängen
  von sich aus an, nginx nur mit
  `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`. Die Vorlage
  für nginx hat die Zeile im `server`-Block. Bekommt dort ein `location`-Block
  ein eigenes `proxy_set_header`, erbt er die Zeilen des `server`-Blocks nicht
  mehr und braucht alle selbst.

  Ob es stimmt, zeigt nach einer Anmeldung „Konto“ unter „Angemeldete Geräte“:
  dort steht beim eigenen Gerät die Netzadresse, von der es kam. Steht dort
  keine, ergänzt der Proxy den Header nicht.
- **Der Proxy begrenzt Anfragen je Pfad: groß nur für Dateien und den
  Postausgang.** Eine Datei für die Ablage an `/files/` darf 25 MB haben und
  eine Übertragung des Postausgangs an `POST /sync` 8 MB. Beide liest die
  Anwendung erst, wenn feststeht, wer sie schickt, und die Grenze, die für einen
  Betrieb gilt, setzt sie selbst, mit einem Satz dazu; der Proxy lässt dort
  50 MB durch. Überall sonst reichen 2 MB: das Größte dort ist das Logo im
  Briefkopf mit 1 MB, die Anmeldung unter `/api/auth/` nimmt höchstens 64 kB an
  und jede andere Route 100 kB. So erreicht ein großer Körper ohne Anmeldung die
  Anwendung gar nicht erst. nginx nimmt ohne Angabe nur 1 MB an, Caddy hat keine
  Grenze. Apache wendet `LimitRequestBody` auf eine Anfrage, die es mit
  `ProxyPass` weiterreicht, gar nicht an; die Vorlage vergleicht deshalb mit
  mod_rewrite die Länge, die eine Anfrage angibt. Eine Anfrage ohne Angabe der
  Länge lässt Apache so durch, für sie gelten die Grenzen der Anwendung. Was der
  Proxy ablehnt, kommt als 413 ohne Satz an, und ein Postausgang, der daran
  scheitert, bleibt hängen, bis der Proxy es durchlässt.
- **Ein Druck darf dauern.** Der Renderer bekommt für ein PDF bis zu
  60 Sekunden, und genau so lange wartet nginx ohne Angabe auf eine Antwort,
  bevor es mit 504 abbricht; Apache wartet so lange wie sein `Timeout`, von Haus
  aus ebenfalls 60 Sekunden. Die Vorlagen warten 300 Sekunden.
- **Die Sicherheits-Header setzt die Anwendung selbst, der Proxy setzt sie kein
  zweites Mal.** Jede Antwort trägt `X-Content-Type-Options`, `Referrer-Policy`,
  `X-Frame-Options`, `Strict-Transport-Security` und die beiden
  `Cross-Origin`-Header, die Hüllen dazu die `Content-Security-Policy`
  (`packages/platform/server/src/api/security-headers.ts`). Doppelt gilt nicht einfach der
  strengere Wert: von zwei HSTS-Headern liest ein Browser nur den ersten, von
  zwei Referrer-Policies die letzte, und eine zweite Content-Security-Policy aus
  dem Proxy kann nur noch verbieten, was die Anwendung braucht. Setzt der Proxy
  von sich aus Sicherheits-Header, etwa über eine globale Vorgabe, nimmt er sie
  für diese Instanz heraus. Soll HSTS länger gelten oder Subdomains
  einschließen, ersetzt er den Wert, statt einen zweiten Header zu schicken. Ob
  jeder genau einmal ankommt, zeigt `curl -sI https://<adresse>/`.
- **Was ein Browser von einer Antwort behalten darf, sagt ebenfalls die
  Anwendung.** Jede Antwort trägt `Cache-Control: no-store`, nur die gebauten
  Dateien der Oberfläche nicht: die Dateien mit Prüfsumme im Namen dürfen ein
  Jahr bleiben, die beiden Hüllen, das Manifest und der Service Worker tragen
  `no-cache`. Eine Antwort der API enthält Personen, Datensätze und Dateien, und
  das Abmelden löscht die Daten auf dem Gerät, den HTTP-Cache des Browsers aber
  nicht. Der Proxy speichert deshalb keine Antwort der Anwendung zwischen und
  ersetzt `Cache-Control` nicht. Prüfen lässt es sich mit
  `curl -sI https://<adresse>/health`, das `cache-control: no-store` zeigen muss.

## Was beim Aufsetzen sonst noch Zeit kostet

- **Das Volume gehört auf `/var/lib/postgresql`, nicht auf `.../data`.** Die
  Abbilder ab PostgreSQL 18 legen die Daten in einem Unterverzeichnis je
  Hauptversion ab, damit ein späteres `pg_upgrade --link` nicht über eine
  Mount-Grenze stolpert. Auf dem alten Pfad startet der Container gar nicht
  erst, mit einer langen Meldung, in der die eine entscheidende Zeile
  untergeht.
- **Die `.env` ist die einzige Datei mit Zugangsdaten.** `chmod 600`, und sie
  bleibt draußen aus dem Repository.
- **Ein Paket entpackt root mit `tar --no-same-owner`.** Ohne die Option
  übernimmt tar als root die Kennung aus dem Paket, für jede Datei und jeden
  Ordner, beim Update auch für die, die schon da sind; im Paket von 0.1.0 war das
  die des Rechners, der es gebaut hat (#214). Seitdem gehört im Paket jeder
  Eintrag root, und der Workflow "Release" prüft das, bevor er das Paket
  hochlädt. Die Option schadet trotzdem nie.
