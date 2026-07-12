# Rechtliche Einordnung & Ownership-Verifikation

*(Stand der Recherche: 2026-07-12 — keine Rechtsberatung)*

## Grundprinzip: Engine ja, Assets nein

Dieses Projekt folgt dem etablierten Modell der Engine-Reimplementierungen
(OpenMW, OpenRA, openage, OpenTTD, ScummVM):

1. **Eigener Code**: Die Engine ist eine Neuentwicklung in TypeScript.
   Es wird kein Original-Code, keine dekompilierte Binary und kein
   Original-Asset ins Repo übernommen oder verteilt.
2. **Bring your own assets**: Modelle, Texturen, Blueprints, Karten und
   Sounds werden zur Laufzeit **lokal** aus der vom User gekauften
   Installation gelesen. Nichts wird hochgeladen, gebündelt oder gecacht
   verteilt. Die `.gitignore` blockiert Asset-Formate zusätzlich.
3. **Interoperabilität**: Das Einlesen proprietärer Dateiformate zum Zweck
   der Interoperabilität ist nach gefestigter Rechtsprechung zulässig
   (EU: Art. 6 Software-RL / § 69e UrhG; US: Sega v. Accolade u. a.).
   Die hier implementierten Parser beruhen auf öffentlich dokumentierten
   Formaten (GPG-Mod-SDK, Community-Doku) und eigener Analyse der eigenen,
   gekauften Spieldateien.

Gegen die großen Bring-your-own-assets-Projekte sind keine erfolgreichen
Takedowns bekannt; OpenMW hat sich mit Bethesda sogar gütlich abgestimmt.

## Präzedenz speziell für FA: FAForever

FAForever (FAF) verlangt seit Jahren einen **Steam-/GOG-Account-Link** als
Besitznachweis („for legal reasons") und wird von den Rechteinhabern seit
über einem Jahrzehnt geduldet — obwohl FAF deutlich weiter geht als dieses
Projekt (Verteilung gepatchter Binaries und Spieldaten-Patches).

## Ownership-Verifikation (geplanter Flow)

Gestaffelt, FAF-Vorbild:

| Stufe | Nachweis | Status |
| ----- | -------- | ------ |
| 1 | **Lokale Installation vorhanden** — die App funktioniert nur, wenn der User sein Installationsverzeichnis mit den SCD-Archiven bereitstellt. Wer die Dateien hat, hat das Spiel. | ✅ implementiert (einzige Asset-Quelle) |
| 2 | **Steam-Link**: Login via Steam OpenID (`steamcommunity.com/openid`) → Server prüft per `IPlayerService/GetOwnedGames`, ob App-ID **9420** (SupCom:FA) in der Bibliothek ist. Profil muss dafür kurzzeitig öffentlich sein (identisch zu FAFs Flow). `ISteamUser/CheckAppOwnership` wäre sauberer, ist aber Publishern vorbehalten. | geplant (braucht kleinen Server + API-Key) |
| 3 | **GOG-Link**: wie FAF (GOG-Account-Verknüpfung). | geplant |

Hinweis: Stufe 2/3 sind für Multiplayer/Community-Features gedacht. Für die
lokale Nutzung ist Stufe 1 der praktikable und übliche Standard aller
Reimplementierungsprojekte.

## Umgang mit faf-re

Das rekonstruierte Engine-Repo (`faf-re`) ist per Reverse Engineering aus
der Binary gewonnen — rechtlich eine andere Kategorie als Clean-Room-Neubau.
Konsequenz für dieses Projekt:

- faf-re dient als **Verhaltensreferenz** (Formeln, Abläufe, Semantik,
  Datenstrukturen) — wie eine Spezifikation.
- **Kein Code-Transfer**: Es wird kein rekonstruierter C++-Code (auch nicht
  übersetzt/1:1 portiert) in dieses Repo übernommen. Verhalten wird aus der
  Referenz verstanden und eigenständig implementiert.
- Spielregeln/Balance stammen ohnehin aus den (lokal gelesenen) Lua- und
  Blueprint-Dateien des Spiels selbst.

## IP-Situation

Supreme Commander: Forged Alliance (2007, Gas Powered Games / THQ). Die
Marken-/Publishingrechte liegen heute im Nordic/Embracer-Umfeld (THQ Nordic);
das Spiel wird weiterhin auf Steam/GOG verkauft. Verkaufslink statt
Asset-Download ist auch deshalb die richtige Strategie: Jeder Nutzer dieses
Projekts ist ein zusätzlicher Käufer des Originals.

## Quellen

- [Steamworks: User Authentication and Ownership](https://partner.steamgames.com/doc/features/auth)
- [Steamworks: IPlayerService/GetOwnedGames](https://partner.steamgames.com/doc/webapi/iplayerservice)
- [FAF: What is Steam link/GOG link, why is it required?](https://forum.faforever.com/topic/3800/what-is-steam-link-gog-link-why-is-it-required-and-how-do-i-do-it)
- [FAF: Why do I need to link my account?](https://forum.faforever.com/topic/252/why-do-i-need-to-link-my-account-to-steam-or-gog-com/1)
- [OpenMW-Forum: Rechtslage von Engine-Reimplementierungen](https://forum.openmw.org/viewtopic.php?t=7561)
- [Wikipedia: List of game engine recreations](https://en.wikipedia.org/wiki/List_of_game_engine_recreations)
- [openage README (Asset-Policy)](https://github.com/SFTtech/openage/blob/master/README.md)
