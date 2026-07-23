# Legal classification & ownership verification

*(Research status: 2026-07-12 — not legal advice)*

## Basic principle: engine yes, assets no

This project follows the established model for engine reimplementations
(OpenMW, OpenRA, openage, OpenTTD, ScummVM):

1. **Own code**: The engine is a new TypeScript development. No original code,
   decompiled binary, or original asset is brought into or distributed from the
   repository.
2. **Bring your own assets**: models, textures, blueprints, maps, and sounds
   are read **locally** at runtime from the user's purchased installation.
   Nothing is uploaded, bundled, or distributed from a cache. `.gitignore`
   additionally blocks asset formats.
3. **Interoperability**: Reading proprietary file formats for interoperability
   is permitted under established case law (EU: Art. 6 Software-RL / § 69e
   UrhG; US: Sega v. Accolade et al.). The parsers implemented here are based
   on publicly documented formats (GPG Mod SDK, community documentation) and
   independent analysis of purchased game files.

No successful takedowns against the large bring-your-own-assets projects are
known; OpenMW has even reached an amicable agreement with Bethesda.

## FA-specific precedent: FAForever

FAForever (FAF) has required a **Steam/GOG account link** as proof of
ownership (“for legal reasons”) for years, and rights holders have tolerated
it for more than a decade — even though FAF goes considerably further than
this project (distributing patched binaries and game-data patches).

## Ownership verification (planned flow)

Tiered, following the FAF model:

| Tier | Proof | Status |
| ---- | ----- | ------ |
| 1 | **Local installation available** — the app works only when the user provides their installation directory containing the SCD archives. Whoever has the files has the game. | ✅ implemented (the only asset source) |
| 2 | **Steam link**: Login via Steam OpenID (`steamcommunity.com/openid`) → the server checks through `IPlayerService/GetOwnedGames` whether app ID **9420** (SupCom:FA) is in the library. The profile must be public briefly (identical to FAF's flow). `ISteamUser/CheckAppOwnership` would be cleaner, but is reserved for publishers. | planned (requires a small server + API key) |
| 3 | **GOG link**: as in FAF (GOG account linking). | planned |

Note: tiers 2/3 are intended for multiplayer/community features. For local use,
tier 1 is the practical and usual standard for all reimplementation projects.

## Handling faf-re

The reconstructed engine repository (`faf-re`) was obtained through reverse
engineering of the binary — legally, it is a different category from a
clean-room reimplementation. The consequence for this project:

- faf-re serves as a **behavioral reference** (formulas, processes, semantics,
  data structures) — like a specification.
- **No code transfer**: no reconstructed C++ code (including translated or
  1:1-ported code) is brought into this repository. Behavior is understood from
  the reference and implemented independently.
- Game rules/balance come from the game's own Lua and blueprint files, which
  are read locally.

## IP situation

Supreme Commander: Forged Alliance (2007, Gas Powered Games / THQ). Trademark
and publishing rights are now in the Nordic/Embracer sphere (THQ Nordic); the
game continues to be sold on Steam/GOG. A sales link instead of an asset
download is therefore also the right strategy: every user of this project is
an additional purchaser of the original.

## Sources

- [Steamworks: User Authentication and Ownership](https://partner.steamgames.com/doc/features/auth)
- [Steamworks: IPlayerService/GetOwnedGames](https://partner.steamgames.com/doc/webapi/iplayerservice)
- [FAF: What is Steam link/GOG link, why is it required?](https://forum.faforever.com/topic/3800/what-is-steam-link-gog-link-why-is-it-required-and-how-do-i-do-it)
- [FAF: Why do I need to link my account?](https://forum.faforever.com/topic/252/why-do-i-need-to-link-my-account-to-steam-or-gog-com/1)
- [OpenMW forum: legal status of engine reimplementations](https://forum.openmw.org/viewtopic.php?t=7561)
- [Wikipedia: List of game engine recreations](https://en.wikipedia.org/wiki/List_of_game_engine_recreations)
- [openage README (asset policy)](https://github.com/SFTtech/openage/blob/master/README.md)
