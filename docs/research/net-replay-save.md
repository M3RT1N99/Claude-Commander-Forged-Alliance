# agent6

## Summary
faf-re contains the complete lockstep/session/replay/save system of the Moho engine in reconstructed C++. Only a command stream (24 opcodes, ECmdStreamOp 0–23) is synchronized as a message broadcast over a full mesh of peers; Desync detection runs via MD5 checksums per beat (CMDST_VerifyChecksum, 128-beat ring buffer). Replays are exactly the same command stream, byte-identical written by CDecoder, with a well-documented header ("Replay v1.9"); .fafreplay is just a container (JSON line + zlib/base64 or zstd) for exactly this .scfareplay. Save/Load uses the Reflection archive system (gpg::RType/ReadArchive/WriteArchive) and serializes the entire sim (Sim::SaveState) — 89 serializer classes, 240 TypeInfos.

## Key Facts
- Lockstep synchronizes ONLY commands: 24 opcodes in ECmdStreamOp (0=Advance, 1=SetCommandSource, 3=VerifyChecksum, 12=IssueCommand, 22=LuaSimCallback, 23=EndGame) — no entity states over the wire.
- Wire format is uniform: [u8 type][u16 LE size incl. 3-byte header][payload] (CMessage, mBuff[0..2]); same coding for Sim-Ops (0-49), Client Control (50-59), Lobby (100-119) and Connection Events (200-209).
- No host relay: CClientManagerImpl::ProcessClients broadcasts every message to ALL clients (CLocalClient → own pipe, CNetClient → own connection); Fully meshed P2P, lobby via CLobby (UDP:15000 discovery, TCP/UDP connector).
- Beat mechanics: Each client has its own pipe + beats (mQueuedBeat/mDispatchedBeat); DoBeat() calculates mPartiallyQueuedBeat/mFullyQueuedBeat/mAvailableBeat, UpdateStates(beat) drains all pipes up to beat and then dispatches CMDST_Advance(1) to the sim.
- Ack mechanic: every incoming CMDST_Advance generates CLIMSG_Ack(clientIndex, queuedBeat) which is broadcast to ALL clients; each client holds mLatestAckReceived[N] (Ack matrix N×N) — from this IsReadyForBeat(beat) and EveryoneResponsiveSince(beat).
- Desync: Sim::UpdateChecksum() folds every beat economy, dirty entities (id, health, blueprint, orientation+pos 0x1C, velocity) and the complete MT19937 RNG state into an MD5 context; mSimHashes[beat & 0x7F] is a 128 beat ring; Sim::VerifyChecksum compares and creates SDesyncInfo{beat, army, hash1, hash2}.
- Command source authorization: each client may only claim its BVIntSet mValidCommandSources; Unauthorized CMDST_SetCommandSource discards all subsequent commands from this client (anti-cheat/anti-spoof in lockstep).
- Eject/Timeout: CLIMSG_Eject(requesterIndex, afterBeat) — each client collects eject requests; an eject-pending client no longer blocks the beat advance; when the eject beat is reached, CMDST_CommandSourceTerminated is written to the sim stream.
- Session start parameters are in LaunchInfoBase (GameMods, ScenarioInfo as serialized Lua string, vector<ArmyLaunchInfo> with UnitSources bitset, SLaunchCommandSources, CheatsEnabled) + LaunchInfoNew (mStrVec = Lua-PlayerOptions per Army, mInitSeed = RNG seed).
- SWldSessionInfo (mMapName, mLaunchInfo, mIsBeingRecorded, mIsReplay, mIsMultiplayer, mClientManager, mSourceId) is the one bootstrap object for all three paths: CLobby::LaunchGame (MP), WLD_SetupSessionInfo (SP-Lua), VCR_SetupReplaySession (Replay), CSavedGame::CreateSinglePlayerSessionInfo (Load).
- Replay-Body == recorded dispatch stream: CDecoder::ReceiveMessage copies the raw wire bytes 1:1 into the CSimDriver stream before it decodes — replaying is feeding the same bytes via CReplayClient as pseudo-client 0.
- Replay header (SCFAreplay v1.9) reconstructed exactly from VCR_SetupReplaySession: strz version, strz '\r\n', 13 bytes 'Replay v1.9\r\n', strz mapfile, 4 bytes, u32+bytes GameMods (Lua bytestream), u32+bytes ScenarioInfo, u8 numSources {strz name, i32 timeouts}, u8 cheats, u8 numArmies {u32+bytes PlayerOptions, u8 list to 0xFF}, i32 seed.
- Save = Reflection archive: 0x2028-byte file header (Magic 'RGMH' 0x484D4752, version 1, preview offset/size, GUID, UTF-16 app/session name), then SSavedGameHeader (version 20) and then archive->Write(Sim::sType, sim) — the entire sim including Lua state is saved Written RType serializer.
- Chat does NOT run via the Sim stream: CLIMSG_ReceiveChat (Lua object as a byte stream, max 0x400 bytes) goes out via client broadcast and is delivered to the UI via IClientMgrUIInterface::ReceiveChat — therefore desync-neutral. Diplomacy/Alliance (EAlliance, CARmyImpl::SetAlliance), on the other hand, runs as CMDST_LuaSimCallback IN the sim.
- .fafreplay is just a container: first line = JSON header (\n-terminated), then v1 = base64→(skip 4 byte size)→zlib, v2 = zstd; Unpacked results in exactly the .scfareplay stream described above.

## Details
## 1. Lockstep-Modell

### What is being synced
**Commands only.** No state sync. All network traffic in the game is a stream of `CMessage` objects. The Sim is deterministic and is driven identically by the same command stream on each peer.

### Wire-Format (`CMessage`, `moho/net/CMessage.h`)
```
byte 0    : u8   message type
bytes 1-2 : u16 LE total wire size (header 3 + payload)
bytes 3.. : payload
```
`CMessageStream` is a `gpg::Stream` view of the payload; Write/Read via `gpg::BinaryReader`. Strings are either NUL-terminated (`ReadString`) or u32-length-prefixed (`ReadLengthPrefixedString`). LuaObjects are serialized into a typed byte stream using `LuaObject::ToByteStream` (type tags: 0=float, 1=string, 2=nil, 3=bool, 4=table, 5=end).

### Message ID spaces (`NetMessageRanges.h`, half-open areas)
| Bereich | Enum | Zweck |
|---|---|---|
| 0-49 | `ECmdStreamOp` | Sim Command Stream (0-23 occupied only) |
| 50–59 | `EClientMsg` | Client-/Replay-Control |
| 100–119 | `ELobbyMsg` | Lobby-Handshake |
| 200–209 | `ELobbyMsg` | Connection-Lifecycle-Events |

**ECmdStreamOp (0-23)** — fully documented including payload in `ECmdStreamOp.h`:
`0 Advance(u32 beats)`, `1 SetCommandSource(u8)`, `2 CommandSourceTerminated()`, `3 VerifyChecksum(MD5Digest, u32 beat)`, `4 RequestPause`, `5 Resume`, `6 SingleStep`, `7 CreateUnit(u8 army, string bp, f x, f z, f heading)`, `8 CreateProp`, `9 DestroyEntity`, `10 WarpEntity`, `11 ProcessInfoPair`, `12 IssueCommand(u32 count, EntId[], CmdData, u8 clear)`, `13 IssueFactoryCommand`, `14/15 In/DecreaseCommandCount`, `16 SetCommandTarget`, `17 SetCommandType`, `18 SetCommandCells`, `19 RemoveCommandFromQueue`, `20 DebugCommand`, `21 ExecuteLuaInSim(string)`, `22 LuaSimCallback(string, LuaObject, EntId[])`, `23 EndGame`.

**EClientMsg (50–57):** `50 Ack(u8 clientIndex, i32 beat)`, `51 Dispatched(i32)`, `52 Available(i32)`, `53 Ready`, `54 Eject(u8 requester, i32 afterBeat)`, `55 ReceiveChat(bytes)`, `56 AdjustSimSpeed(i32 clock, i32 rate)`, `57 IntParam(i32)`.

### Encoder / Decoder
- **`CMarshaller`** (`CClientManagerImpl.h:22`) implements `ICommandSink` and is the *encoder*: each method builds a `CMessage` with the appropriate opcode and calls `ProcessClients(msg)`.
- **`CDecoder`** (`moho/misc/CDecoder.h`) implements `IMessageReceiver` and is the *decoder*: `ReceiveMessage` → `DecodeMessage` → per-opcode-decode → `ICommandSink*` (this is the `Sim`).
- Both sides are symmetrical; `WriteEntIdSet`/`WriteCommandData`/`WriteTarget`/`WriteCells` or `DecodeEntIdSet`/`DecodeCommandData`/… define the exact payload byte order.

### Topology: Full mesh, no host relay
`CClientManagerImpl::ProcessClients(msg)` iterates **all** `mClients` and calls `client->Process(msg)`:
- `CLocalClient::Process` → `CClientBase::Process` → appends bytes to the **own** pipe (loopback).
- `CNetClient::Process` → writes the message directly to **its** `INetConnection` (one connection per peer).
- Incoming: `CNetClient::ReceiveMessage` → `CClientBase::Process` → Bytes end up in the pipe of **this** client.

Result: Each peer has its own FIFO pipe with its command stream. The local player broadcasts directly to everyone.

### Beat/Ack-Mechanik
State per client (`CClientBase`, `CClientBase.h:294–308`):
`mQueuedBeat` (how much this peer sent), `mDispatchedBeat` (how much of it went into the sim), `mAvailableBeatRemote`, `mLatestAckReceived: vector<i32>` (size = number of clients → **N×N ack matrix**), `mLatestBeatDispatchedRemote`, `mEjectPending/mEjected`, `mValidCommandSources` (BVIntSet), `mCommandSourceId`, `mSimRate` (default 50).

Ablauf (`CClientBase::Process`, `CClientBase.cpp:189`):
1. Message type < 50 (Sim-Op) → append to the pipe. For `CMDST_Advance`: `mQueuedBeat += delta` and **immediately** create a `CLIMSG_Ack(mIndex, mQueuedBeat)` and broadcast to everyone via `mManager->ProcessClients()`.
2. `CLIMSG_Ack` → `mLatestAckReceived[ackClientIndex] = beat` (out-of-order is discarded + logged).
3. `CLIMSG_Dispatched`/`CLIMSG_Available` → monoton aktualisieren.

`CClientManagerImpl::DoBeat()` (`CClientManagerImpl.cpp:878`) per frame:
- `mConnector->Pull()` (Netzwerk drainen)
- Readiness: all clients `mReady` → `mEveryoneIsReady`
- Increment `mPartiallyQueuedBeat`, `mFullyQueuedBeat` as long as all non-ejected clients have delivered data by then
- Count up `mAvailableBeat` as long as `EveryoneResponsiveSince(beat)` (= every client `IsReadyForBeat`) → then broadcast `CLIMSG_Available(mAvailableBeat)`
- Bottleneck analysis (`GetBottleneckInfo`: Nothing/Readiness/Data/Ack + amount of guilty clients) → UI callback after 5 s
- If Client[0] is a `CReplayClient`: `Start()` (refill replay)

`IsReadyForBeat(beat)` (`CClientBase.cpp:659`): the client blocks if any peer has `mLatestAckReceived[peer] < beat` (unless the peer is ejected/eject-pending). This is the actual lockstep barrier: **everyone must have locked everyone.**

`CClientManagerImpl::UpdateStates(beat)` (`:994`): for each client `UpdateState(beat, marshaller, &mStream)` → drains its pipe to `mDispatchedBeat == beat`, checks command source authorization, writes authorized messages to the common `mStream`. Then broadcast `CLIMSG_Dispatched(beat)`, empty `mStream` and feed in each message via `Dispatch()` (CMessageDispatcher → CDecoder → Sim), finally a synthetic `CMDST_Advance(1)`.

This is driven by `CSimDriver::ExecuteDispatchStepLocked` (`SimDriver.cpp:908`): `mDispatchBeat++` → `mClientManager->UpdateStates(beat)` → `FinalizeSyncDispatchLocked()` (Sim::Sync + Checksum) → Sim rate estimate from the median dispatch duration → if necessary `SetSimRate`.

### Command source authorization (important for security)
`CClientBase::UpdateState` (`CClientBase.cpp:385`) when draining the peer pipe:
- `CMDST_SetCommandSource(id)`: if `id ∉ mValidCommandSources` → warning "claiming command source X, but not authorized" and **all following commands from this client are discarded** (`hasCommandSource = false`).
- Only authorized messages are written to the output pipe, each preceded by `CMDST_SetCommandSource` if the source has changed.
- `CMDST_CommandSourceTerminated` removes the source from the set.

### Desync-Erkennung
- `Sim::UpdateChecksum()` (`Sim.cpp:8499`) runs every beat (Convar `ChecksumPeriod`, default 1) and folds into a persistent `gpg::MD5Context`:
  - per army: `SEconTotals` (Stored/Income/Reclaimed/LastUseRequested/LastUseActual/MaxStorage), every 100 beats additionally `ReconDB::UpdateSimChecksum()`
  - per dirty entity: `id (u32)`, `health (f32)`, blueprint ID string, `Orientation` + position (0x1C bytes at a time), velocity (Vec3f)
  - kompletter MT19937-State (`0x9C0` Bytes) + Marsaglia-Pair-Flag/Wert
- Ergebnis landet im Ring `mSimHashes[128]`; `Sim::GetBeatChecksum(out, beat)` liest `mSimHashes[beat & 0x7F]`.
- `CSimDriver::FinalizeSyncDispatchLocked` (`SimDriver.cpp:851`) sends a `CMDST_VerifyChecksum(digest, beat)` into the command stream → i.e. to all peers after every sync for the published beat (if Digest ≠ 0).
- Receive side `Sim::VerifyChecksum` (`Sim.cpp:9757`): ignores beats older than 128 or in the future; in case of mismatch `mDesyncs.push_back(SDesyncInfo{beat, army, localHash, remoteHash})` + warning `"Checksum for beat %d mismatched: %s (sim) != %s (%s)"`, `mIsDesyncFree = false`. There is an optional log file `<prefix>beatNNNNN.log` per beat with the digest after each hash step (desync bisection).

### Sim-Rate / Game-Speed
- `mGameSpeed`, `mGameSpeedClock`, `mGameSpeedRequester`, `mAdjustableGameSpeed` in the manager. `SetSimRate(rate)` broadcasts `CLIMSG_AdjustSimSpeed(clock+1, rate)`; `ApplyIncomingGameSpeedRequest` wins with higher clock, tie → lower client index. Hostless deterministic arbitration.
- `GetSimRate()` = Minimum across all non-eject pending clients (slowest computer slows down).
- Lobby-`GameOptions.GameSpeed`: `"fast"` → 4, `"adjustable"` → adjustable=true, otherwise 0.

## 2. Session-Start

### `SWldSessionInfo` (`moho/sim/WldSessionInfo.h`, 0x30 Bytes)
`mMapName`, `shared_ptr<LaunchInfoBase> mLaunchInfo`, `mIsBeingRecorded`, `mIsReplay`, `mIsMultiplayer`, `IClientManager* mClientManager`, `u32 mSourceId`. This is the only item that goes to `WLD_BeginSession()`.

### `LaunchInfoBase` (`moho/misc/LaunchInfoBase.h`) — the sim startup parameters
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
`LaunchInfoNew` adds: `vector<string> mStrVec` (+0x90, the Lua serialized PlayerOptions per army) and `i32 mInitSeed` (+0xA0, RNG seed). `LaunchInfoLoad` complements `gpg::ReadArchive* mReadArchive` + `shared_ptr<SSessionSaveData>` (save game path) instead.

### The four entry points
1. **Multiplayer:** `CLobby::LaunchGame(LuaObject dat)` (`CLobby.cpp:3182`). Reads `dat.GameOptions.ScenarioFile` → `WLD_LoadScenarioInfo` → `scenarioInfo.Options = gameOptions`. Builds `LaunchInfoNew`: GameMods, ScenarioInfo, `mInitSeed = hostedTime` (!! common seed = host time), CheatsEnabled. Reads FFA army names from `Configurations.standard.teams`, maps `dat.PlayerOptions[slot]` to armies, sorted by slot, appends civilian armies (`CivilianAlliance` + `customprops.ExtraArmies`). Per human player: `AssignClientIndex()` + `AssignCommandSource(timeouts, ownerId, …)` → Army BVIntSet. Observers get client index + command source without army. Then `CLIENT_CreateClientManager(clientCount, connector, gameSpeed, adjustable)`, `CreateLocalClient(...)`, per established peer `CreateNetClient(name, clientInd, uid, cmdSource, connection)`, for non-established `CreateNullClient(...)` + immediate `Eject()`. Finally, `RunScript("GameLaunched")` and `WLD_BeginSession(sessionInfo)`. `mIsBeingRecorded = true`.
2. **Singleplayer:** `WLD_SetupSessionInfo(LuaObject launchData)` (`SessionStartup.cpp:460`) — from `scenarioInfo`, `scenarioMods`, `teamInfo` (→ mStrVec per Army), `RandomSeed` (or system timer), `createReplay` → `mIsBeingRecorded`, `playerName` → one Command Source. `mClientManager = nullptr` (will be created later).
3. **Replay:** `VCR_SetupReplaySession(filename)` (`SessionStartup.cpp:340`) — siehe unten.
4. **Load:** `CSavedGame::CreateSinglePlayerSessionInfo()` (`SessionStartup.cpp:1019`).

### Way into the sim
`SIM_CreateDriver(clientManager, stream, launchInfo, commandSourceId)` → `CSimDriver`-ctor (`SimDriver.cpp:637`): takes over stream (= replay recording stream!) and ClientManager, sets `mPendingSyncFilter.focusArmy = commandSourceId`, creates `CMarshaller(clientManager)` and calls `mMarshaller->SetCommandSource(commandSourceId)` directly; a bootstrap thread builds the `Sim` from `mLaunchInfo`. **Attention: The actual sim construction from LaunchInfo (FUN_0073D260) has NOT yet been reconstructed in faf-re** - there is only a state flow placeholder in the repo.

## 3. Replays

### Format `.scfareplay` (from `VCR_SetupReplaySession`, lines 340-450 — the real engine reader)
Header:
```
strz      "Supreme Commander v1.50.3764"   (STR_Printf("Supreme Commander v%1.2f.%4i", 1.5, 3764))
strz      (ignoriert; in echten Files 3 Bytes: "\r\n\0")
char[13] "Replay v1.9\r\n" (strcmp checked)
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
Body: immediately afterwards the raw command stream as a result of `[u8 type][u16 size][payload]`.

This corresponds exactly to the community parsers (`FAForever/faf-scfa-replay-parser` `replay.ksy` + `replay_parser/header.py`) - except that the two "ignored" strings are skipped as 3 and 4 raw bytes respectively.

### Aufnahme
No separate writer! `CDecoder::ReceiveMessage` (`CDecoder.cpp:181`) copies the complete wire bytes of each dispatched message **before** decoding 1:1 into the `CSimDriver::mStream`. The replay body is therefore identical to what the sim ate (including `CMDST_Advance`, `CMDST_VerifyChecksum`, `CMDST_SetCommandSource`). Whoever writes the header and opens the file is **not reconstructed** in faf-re (Lua side `CopyCurrentReplay` copies `USER_GetReplayDir()/<profile>/LastGame.<ext>`).

### Abspielen
`VCR_SetupReplaySession` creates `CLIENT_CreateClientManager(2, nullptr, 0, true)` (no connector!) and then:
- `CreateReplayClient(&stream, &commandSources)` → `CReplayClient` as **Client 0**, nickname "Replay", ownerId −1, sourceId 0xFF, with all Replay command sources in the valid set.
- `CreateLocalClient("Local", 1, 1, 0xFF)` → the viewer (may not command anything, sourceId 0xFF).

`CReplayClient::Start()` (`CReplayClient.cpp:232`) reads messages from the replay stream until `mQueuedBeat > mDispatchedBeat` (i.e. one beat ahead): `CMDST_SetCommandSource` filters (`mCurrentSourceAllowed`), permitted messages go to `CClientBase::Process` (→ pipe), with `CMDST_Advance` an additional ack is synthesized. At EOF: `CMDST_EndGame` + empty advance + `Eject()`. A boost worker thread (`ReplayThreadMain`) only polls the stream readiness and signals the manager event (non-blocking reload, e.g. for live-streamed replays via `gpgnet://`).

`CReplayClient::Process` also answers `CLIMSG_Available` with a self-generated `CLIMSG_Dispatched` — this means the Ack barrier passes without a real peer.

## 4. Save/Load

### Dateiformat
1. **`SSaveGameFileHeader`** (`serialization/SaveGameFileHeader.h`), fix 0x2028 Bytes, an Offset 0:
   - `u32 magic = 0x484D4752` ("RGMH"), `u32 version = 1`, `u32 byteSize = 0x2028`
   - `i32 previewOffsetLow/High` (relative to the end of the header), `u32 previewByteSize`
   - 4× u32 GameId (GUID parts, order 1,3,4,2 — identity check when loading)
   - `wchar_t appName[1024]`, `wchar_t sessionName[1024]`, `u8 reserved[0x1000]`
2. **`SSavedGameHeader`** (Reflection object, RType version 3, struct field `mVersion = 20`): `mMapName`, `mFocusArmy`, `vector<SSavedGameArmyInfo>{string mPlayerName}`, `mScenarioInfoText`, `shared_ptr<LaunchInfoBase> mLaunchInfo`.
3. Then an archive section with the entire `Sim` object graph.
4. Optional preview image bytes at the end (offset added in the file header).

### Schreibpfad
`cfunc_InternalSaveGameL` (Lua `InternalSaveGame`) → `CSaveGameRequestImpl(savePath, sessionName, onCompletion)`:
- opens `<savePath>.NEW`, writes 0x2028 zero bytes as placeholders, creates `gpg::CreateBinaryWriteArchive(file)`, writes `SSavedGameHeader` + `EndSection(false)`.
- `ISTIDriver::RequestSaveGame(request)` → `CSimDriver::PreparePendingSaveRequestLocked` (`SimDriver.cpp:807`) calls `mSim->SaveState(archive)` on the sim thread.
- `Sim::SaveState` (`Sim.cpp:12135`): throws in NIS mode; otherwise `archive->Write(Sim::sType, this, ownerRef)` + `EndSection(false)` — **a single reflected write of the entire Sim object.**
- `CSaveGameRequestImpl::Save` (`:368`): Attach preview, write back file header, `.NEW` → target file via `MoveFileEx(REPLACE_EXISTING)`, Lua callback `(success, message)`, `delete this`.

### Lesepfad
`CSavedGame` (`SessionStartup.cpp:971`): Check header (Magic/Version/GameId), `CreateBinaryReadArchive`, read `SSavedGameHeader`, `mVersion != 20` → "WrongVersion". `CreateSinglePlayerSessionInfo()` builds `LaunchInfoLoad`, reads the `shared_ptr<SSessionSaveData>` from the archive, **keeps the open `ReadArchive`** in `LaunchInfoLoad::mReadArchive` (the sim is reconstructed from it during bootstrap), sets a single command source (the focus army player) and all armies to source 0.

### Serialization system (`gpg::RType` Reflection)
- `WriteArchive`/`ReadArchive` are abstract with typed slots (`WriteBytes/String/Float/UInt64/…/WriteMarker`, slot 15 `EndSection`, slot 16 `Close`); concrete impls: `CreateBinaryWriteArchive(FILE*)` and `CreateTextWriteArchive(ostream)`.
- Pointer tracking: `ArchiveToken {ObjectTerminator=0, NewObject=1, NullPointer=2, ExistingPointer=3, ObjectStart=4}`, `TrackedPointerState {Reserved, Unowned, Owned, Shared}`, `TypeHandle{RType*, version}` — d. h. a true object graph format with cycle resolution and type table, not just a flat dump.
- Each serializable type has a `XTypeInfo : gpg::RType` (name, size, version, base classes) and a `XSerializer` with static `Deserialize(ReadArchive*, obj, version, RRef*)` / `Serialize(WriteArchive*, …)` callbacks that are mounted into the RType via `RegisterSerializeFunctions()`.
- **Scope in the repo:** 240 `*TypeInfo.h`, 89 `*Serializer.h`, 30 `*Reflection.h`. The following are serialized: `Sim`, `CArmyImpl`, `CArmyStats`, `CEconomy`, `CMersenneTwister`/`CRandomStream` (RNG-State!), `COGrid`, `CInfluenceMap`, `CCommandDb`, all tasks/units/weapons, as well as **the complete one Lua state** (`WriteTThread/WriteTString/WriteTTable/WriteFunction/WriteUserdata/WriteCFunction` to `WriteArchive`).
- **Consequence for a new build:** A binary-compatible save/load is an enormously large chunk (Lua state serialization including closures). A separate, semantic save format (JSON/CBOR of the Sim values ​​+ your own Lua state snapshot) is more realistic; Replay compatibility, on the other hand, is very achievable.

## 5. FAF replay compatibility (.fafreplay)

### Container (Web-recherchiert)
```
Zeile 1 : JSON-Header, "\n"-terminiert  (u.a. "version", uid, featured_mod, sim_mods, players, …)
Rest: version==1 → base64-decode → skip first 4 bytes (decompressed size) → zlib.decompress
          version==2 → zstd.decompress
Ergebnis: exakt der .scfareplay-Bytestream (Header + Command-Stream, s. o.)
```
Referenz-Implementierungen: `FAForever/faf-scfa-replay-parser` (Python + Kaitai `replay.ksy`), `Askaholic/faf-replay-parser` (Rust + Python-Bindings, `extract_scfa`).

### What a browser replica would need
1. **Container unpacker:** Split JSON line; zstd (WASM, e.g. `fzstd`/`zstd-wasm`) or base64+`DecompressionStream('deflate')` for v1. Small and purely mechanical.
2. **Header parser:** exactly the structure above; the two Lua bytestreams (GameMods, ScenarioInfo) and the PlayerOptions per Army need to be converted into JS objects using the 6-type Lua decoder (float/string/nil/bool/table/end). This includes the map, options, armies, factions, colors, seeds, command sources.
3. **Command stream parser:** `[u8 type][u16 size][payload]` loop + decoder for the 24 opcodes (payload layouts can be copied exactly from `CDecoder.cpp` / `CMarshaller` writers). That's enough for pure *viewing* (timeline, APM, chat, build order).
4. **Deterministic playback** also requires: identical sim physics/order, identical MT19937, identical blueprints **of the respective FAF game build** and loaded `sim_mods`. The ScenarioInfo string in the header names the map, the JSON header names the `featured_mod` and the mod UIDs. Without a 1:1 sim, real replay is not possible - but the checksums in the stream (`CMDST_VerifyChecksum` every N beats) are a **built-in verification tool**: you can check your own sim against the original MD5s per beat and know exactly where you diverge. Requirement: recreate the hash sequence from `Sim::UpdateChecksum` exactly (Economy → dirty entities → RNG state).
5. **Practical intermediate step:** Read FAF replays as a *data source* (header + command stream) and only feed the commands into your own sim - desyncs are to be expected, but the stream is the best integration test available.

## 6. Chat & Diplomatie im Netz

### Chat — intentionally outside of the sim
- Lua: `SessionSendChatMessage([clientIndexOrTable,] luaTable)` → `cfunc_SessionSendChatMessageL` (`SessionStartup.cpp:661`): Receiver selection as bit mask (default = all), serialize Lua object via `ToByteStream`, **Limit 0x400 bytes**, then `IClient::ReceiveChat(bytes)` per selected client.
- `CClientBase::ReceiveChat` builds a `CMessage(CLIMSG_ReceiveChat)` + payload and calls `Process(msg)`; With `CNetClient` it goes over the line, with `CLocalClient` directly locally.
- Empfang: `CClientBase::Process` case 55 → `mManager->mInterface->ReceiveChat(this, payload)` → `IClientMgrUIInterface::ReceiveChat` → UI/Lua.
- **Chat is therefore NOT in the command stream and not in the replay body** (Message ID 55 is outside 0-49, is consumed by `CClientBase::Process` and never written to the pipe). Community parsers only read "messages" from `CMDST_LuaSimCallback` payloads (in-sim chat callbacks), not from CLIMSG_ReceiveChat.
- More UI notifications via the same interface: `NoteDisconnect`, `NoteEjectRequest`, `NoteGameSpeedChanged`, `ReportBottleneck(+Cleared)`.

### Diplomacy — in the sim
- `enum EAlliance : i32 { ALLIANCE_Neutral=0, ALLIANCE_Ally=1, ALLIANCE_Enemy=2 }` (`moho/sim/EAllianceTypeInfo.h`), `CArmyImpl::SetAlliance(armyId, relationIndex)` (0x006FDF30).
- Alliance changes/resource transfers run via Lua **in the sim**, i.e. as `CMDST_LuaSimCallback` (Opcode 22) or `CMDST_ExecuteLuaInSim` (21) through the lockstep - therefore deterministic and included in the replay.
- Lobby chat/"ScriptData" before game start: `LOBMSG_BroadcastScriptData` (106) / `LOBMSG_DirectScriptData` (107) with LuaObject payload (`CLobby::BroadcastScriptData` 0x007C2210 / `SendScriptData` 0x007C24C0) — this is the channel through which the lobby UI (slots, options, chat) is synchronized.

### Lobby/Transportation Quick Overview (for planning)
- `CLobby : IMessageReceiver, INetDatagramHandler` — Discovery via UDP broadcast on port 15000 (`LOBMSG_DiscoveryRequest/Response` 110/111), handshake `Join(100) → Rejected(101) | Welcome(102)`, then `NewPeer(103)`, `DeletePeer(104)`, `EstablishedPeers(105)`. Full mesh: every peer connects to everyone.
- Transport: `NET_MakeConnector(port, protocol, natProvider)` → TCP (`CNetTCPConnector`) or reliable UDP (`CNetUDPConnector`, 50 KB `.cpp`). UDP packet: 15-byte header `{u8 type, u32 earlyMask, u16 serial, u16 inResponseTo, u16 seq, u16 expectedSeq, u16 payloadLen}` + max 497 byte payload (512 byte MTU); Package types `Connect(0), Answer(1), ResetSerial(2), SerialReset(3), Data(4), Ack(5), KeepAlive(6), Goodbye(7), NATTraversal(8)`; Handshake with 32-byte nonces, optional deflate compression (`ENetCompressionMethod`).
- `CGpgNetInterface` (76 KB) = the connection to an external lobby server (FAF client) via `gpgnet://`.
- Bandwidth telemetry: `SSendStampBuffer` (4096 ring buffer, each input/output is stamped with µs time and bytes) → `GetBetween(since)` → network overlay.

## Gaps in faf-re (relevant for planning)
- Who **describes** `mSimHashes[beat & 0x7F]` is not reconstructed in the repo (read only). However, the hash ingredients are completely in `Sim::UpdateChecksum`.
- The replay **writer** (header + file open) and the caller of `SIM_CreateDriver` are missing; also the sim construction from `LaunchInfo` (FUN_0073D260).
- `Sim::AdvanceBeat` is marked as "partial high-fidelity lift" (a sync filter packing pass is missing).

## Refs
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\ECmdStreamOp.h (Opcodes 0-23 inkl. Payload-Doku)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\EClientMsg.h (50-57)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\ELobbyMsg.h (100-111, 200-209)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\NetMessageRanges.h
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\CMessage.h:31 (Wire-Format [u8 type][u16 size][payload])
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\net\CClientBase.h:294 (client state fields)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\CClientBase.cpp:189 (Process/Ack), :385 (UpdateState/Command-Source-Autorisierung), :659 (IsReadyForBeat)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\CClientManagerImpl.h:22 (CMarshaller = ICommandSink-Encoder)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\CClientManagerImpl.cpp:808 (ProcessClients-Broadcast), :878 (DoBeat), :994 (UpdateStates), :1047 (GetBottleneckInfo)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\CLocalClient.cpp / CNetClient.cpp (Loopback vs. Wire)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\net\CReplayClient.h / CReplayClient.cpp:232 (Start), :172 (Process)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\net\IMessageReceiver.h (CMessageDispatcher, 256-slot receiver table)
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
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\serialization\SSavedGameHeader.h (version 20) + SSavedGameArmyInfo.h
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\gpg\core\containers\WriteArchive.h / ReadArchive.h / ArchiveSerialization.h (ArchiveToken, TrackedPointerState, TypeHandle)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\gpg\core\streams\BinaryReader.cpp:175 (ReadString strz), :207 (ReadLengthPrefixedString u32)
- https://github.com/FAForever/faf-scfa-replay-parser (replay.ksy + replay_parser/header.py — confirms replay header layout)
- https://github.com/Askaholic/faf-replay-parser-python (Rust-Parser, extract_scfa)
- https://forum.faforever.com/topic/1551/faf-scfa-replay-parser-library (.fafreplay: JSON-Zeile + v1 base64/zlib, v2 zstd)
