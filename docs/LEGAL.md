# Rechtliche Einordnung & Ownership-Verifikation

*(As of research: 2026-07-12 — no legal advice)*

## Basic principle: Engine yes, assets no

This project follows the established model of engine reimplementations
(OpenMW, OpenRA, openage, OpenTTD, ScummVM):

1. **Own code**: The engine is a new development in TypeScript.
   There will be no original code, no decompiled binary and no
   Original asset transferred to the repo or distributed.
2. **Bring your own assets**: models, textures, blueprints, maps and
   Sounds are created **locally** at runtime from the one purchased by the user
   Installation read. Nothing is uploaded, bundled or cached
   distributed. The `.gitignore` additionally blocks asset formats.
3. **Interoperability**: Reading proprietary file formats for the purpose
   interoperability is permissible according to established case law
   (EU: Art. 6 Software-RL / § 69e UrhG; US: Sega v. Accolade u. a.).
   The parsers implemented here are based on publicly documented ones
   Formats (GPG-Mod-SDK, community documentation) and your own analysis of your own,
   gekauften Spieldateien.

Against the large bring-your-own-assets projects, there are no successful ones
Takedowns known; OpenMW has even reached an amicable agreement with Bethesda.

## Präzedenz speziell für FA: FAForever

FAForever (FAF) has been requiring a **Steam/GOG account link** as for years
Proof of ownership (“for legal reasons”) and is used by the rights holders since
tolerated for over a decade - although FAF goes much further than this
Project (distribution of patched binaries and game data patches).

## Ownership-Verifikation (geplanter Flow)

Gestaffelt, FAF-Vorbild:

| stage | Proof | Status |
| ----- | -------- | ------ |
| 1 | **Local installation available** — the app only works if the user provides their installation directory with the SCD archives. Whoever has the files has the game. | ✅ implemented (single asset source) |
| 2 | **Steam link**: Login via Steam OpenID (`steamcommunity.com/openid`) → Server checks via `IPlayerService/GetOwnedGames` whether app ID **9420** (SupCom:FA) is in the library. To do this, the profile must be public for a short time (identical to FAF's flow). `ISteamUser/CheckAppOwnership` would be cleaner, but is reserved for publishers. | planned (needs small server + API key) |
| 3 | **GOG link**: same as FAF (GOG account link). | planned |

Note: Level 2/3 are for multiplayer/community features. For the
local use, level 1 is the practical and usual standard for everyone
Reimplementierungsprojekte.

## Umgang mit faf-re

The reconstructed engine repo (`faf-re`) is reverse engineered
the binary won - legally a different category than new clean room building.
Consequence for this project:

- faf-re serves as a **behavioral reference** (formulas, processes, semantics,
  data structures) — like a specification.
- **No code transfer**: No reconstructed C++ code (not even
  translated/ported 1:1) into this repo. Behavior becomes from the
  Reference understood and implemented independently.
- Game rules/balance come from the (locally read) Lua and
  Blueprint files of the game itself.

## IP-Situation

Supreme Commander: Forged Alliance (2007, Gas Powered Games / THQ). The
Marken-/Publishingrechte liegen heute im Nordic/Embracer-Umfeld (THQ Nordic);
the game will continue to be sold on Steam/GOG. Sales link instead
Asset download is also the right strategy for this reason: Every user has this
Project is an additional buyer of the original.

## Quellen

- [Steamworks: User Authentication and Ownership](https://partner.steamgames.com/doc/features/auth)
- [Steamworks: IPlayerService/GetOwnedGames](https://partner.steamgames.com/doc/webapi/iplayerservice)
- [FAF: What is Steam link/GOG link, why is it required?](ZZPROTECT0ZZ)
- [FAF: Why do I need to link my account?](ZZPROTECT0ZZ)
- [OpenMW-Forum: Rechtslage von Engine-Reimplementierungen](ZZPROTECT0ZZ)
- [Wikipedia: List of game engine recreations](https://en.wikipedia.org/wiki/List_of_game_engine_recreations)
- [openage README (Asset-Policy)](https://github.com/SFTtech/openage/blob/master/README.md)
