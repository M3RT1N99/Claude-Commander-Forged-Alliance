# agent6

## Summary
faf-re enthält das komplette Lockstep-/Session-/Replay-/Save-System des Moho-Engines in rekonstruiertem C++. Synchronisiert wird ausschließlich ein Command-Stream (24 Opcodes, ECmdStreamOp 0–23) als Message-Broadcast über ein Voll-Mesh von Peers; Desync-Erkennung läuft über MD5-Checksummen pro Beat (CMDST_VerifyChecksum, 128-Beat-Ringpuffer). Replays sind exakt derselbe Command-Stream, byte-identisch mitgeschrieben von CDecoder, mit einem gut dokumentierten Header ("Replay v1.9"); .fafreplay ist nur ein Container (JSON-Zeile + zlib/base64 bzw. zstd) um genau dieses .scfareplay. Save/Load nutzt das Reflection-Archivsystem (gpg::RType/ReadArchive/WriteArchive) und serialisiert die gesamte Sim (Sim::SaveState) — 89 Serializer-Klassen, 240 TypeInfos.

## Key Facts
- Lockstep synchronisiert NUR Befehle: 24 Opcodes in ECmdStreamOp (0=Advance, 1=SetCommandSource, 3=VerifyChecksum, 12=IssueCommand, 22=LuaSimCallback, 23=EndGame) — keine Entity-States über den Draht.
- Wire-Format ist einheitlich: [u8 type][u16 LE size inkl. 3-Byte-Header][payload] (CMessage, mBuff[0..2]); dieselbe Codierung für Sim-Ops (0–49), Client-Control (50–59), Lobby (100–119) und Verbindungs-Events (200–209).
- Kein Host-Relay: CClientManagerImpl::ProcessClients broadcastet jede Message an ALLE Clients (CLocalClient → eigene Pipe, CNetClient → eigene Verbindung); Vollvermaschtes P2P, Lobby via CLobby (UDP:15000-Discovery, TCP/UDP-Connector).
- Beat-Mechanik: Jeder Client hat eine eigene Pipe + Beats (mQueuedBeat/mDispatchedBeat); DoBeat() berechnet mPartiallyQueuedBeat/mFullyQueuedBeat/mAvailableBeat, UpdateStates(beat) drained alle Pipes bis beat und dispatcht dann CMDST_Advance(1) an die Sim.
- Ack-Mechanik: jedes eingehende CMDST_Advance erzeugt CLIMSG_Ack(clientIndex, queuedBeat), das an ALLE Clients gebroadcastet wird; jeder Client hält mLatestAckReceived[N] (Ack-Matrix N×N) — daraus IsReadyForBeat(beat) und EveryoneResponsiveSince(beat).
- Desync: Sim::UpdateChecksum() faltet jeden Beat Economy, dirty Entities (id, health, blueprint, orientation+pos 0x1C, velocity) und den kompletten MT19937-RNG-State in einen MD5-Context; mSimHashes[beat & 0x7F] ist ein 128-Beat-Ring; Sim::VerifyChecksum vergleicht und legt SDesyncInfo{beat, army, hash1, hash2} an.
- Command-Source-Autorisierung: jeder Client darf nur seine BVIntSet mValidCommandSources beanspruchen; unautorisiertes CMDST_SetCommandSource verwirft alle Folgebefehle dieses Clients (Anti-Cheat/Anti-Spoof im Lockstep).
- Eject/Timeout: CLIMSG_Eject(requesterIndex, afterBeat) — jeder Client sammelt Eject-Requests; ein eject-pending Client blockiert das Beat-Advance nicht mehr, beim Erreichen des Eject-Beats wird CMDST_CommandSourceTerminated in den Sim-Stream geschrieben.
- Session-Start-Parameter stecken in LaunchInfoBase (GameMods, ScenarioInfo als serialisierter Lua-String, vector<ArmyLaunchInfo> mit UnitSources-Bitset, SLaunchCommandSources, CheatsEnabled) + LaunchInfoNew (mStrVec = Lua-PlayerOptions pro Army, mInitSeed = RNG-Seed).
- SWldSessionInfo (mMapName, mLaunchInfo, mIsBeingRecorded, mIsReplay, mIsMultiplayer, mClientManager, mSourceId) ist das eine Bootstrap-Objekt für alle drei Pfade: CLobby::LaunchGame (MP), WLD_SetupSessionInfo (SP-Lua), VCR_SetupReplaySession (Replay), CSavedGame::CreateSinglePlayerSessionInfo (Load).
- Replay-Body == mitgeschriebener Dispatch-Stream: CDecoder::ReceiveMessage kopiert die rohen Wire-Bytes 1:1 in den CSimDriver-Stream, bevor es decodiert — Replay-Abspielen ist Einspeisen derselben Bytes über CReplayClient als Pseudo-Client 0.
- Replay-Header (SCFAreplay v1.9) exakt aus VCR_SetupReplaySession rekonstruiert: strz version, strz '\r\n', 13 Bytes 'Replay v1.9\r\n', strz mapfile, 4 Bytes, u32+bytes GameMods (Lua-Bytestream), u32+bytes ScenarioInfo, u8 numSources {strz name, i32 timeouts}, u8 cheats, u8 numArmies {u32+bytes PlayerOptions, u8-Liste bis 0xFF}, i32 seed.
- Save = Reflection-Archiv: 0x2028-Byte Dateikopf (Magic 'RGMH' 0x484D4752, Version 1, Preview-Offset/Size, GUID, UTF-16 App-/Session-Name), dann SSavedGameHeader (Version 20) und dann archive->Write(Sim::sType, sim) — die gesamte Sim inkl. Lua-State wird über RType-Serializer geschrieben.
- Chat läuft NICHT über den Sim-Stream: CLIMSG_ReceiveChat (Lua-Objekt als Bytestream, max 0x400 Bytes) geht per Client-Broadcast raus und wird über IClientMgrUIInterface::ReceiveChat an die UI geliefert — deshalb desync-neutral. Diplomatie/Allianz (EAlliance, CArmyImpl::SetAlliance) läuft dagegen als CMDST_LuaSimCallback IN der Sim.
- .fafreplay ist nur ein Container: erste Zeile = JSON-Header (\n-terminiert), danach v1 = base64→(4 Byte Größe überspringen)→zlib, v2 = zstd; entpackt ergibt sich exakt der oben beschriebene .scfareplay-Stream.

## Details
## 1. Lockstep-Modell

### Was synchronisiert wird
**Nur Befehle.** Kein State-Sync. Der gesamte Netzwerkverkehr im Spiel ist ein Strom von `CMessage`-Objekten. Die Sim ist deterministisch und wird auf jedem Peer identisch durch den gleichen Command-Stream getrieben.

### Wire-Format (`CMessage`, `moho/net/CMessage.h`)
```
byte 0    : u8   message type
bytes 1-2 : u16 LE  gesamte Wire-Größe (Header 3 + Payload)
bytes 3.. : payload
```
`CMessageStream` ist ein `gpg::Stream`-View auf den Payload; Schreiben/Lesen über `gpg::BinaryReader`. Strings sind entweder NUL-terminiert (`ReadString`) oder u32-längenpräfigiert (`ReadLengthPrefixedString`). LuaObjects werden mit `LuaObject::ToByteStream` in einen typisierten Bytestream serialisiert (Typtags: 0=float, 1=string, 2=nil, 3=bool, 4=table, 5=end).

### Message-ID-Räume (`NetMessageRanges.h`, halboffene Bereiche)
| Bereich | Enum | Zweck |
|---|---|---|
| 0–49 | `ECmdStreamOp` | Sim-Command-Stream (nur 0–23 belegt) |
| 50–59 | `EClientMsg` | Client-/Replay-Control |
| 100–119 | `ELobbyMsg` | Lobby-Handshake |
| 200–209 | `ELobbyMsg` | Connection-Lifecycle-Events |

**ECmdStreamOp (0–23)** — vollständig dokumentiert inkl. Payload in `ECmdStreamOp.h`:
`0 Advance(u32 beats)`, `1 SetCommandSource(u8)`, `2 CommandSourceTerminated()`, `3 VerifyChecksum(MD5Digest, u32 beat)`, `4 RequestPause`, `5 Resume`, `6 SingleStep`, `7 CreateUnit(u8 army, string bp, f x, f z, f heading)`, `8 CreateProp`, `9 DestroyEntity`, `10 WarpEntity`, `11 ProcessInfoPair`, `12 IssueCommand(u32 count, EntId[], CmdData, u8 clear)`, `13 IssueFactoryCommand`, `14/15 In/DecreaseCommandCount`, `16 SetCommandTarget`, `17 SetCommandType`, `18 SetCommandCells`, `19 RemoveCommandFromQueue`, `20 DebugCommand`, `21 ExecuteLuaInSim(string)`, `22 LuaSimCallback(string, LuaObject, EntId[])`, `23 EndGame`.

**EClientMsg (50–57):** `50 Ack(u8 clientIndex, i32 beat)`, `51 Dispatched(i32)`, `52 Available(i32)`, `53 Ready`, `54 Eject(u8 requester, i32 afterBeat)`, `55 ReceiveChat(bytes)`, `56 AdjustSimSpeed(i32 clock, i32 rate)`, `57 IntParam(i32)`.

### Encoder / Decoder
- **`CMarshaller`** (`CClientManagerImpl.h:22`) implementiert `ICommandSink` und ist der *Encoder*: jede Methode baut eine `CMessage` mit dem passenden Opcode und ruft `ProcessClients(msg)`.
- **`CDecoder`** (`moho/misc/CDecoder.h`) implementiert `IMessageReceiver` und ist der *Decoder*: `ReceiveMessage` → `DecodeMessage` → per-Opcode-Decode → `ICommandSink*` (das ist die `Sim`).
- Beide Seiten sind symmetrisch; `WriteEntIdSet`/`WriteCommandData`/`WriteTarget`/`WriteCells` bzw. `DecodeEntIdSet`/`DecodeCommandData`/… definieren die exakte Payload-Byte-Reihenfolge.

### Topologie: Voll-Mesh, kein Host-Relay
`CClientManagerImpl::ProcessClients(msg)` iteriert **alle** `mClients` und ruft `client->Process(msg)`:
- `CLocalClient::Process` → `CClientBase::Process` → hängt Bytes an die **eigene** Pipe (Loopback).
- `CNetClient::Process` → schreibt die Message direkt auf **seine** `INetConnection` (eine Verbindung pro Peer).
- Eingehend: `CNetClient::ReceiveMessage` → `CClientBase::Process` → Bytes landen in der Pipe **dieses** Clients.

Ergebnis: pro Peer eine eigene FIFO-Pipe mit dessen Command-Stream. Der lokale Spieler broadcastet also direkt an alle.

### Beat/Ack-Mechanik
Zustand pro Client (`CClientBase`, `CClientBase.h:294–308`):
`mQueuedBeat` (wieviel dieser Peer gesendet hat), `mDispatchedBeat` (wieviel davon in die Sim ging), `mAvailableBeatRemote`, `mLatestAckReceived: vector<i32>` (Größe = Anzahl Clients → **N×N-Ack-Matrix**), `mLatestBeatDispatchedRemote`, `mEjectPending/mEjected`, `mValidCommandSources` (BVIntSet), `mCommandSourceId`, `mSimRate` (Default 50).

Ablauf (`CClientBase::Process`, `CClientBase.cpp:189`):
1. Message-Typ < 50 (Sim-Op) → in die Pipe anhängen. Bei `CMDST_Advance`: `mQueuedBeat += delta` und **sofort** ein `CLIMSG_Ack(mIndex, mQueuedBeat)` erzeugen und über `mManager->ProcessClients()` an alle broadcasten.
2. `CLIMSG_Ack` → `mLatestAckReceived[ackClientIndex] = beat` (out-of-order wird verworfen + geloggt).
3. `CLIMSG_Dispatched`/`CLIMSG_Available` → monoton aktualisieren.

`CClientManagerImpl::DoBeat()` (`CClientManagerImpl.cpp:878`) pro Frame:
- `mConnector->Pull()` (Netzwerk drainen)
- Readiness: alle Clients `mReady` → `mEveryoneIsReady`
- `mPartiallyQueuedBeat`, `mFullyQueuedBeat` hochzählen solange alle nicht-ejecteten Clients bis dahin Daten geliefert haben
- `mAvailableBeat` hochzählen solange `EveryoneResponsiveSince(beat)` (= jeder Client `IsReadyForBeat`) → dann `CLIMSG_Available(mAvailableBeat)` broadcasten
- Bottleneck-Analyse (`GetBottleneckInfo`: Nothing/Readiness/Data/Ack + Menge der schuldigen Clients) → UI-Callback nach 5 s
- Falls Client[0] ein `CReplayClient` ist: `Start()` (Replay nachfüllen)

`IsReadyForBeat(beat)` (`CClientBase.cpp:659`): der Client blockiert, wenn irgendein Peer `mLatestAckReceived[peer] < beat` hat (außer der Peer ist ejected/eject-pending). Das ist der eigentliche Lockstep-Barrier: **jeder muss jedem geackt haben.**

`CClientManagerImpl::UpdateStates(beat)` (`:994`): für jeden Client `UpdateState(beat, marshaller, &mStream)` → drained dessen Pipe bis `mDispatchedBeat == beat`, prüft dabei Command-Source-Autorisierung, schreibt autorisierte Messages in den gemeinsamen `mStream`. Danach `CLIMSG_Dispatched(beat)` broadcasten, `mStream` leeren und jede Message per `Dispatch()` (CMessageDispatcher → CDecoder → Sim) einspeisen, abschließend ein synthetisches `CMDST_Advance(1)`.

Getrieben wird das von `CSimDriver::ExecuteDispatchStepLocked` (`SimDriver.cpp:908`): `mDispatchBeat++` → `mClientManager->UpdateStates(beat)` → `FinalizeSyncDispatchLocked()` (Sim::Sync + Checksum) → Sim-Rate-Schätzung aus der Median-Dispatch-Dauer → ggf. `SetSimRate`.

### Command-Source-Autorisierung (wichtig für Sicherheit)
`CClientBase::UpdateState` (`CClientBase.cpp:385`) beim Drainen der Peer-Pipe:
- `CMDST_SetCommandSource(id)`: wenn `id ∉ mValidCommandSources` → Warnung „claiming command source X, but not authorized" und **alle folgenden Befehle dieses Clients werden verworfen** (`hasCommandSource = false`).
- Nur autorisierte Messages werden in den Output-Pipe geschrieben, jeweils mit vorangestelltem `CMDST_SetCommandSource`, wenn sich die Quelle geändert hat.
- `CMDST_CommandSourceTerminated` entfernt die Source aus dem Set.

### Desync-Erkennung
- `Sim::UpdateChecksum()` (`Sim.cpp:8499`) läuft jeden Beat (Convar `ChecksumPeriod`, Default 1) und faltet in einen persistenten `gpg::MD5Context`:
  - pro Army: `SEconTotals` (Stored/Income/Reclaimed/LastUseRequested/LastUseActual/MaxStorage), alle 100 Beats zusätzlich `ReconDB::UpdateSimChecksum()`
  - pro dirty Entity: `id (u32)`, `health (f32)`, Blueprint-ID-String, `Orientation` + Position (0x1C Bytes am Stück), Velocity (Vec3f)
  - kompletter MT19937-State (`0x9C0` Bytes) + Marsaglia-Pair-Flag/Wert
- Ergebnis landet im Ring `mSimHashes[128]`; `Sim::GetBeatChecksum(out, beat)` liest `mSimHashes[beat & 0x7F]`.
- `CSimDriver::FinalizeSyncDispatchLocked` (`SimDriver.cpp:851`) sendet nach jedem Sync für den publizierten Beat (falls Digest ≠ 0) ein `CMDST_VerifyChecksum(digest, beat)` in den Command-Stream → also an alle Peers.
- Empfangsseitig `Sim::VerifyChecksum` (`Sim.cpp:9757`): ignoriert Beats älter als 128 oder in der Zukunft; bei Mismatch `mDesyncs.push_back(SDesyncInfo{beat, army, localHash, remoteHash})` + Warnung `"Checksum for beat %d mismatched: %s (sim) != %s (%s)"`, `mIsDesyncFree = false`. Pro Beat gibt es optional ein Log-File `<prefix>beatNNNNN.log` mit dem Digest nach jedem Hash-Schritt (Desync-Bisektion).

### Sim-Rate / Game-Speed
- `mGameSpeed`, `mGameSpeedClock`, `mGameSpeedRequester`, `mAdjustableGameSpeed` im Manager. `SetSimRate(rate)` broadcastet `CLIMSG_AdjustSimSpeed(clock+1, rate)`; `ApplyIncomingGameSpeedRequest` gewinnt bei höherer Clock, Gleichstand → niedrigerer Client-Index. Deterministische Arbitrierung ohne Host.
- `GetSimRate()` = Minimum über alle nicht-eject-pending Clients (langsamster Rechner bremst).
- Lobby-`GameOptions.GameSpeed`: `"fast"` → 4, `"adjustable"` → adjustable=true, sonst 0.

## 2. Session-Start

### `SWldSessionInfo` (`moho/sim/WldSessionInfo.h`, 0x30 Bytes)
`mMapName`, `shared_ptr<LaunchInfoBase> mLaunchInfo`, `mIsBeingRecorded`, `mIsReplay`, `mIsMultiplayer`, `IClientManager* mClientManager`, `u32 mSourceId`. Das ist das einzige Objekt, das an `WLD_BeginSession()` geht.

### `LaunchInfoBase` (`moho/misc/LaunchInfoBase.h`) — die Sim-Startparameter
```
RRuleGameRules* mGameRules      +0x04
STIMap*         mMap            +0x08
string          mGameMods       +0x0C   (Lua-serialisiert)
string          mScenarioInfo   +0x28   (Lua-serialisiert: map, Options, teams, ...)
vector<ArmyLaunchInfo> mArmyLaunchInfo +0x44  (je Army: BVIntSet mUnitSources)
SLaunchCommandSources mCommandSources  +0x54 (vector<SSTICommandSource>{index,name,timeouts}, mOriginalSource)
string          mLanguage       +0x6C
bool            mCheatsEnabled  +0x88
```
`LaunchInfoNew` ergänzt: `vector<string> mStrVec` (+0x90, die Lua-serialisierten PlayerOptions pro Army) und `i32 mInitSeed` (+0xA0, RNG-Seed). `LaunchInfoLoad` ergänzt stattdessen `gpg::ReadArchive* mReadArchive` + `shared_ptr<SSessionSaveData>` (Savegame-Pfad).

### Die vier Einstiegspunkte
1. **Multiplayer:** `CLobby::LaunchGame(LuaObject dat)` (`CLobby.cpp:3182`). Liest `dat.GameOptions.ScenarioFile` → `WLD_LoadScenarioInfo` → `scenarioInfo.Options = gameOptions`. Baut `LaunchInfoNew`: GameMods, ScenarioInfo, `mInitSeed = hostedTime` (!! gemeinsamer Seed = Host-Zeit), CheatsEnabled. Liest FFA-Armee-Namen aus `Configurations.standard.teams`, mappt `dat.PlayerOptions[slot]` auf Armeen, sortiert nach Slot, hängt Zivilisten-Armeen an (`CivilianAlliance` + `customprops.ExtraArmies`). Pro humanem Spieler: `AssignClientIndex()` + `AssignCommandSource(timeouts, ownerId, …)` → BVIntSet der Army. Observer bekommen Client-Index + Command-Source ohne Army. Dann `CLIENT_CreateClientManager(clientCount, connector, gameSpeed, adjustable)`, `CreateLocalClient(...)`, pro etabliertem Peer `CreateNetClient(name, clientInd, uid, cmdSource, connection)`, für nicht-etablierte `CreateNullClient(...)` + sofortiges `Eject()`. Zum Schluss `RunScript("GameLaunched")` und `WLD_BeginSession(sessionInfo)`. `mIsBeingRecorded = true`.
2. **Singleplayer:** `WLD_SetupSessionInfo(LuaObject launchData)` (`SessionStartup.cpp:460`) — aus `scenarioInfo`, `scenarioMods`, `teamInfo` (→ mStrVec pro Army), `RandomSeed` (oder Systemtimer), `createReplay` → `mIsBeingRecorded`, `playerName` → eine Command-Source. `mClientManager = nullptr` (wird später erzeugt).
3. **Replay:** `VCR_SetupReplaySession(filename)` (`SessionStartup.cpp:340`) — siehe unten.
4. **Load:** `CSavedGame::CreateSinglePlayerSessionInfo()` (`SessionStartup.cpp:1019`).

### Weg in die Sim
`SIM_CreateDriver(clientManager, stream, launchInfo, commandSourceId)` → `CSimDriver`-ctor (`SimDriver.cpp:637`): übernimmt Stream (= Replay-Recording-Stream!) und ClientManager, setzt `mPendingSyncFilter.focusArmy = commandSourceId`, erzeugt `CMarshaller(clientManager)` und ruft direkt `mMarshaller->SetCommandSource(commandSourceId)`; ein Bootstrap-Thread baut die `Sim` aus `mLaunchInfo`. **Achtung: Die eigentliche Sim-Konstruktion aus LaunchInfo (FUN_0073D260) ist in faf-re noch NICHT rekonstruiert** — im Repo steht nur ein State-Flow-Platzhalter.

## 3. Replays

### Format `.scfareplay` (aus `VCR_SetupReplaySession`, Zeile 340–450 — der echte Engine-Reader)
Header:
```
strz      "Supreme Commander v1.50.3764"   (STR_Printf("Supreme Commander v%1.2f.%4i", 1.5, 3764))
strz      (ignoriert; in echten Files 3 Bytes: "\r\n\0")
char[13]  "Replay v1.9\r\n"                (strcmp-geprüft)
strz      map file  ("/maps/xxx/xxx.scmap")
strz      (ignoriert; 4 Bytes)
u32 len + bytes   GameMods       (Lua-Bytestream)
u32 len + bytes   ScenarioInfo   (Lua-Bytestream)
u8   numCommandSources
     [ strz name ; i32 timeouts ]  × numCommandSources
u8   cheatsEnabled
u8   numArmies
     [ u32 len + bytes PlayerOptions(Lua) ; u8 sourceIndex … bis 0xFF ] × numArmies
i32  initSeed
```
Body: direkt anschließend der rohe Command-Stream als Folge von `[u8 type][u16 size][payload]`.

Das deckt sich exakt mit den Community-Parsern (`FAForever/faf-scfa-replay-parser` `replay.ksy` + `replay_parser/header.py`) — nur dass dort die beiden "ignorierten" Strings als 3 bzw. 4 rohe Bytes übersprungen werden.

### Aufnahme
Kein separater Writer! `CDecoder::ReceiveMessage` (`CDecoder.cpp:181`) kopiert die kompletten Wire-Bytes jeder dispatchten Message **vor** dem Decoden 1:1 in den `CSimDriver::mStream`. Der Replay-Body ist also identisch mit dem, was die Sim gefressen hat (inkl. `CMDST_Advance`, `CMDST_VerifyChecksum`, `CMDST_SetCommandSource`). Wer den Header schreibt und die Datei öffnet, ist in faf-re **nicht rekonstruiert** (Lua-seitig `CopyCurrentReplay` kopiert `USER_GetReplayDir()/<profile>/LastGame.<ext>`).

### Abspielen
`VCR_SetupReplaySession` erzeugt `CLIENT_CreateClientManager(2, nullptr, 0, true)` (kein Connector!) und dann:
- `CreateReplayClient(&stream, &commandSources)` → `CReplayClient` als **Client 0**, Nickname "Replay", ownerId −1, sourceId 0xFF, mit allen Replay-Command-Sources im Valid-Set.
- `CreateLocalClient("Local", 1, 1, 0xFF)` → der Zuschauer (darf nichts befehlen, sourceId 0xFF).

`CReplayClient::Start()` (`CReplayClient.cpp:232`) liest solange Messages aus dem Replay-Stream, bis `mQueuedBeat > mDispatchedBeat` (also ein Beat voraus): `CMDST_SetCommandSource` filtert (`mCurrentSourceAllowed`), erlaubte Messages gehen an `CClientBase::Process` (→ Pipe), bei `CMDST_Advance` wird zusätzlich ein Ack synthetisiert. Bei EOF: `CMDST_EndGame` + leerer Advance + `Eject()`. Ein Boost-Worker-Thread (`ReplayThreadMain`) pollt nur die Stream-Readiness und signalisiert das Manager-Event (nicht-blockierendes Nachladen, z. B. für live-gestreamte Replays über `gpgnet://`).

`CReplayClient::Process` beantwortet außerdem `CLIMSG_Available` mit einem selbst erzeugten `CLIMSG_Dispatched` — dadurch läuft die Ack-Barriere ohne echten Peer durch.

## 4. Save/Load

### Dateiformat
1. **`SSaveGameFileHeader`** (`serialization/SaveGameFileHeader.h`), fix 0x2028 Bytes, an Offset 0:
   - `u32 magic = 0x484D4752` ("RGMH"), `u32 version = 1`, `u32 byteSize = 0x2028`
   - `i32 previewOffsetLow/High` (relativ zum Headerende), `u32 previewByteSize`
   - 4× u32 GameId (GUID-Teile, Reihenfolge 1,3,4,2 — Identitätscheck beim Laden)
   - `wchar_t appName[1024]`, `wchar_t sessionName[1024]`, `u8 reserved[0x1000]`
2. **`SSavedGameHeader`** (Reflection-Objekt, RType-Version 3, Struct-Feld `mVersion = 20`): `mMapName`, `mFocusArmy`, `vector<SSavedGameArmyInfo>{string mPlayerName}`, `mScenarioInfoText`, `shared_ptr<LaunchInfoBase> mLaunchInfo`.
3. Danach ein Archiv-Abschnitt mit dem gesamten `Sim`-Objektgraphen.
4. Optional Preview-Bild-Bytes am Ende (Offset im Dateikopf nachgetragen).

### Schreibpfad
`cfunc_InternalSaveGameL` (Lua `InternalSaveGame`) → `CSaveGameRequestImpl(savePath, sessionName, onCompletion)`:
- öffnet `<savePath>.NEW`, schreibt 0x2028 Null-Bytes als Platzhalter, erzeugt `gpg::CreateBinaryWriteArchive(file)`, schreibt `SSavedGameHeader` + `EndSection(false)`.
- `ISTIDriver::RequestSaveGame(request)` → `CSimDriver::PreparePendingSaveRequestLocked` (`SimDriver.cpp:807`) ruft auf dem Sim-Thread `mSim->SaveState(archive)`.
- `Sim::SaveState` (`Sim.cpp:12135`): wirft bei NIS-Mode; sonst `archive->Write(Sim::sType, this, ownerRef)` + `EndSection(false)` — **ein einziger reflektierter Write des kompletten Sim-Objekts.**
- `CSaveGameRequestImpl::Save` (`:368`): Preview anhängen, Dateikopf zurückschreiben, `.NEW` → Zieldatei per `MoveFileEx(REPLACE_EXISTING)`, Lua-Callback `(success, message)`, `delete this`.

### Lesepfad
`CSavedGame` (`SessionStartup.cpp:971`): Header prüfen (Magic/Version/GameId), `CreateBinaryReadArchive`, `SSavedGameHeader` lesen, `mVersion != 20` → "WrongVersion". `CreateSinglePlayerSessionInfo()` baut `LaunchInfoLoad`, liest den `shared_ptr<SSessionSaveData>` aus dem Archiv, **behält das offene `ReadArchive`** in `LaunchInfoLoad::mReadArchive` (die Sim wird beim Bootstrap daraus rekonstruiert), setzt eine einzige Command-Source (der Focus-Army-Spieler) und alle Armeen auf Source 0.

### Serialisierungs-System (`gpg::RType` Reflection)
- `WriteArchive`/`ReadArchive` sind abstrakt mit typisierten Slots (`WriteBytes/String/Float/UInt64/…/WriteMarker`, Slot 15 `EndSection`, Slot 16 `Close`); konkrete Impls: `CreateBinaryWriteArchive(FILE*)` und `CreateTextWriteArchive(ostream)`.
- Pointer-Tracking: `ArchiveToken {ObjectTerminator=0, NewObject=1, NullPointer=2, ExistingPointer=3, ObjectStart=4}`, `TrackedPointerState {Reserved, Unowned, Owned, Shared}`, `TypeHandle{RType*, version}` — d. h. ein echtes Objektgraph-Format mit Zyklen-Auflösung und Typtabelle, nicht nur ein Flat-Dump.
- Jeder serialisierbare Typ hat ein `XTypeInfo : gpg::RType` (Name, Größe, Version, Basisklassen) und einen `XSerializer` mit statischen `Deserialize(ReadArchive*, obj, version, RRef*)` / `Serialize(WriteArchive*, …)`-Callbacks, die per `RegisterSerializeFunctions()` in die RType eingehängt werden.
- **Umfang im Repo:** 240 `*TypeInfo.h`, 89 `*Serializer.h`, 30 `*Reflection.h`. Serialisiert werden u. a.: `Sim`, `CArmyImpl`, `CArmyStats`, `CEconomy`, `CMersenneTwister`/`CRandomStream` (RNG-State!), `COGrid`, `CInfluenceMap`, `CCommandDb`, alle Tasks/Units/Weapons, sowie **der komplette Lua-State** (`WriteTThread/WriteTString/WriteTTable/WriteFunction/WriteUserdata/WriteCFunction` in `WriteArchive`).
- **Konsequenz für einen Neubau:** Ein binärkompatibles Save/Load ist ein enorm großer Brocken (Lua-State-Serialisierung inkl. Closures). Ein eigenes, semantisches Save-Format (JSON/CBOR der Sim-Werte + eigener Lua-State-Snapshot) ist realistischer; Replay-Kompatibilität ist dagegen sehr wohl erreichbar.

## 5. FAF-Replay-Kompatibilität (.fafreplay)

### Container (Web-recherchiert)
```
Zeile 1 : JSON-Header, "\n"-terminiert  (u.a. "version", uid, featured_mod, sim_mods, players, …)
Rest    : version==1 → base64-decode → erste 4 Bytes (dekomprimierte Größe) überspringen → zlib.decompress
          version==2 → zstd.decompress
Ergebnis: exakt der .scfareplay-Bytestream (Header + Command-Stream, s. o.)
```
Referenz-Implementierungen: `FAForever/faf-scfa-replay-parser` (Python + Kaitai `replay.ksy`), `Askaholic/faf-replay-parser` (Rust + Python-Bindings, `extract_scfa`).

### Was ein Browser-Nachbau bräuchte
1. **Container-Entpacker:** JSON-Zeile splitten; zstd (WASM, z. B. `fzstd`/`zstd-wasm`) bzw. base64+`DecompressionStream('deflate')` für v1. Klein und rein mechanisch.
2. **Header-Parser:** exakt die Struktur oben; die beiden Lua-Bytestreams (GameMods, ScenarioInfo) und die PlayerOptions pro Army müssen mit dem 6-Typ-Lua-Decoder (float/string/nil/bool/table/end) in JS-Objekte konvertiert werden. Daraus fallen Map, Optionen, Armeen, Fraktionen, Farben, Seed, Command-Sources.
3. **Command-Stream-Parser:** `[u8 type][u16 size][payload]`-Schleife + Decoder für die 24 Opcodes (Payload-Layouts exakt aus `CDecoder.cpp` / `CMarshaller`-Writern übernehmbar). Für reines *Anzeigen* (Timeline, APM, Chat, Build-Order) reicht das schon.
4. **Deterministische Wiedergabe** braucht zusätzlich: identische Sim-Physik/Reihenfolge, identischer MT19937, identische Blueprints **des jeweiligen FAF-Game-Builds** und geladene `sim_mods`. Der ScenarioInfo-String im Header nennt die Map, der JSON-Header den `featured_mod` und die Mod-UIDs. Ohne 1:1-Sim ist echtes Replay nicht möglich — aber die Checksummen im Stream (`CMDST_VerifyChecksum` alle N Beats) sind ein **eingebautes Verifikationswerkzeug**: man kann die eigene Sim gegen die Original-MD5s pro Beat prüfen und weiß beat-genau, wo man divergiert. Voraussetzung: die Hash-Reihenfolge aus `Sim::UpdateChecksum` exakt nachbauen (Economy → dirty Entities → RNG-State).
5. **Praktikabler Zwischenschritt:** FAF-Replays als *Datenquelle* (Header + Command-Stream) einlesen und nur die Befehle in die eigene Sim einspeisen — Desyncs erwartbar, aber der Stream ist der beste verfügbare Integrationstest.

## 6. Chat & Diplomatie im Netz

### Chat — bewusst außerhalb der Sim
- Lua: `SessionSendChatMessage([clientIndexOrTable,] luaTable)` → `cfunc_SessionSendChatMessageL` (`SessionStartup.cpp:661`): Empfängerauswahl als Bitmaske (Default = alle), Lua-Objekt via `ToByteStream` serialisieren, **Limit 0x400 Bytes**, dann pro selektiertem Client `IClient::ReceiveChat(bytes)`.
- `CClientBase::ReceiveChat` baut eine `CMessage(CLIMSG_ReceiveChat)` + Payload und ruft `Process(msg)`; bei `CNetClient` geht sie damit über die Leitung, bei `CLocalClient` direkt lokal.
- Empfang: `CClientBase::Process` case 55 → `mManager->mInterface->ReceiveChat(this, payload)` → `IClientMgrUIInterface::ReceiveChat` → UI/Lua.
- **Chat ist damit NICHT im Command-Stream und nicht im Replay-Body** (Message-ID 55 liegt außerhalb 0–49, wird von `CClientBase::Process` konsumiert und nie in die Pipe geschrieben). Community-Parser lesen "messages" nur aus `CMDST_LuaSimCallback`-Payloads (In-Sim-Chat-Callbacks), nicht aus CLIMSG_ReceiveChat.
- Weitere UI-Notifications über dasselbe Interface: `NoteDisconnect`, `NoteEjectRequest`, `NoteGameSpeedChanged`, `ReportBottleneck(+Cleared)`.

### Diplomatie — in der Sim
- `enum EAlliance : i32 { ALLIANCE_Neutral=0, ALLIANCE_Ally=1, ALLIANCE_Enemy=2 }` (`moho/sim/EAllianceTypeInfo.h`), `CArmyImpl::SetAlliance(armyId, relationIndex)` (0x006FDF30).
- Allianzwechsel/Ressourcentransfer laufen über Lua **in der Sim**, also als `CMDST_LuaSimCallback` (Opcode 22) bzw. `CMDST_ExecuteLuaInSim` (21) durch den Lockstep — dadurch deterministisch und im Replay enthalten.
- Lobby-Chat/„ScriptData" vor Spielstart: `LOBMSG_BroadcastScriptData` (106) / `LOBMSG_DirectScriptData` (107) mit LuaObject-Payload (`CLobby::BroadcastScriptData` 0x007C2210 / `SendScriptData` 0x007C24C0) — das ist der Kanal, über den die Lobby-UI (Slots, Optionen, Chat) synchronisiert wird.

### Lobby/Transport-Kurzüberblick (für die Planung)
- `CLobby : IMessageReceiver, INetDatagramHandler` — Discovery per UDP-Broadcast auf Port 15000 (`LOBMSG_DiscoveryRequest/Response` 110/111), Handshake `Join(100) → Rejected(101) | Welcome(102)`, dann `NewPeer(103)`, `DeletePeer(104)`, `EstablishedPeers(105)`. Voll-Mesh: jeder Peer verbindet sich mit jedem.
- Transport: `NET_MakeConnector(port, protocol, natProvider)` → TCP (`CNetTCPConnector`) oder zuverlässiges UDP (`CNetUDPConnector`, 50 KB `.cpp`). UDP-Paket: 15-Byte-Header `{u8 type, u32 earlyMask, u16 serial, u16 inResponseTo, u16 seq, u16 expectedSeq, u16 payloadLen}` + max 497 Byte Payload (512 Byte MTU); Pakettypen `Connect(0), Answer(1), ResetSerial(2), SerialReset(3), Data(4), Ack(5), KeepAlive(6), Goodbye(7), NATTraversal(8)`; Handshake mit 32-Byte-Nonces, optionale Deflate-Kompression (`ENetCompressionMethod`).
- `CGpgNetInterface` (76 KB) = die Anbindung an einen externen Lobby-Server (FAF-Client) über `gpgnet://`.
- Bandbreiten-Telemetrie: `SSendStampBuffer` (4096er Ringpuffer, jede Ein-/Ausgabe wird mit µs-Zeit und Bytes gestempelt) → `GetBetween(since)` → Netzwerk-Overlay.

## Lücken in faf-re (relevant für die Planung)
- Wer `mSimHashes[beat & 0x7F]` **beschreibt**, ist im Repo nicht rekonstruiert (nur Lesestellen). Die Hash-Zutaten sind aber vollständig in `Sim::UpdateChecksum`.
- Der Replay-**Writer** (Header + Datei-Öffnen) und der Aufrufer von `SIM_CreateDriver` fehlen; ebenso die Sim-Konstruktion aus `LaunchInfo` (FUN_0073D260).
- `Sim::AdvanceBeat` ist als "partial high-fidelity lift" markiert (ein Sync-Filter-Packing-Pass fehlt).

## Refs
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\ECmdStreamOp.h (Opcodes 0-23 inkl. Payload-Doku)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\EClientMsg.h (50-57)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\ELobbyMsg.h (100-111, 200-209)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\NetMessageRanges.h
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\CMessage.h:31 (Wire-Format [u8 type][u16 size][payload])
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\CClientBase.h:294 (Client-State-Felder)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\CClientBase.cpp:189 (Process/Ack), :385 (UpdateState/Command-Source-Autorisierung), :659 (IsReadyForBeat)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\CClientManagerImpl.h:22 (CMarshaller = ICommandSink-Encoder)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\CClientManagerImpl.cpp:808 (ProcessClients-Broadcast), :878 (DoBeat), :994 (UpdateStates), :1047 (GetBottleneckInfo)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\CLocalClient.cpp / CNetClient.cpp (Loopback vs. Wire)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\CReplayClient.h / CReplayClient.cpp:232 (Start), :172 (Process)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\IMessageReceiver.h (CMessageDispatcher, 256-Slot-Receiver-Tabelle)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\IClientMgrUIInterface.h (ReceiveChat, NoteDisconnect, ...)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\SNetPacket.h + NetTransportEnums.h (UDP-Transport, 15-Byte-Header, 512-Byte-MTU)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\CLobby.h + CLobby.cpp:3182 (LaunchGame), :3140 (SendScriptData)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\misc\CDecoder.h + CDecoder.cpp:181 (ReceiveMessage: Replay-Mitschnitt), :224 (VerifyChecksum-Decode)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\misc\SessionStartup.cpp:340 (VCR_SetupReplaySession = Replay-Header-Format), :460 (WLD_SetupSessionInfo), :661 (SessionSendChatMessage), :971 (CSavedGame), :1019 (CreateSinglePlayerSessionInfo)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\misc\LaunchInfoBase.h (LaunchInfoBase/New/Load, ArmyLaunchInfo, SLaunchCommandSources)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\misc\CSaveGameRequestImpl.h + .cpp:302 (ctor), :368 (Save)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\WldSessionInfo.h (SWldSessionInfo)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\ISTIDriver.h (40 Slots, Opcode-Zuordnung)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\SimDriver.h:234 (CSimDriver-Layout) + SimDriver.cpp:807 (Save), :851 (Checksum-Publish), :908 (Dispatch-Step), :1090 (Dispatch)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\Sim.cpp:8499 (UpdateChecksum), :9757 (VerifyChecksum), :9809 (GetBeatChecksum), :11990 (AdvanceBeat), :12135 (SaveState)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\SDesyncInfo.h
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\EAllianceTypeInfo.h (ALLIANCE_Neutral/Ally/Enemy)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\serialization\SaveGameFileHeader.h (Magic 'RGMH', 0x2028)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\serialization\SSavedGameHeader.h (Version 20) + SSavedGameArmyInfo.h
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\gpg\core\containers\WriteArchive.h / ReadArchive.h / ArchiveSerialization.h (ArchiveToken, TrackedPointerState, TypeHandle)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\gpg\core\streams\BinaryReader.cpp:175 (ReadString strz), :207 (ReadLengthPrefixedString u32)
- https://github.com/FAForever/faf-scfa-replay-parser (replay.ksy + replay_parser/header.py — bestätigt das Replay-Header-Layout)
- https://github.com/Askaholic/faf-replay-parser-python (Rust-Parser, extract_scfa)
- https://forum.faforever.com/topic/1551/faf-scfa-replay-parser-library (.fafreplay: JSON-Zeile + v1 base64/zlib, v2 zstd)
