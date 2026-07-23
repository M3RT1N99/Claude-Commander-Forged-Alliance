import { parseXsb, type XsbBank, type XsbCueTarget, type XsbPlaylistEntry } from '../formats/xsb'
import { parseXwb, type XwbBank } from '../formats/xwb'
import { parseXgs, xactVolumeByteToDb, type XgsData } from '../formats/xgs'
import type { GameVfs } from '../vfs/vfs'

/**
 * Die Audio-Ausgabe — das Browser-Ende der XACT-Kette.
 *
 * Die Engine lädt beim Start alle Sound-Banks aus <FA>/sounds/
 * (AudioEngine::Create("/sounds"), effects-audio.md §4) und löst Cues über
 * Bank-Name → .xsb → Sound → (WaveBank, Wave-Index) → .xwb-PCM auf. Genau
 * das passiert hier: die .xsb sind klein und werden komplett geladen; die
 * .xwb (bis ~100 MB) lazy pro Bank beim ersten Cue.
 *
 * Auflösungs-Fallen (gemessen, docs/research/effects-audio.md §4):
 *  - Die .xsb referenziert Wave-Banks über deren INNEREN Namen
 *    (XAS_Weapons.xwb heißt intern 'XAS_Weapon') — deshalb der Header-Scan
 *    über alle .xwb statt Dateinamen-Raterei.
 *  - Alle FA-Waves sind PCM16 — der AudioBuffer entsteht direkt aus den
 *    Samples, ohne Decoder.
 *
 * XACT playback semantics (behavioral model: FAudio, the open XACT
 * reimplementation — FA itself just hosts the XACT2 COM engine,
 * Cfile:602172-602219):
 *  - LOOPS: PlayWave loopCount 255 = infinite (FACT_internal.c:272-277);
 *    without track variation the wave voice loops the whole buffer
 *    (FA wave-bank LoopRegions are all 0 — measured over 4,349 waves);
 *    with "new variation on loop" (exactly Music:Base_Building/Battle)
 *    each iteration re-rolls the next track (FACT_upstream.c:556-570).
 *  - VARIATION: all 123 FA track variations are RandomNoRepeats —
 *    weighted pick excluding the previous index (FACT_internal.c:208-245).
 *  - EFFECT VARIATION: pitch in cents (2^(pitch/1200),
 *    FACT_upstream.c:2151), volume as random dB via the volume-byte curve;
 *    flag semantics 0x80=pitch/0x40=volume are inferred from range
 *    correlation over 1,675 events (named gap in the research report).
 *  - INSTANCE LIMITS: cue level first, then category level
 *    (play_sound, FACT_internal.c:821-864). Behaviors: 0 FailToPlay,
 *    1 Queue / 2 ReplaceOldest (both replace the oldest — FAudio parity,
 *    :555-561), 3 ReplaceQuietest (stubbed upstream → oldest), 4
 *    ReplaceLowestPriority (sound priority byte, :569-576). The replaced
 *    instance fades out over fadeOutMs, the new one fades in over
 *    fadeInMs (linear ramps, :579-596) — Music limit=1/ReplaceOldest/
 *    200 ms IS the music crossfade.
 *
 * KATEGORIE-LAUTSTÄRKEN (SupCom.xgs): every cue's sound carries a 0-based
 * category index; the xgs category table gives name, parent and the
 * authored volume (dB byte). Per category one GainNode with
 * gain = authoredLinear x userVolume, chained along the parent to
 * 'Global' -> destination (FAudio semantics; the engine caches the user
 * float and never reads it back — AudioEngine::SetVolume/GetVolume,
 * Cfile:603714/605038).
 */
export class GameAudio {
  private readonly ctx: AudioContext
  /** xgs categories in file order (= xsb category index). */
  private xgs: XgsData | null = null
  private categoryNodes: GainNode[] = []
  /** User volume per category NAME — SetVolume cache, default 1.0. */
  private readonly userVolumes = new Map<string, number>()
  /** soundBankName (klein) → geparste .xsb. */
  private readonly soundBanks = new Map<string, XsbBank>()
  /** innerer WaveBank-Name (klein) → VFS-Pfad der .xwb. */
  private readonly waveBankFiles = new Map<string, string>()
  /** innerer WaveBank-Name (klein) → lazy geladene Bank (Bytes + Metadaten). */
  private readonly waveBanks = new Map<string, Promise<{ bank: XwbBank; bytes: Uint8Array } | null>>()
  /** Handle-ID (aus der UI-VM) → laufende Instanz. */
  private readonly playing = new Map<number, PlayingInstance>()
  /** RandomNoRepeats memory: cue key → last picked playlist index. */
  private readonly lastVariant = new Map<string, number>()
  /** Monotonic age stamp — REPLACE_OLDEST picks the smallest. */
  private nextSeq = 1
  private readonly missWarned = new Set<string>()
  /** Abgespielte Cues — der Beweiszähler für den Selbsttest. */
  playedCount = 0

  private constructor(
    private readonly vfs: GameVfs,
    private readonly log: (msg: string) => void,
  ) {
    this.ctx = new AudioContext()
    // Autoplay-Policy: der Context startet suspended, bis eine Nutzergeste
    // kommt — der erste Klick/Tastendruck weckt ihn.
    const wecken = (): void => {
      void this.ctx.resume()
      window.removeEventListener('pointerdown', wecken, true)
      window.removeEventListener('keydown', wecken, true)
    }
    window.addEventListener('pointerdown', wecken, true)
    window.addEventListener('keydown', wecken, true)
  }

  static async create(vfs: GameVfs, log: (msg: string) => void): Promise<GameAudio | null> {
    if (typeof AudioContext === 'undefined') return null
    const audio = new GameAudio(vfs, log)

    // Alle Sound-Banks (klein): Bank-Name → Cues.
    const xsbPaths = vfs.find((p) => p.startsWith('sounds/') && p.endsWith('.xsb'))
    const xsbBytes = await vfs.readMany(xsbPaths)
    for (const [path, bytes] of xsbBytes) {
      try {
        const bank = parseXsb(bytes)
        audio.soundBanks.set(bank.soundBankName.toLowerCase(), bank)
      } catch (e) {
        log(`Audio: ${path} unlesbar — ${e instanceof Error ? e.message : e}`)
      }
    }

    // Wave-Bank-Namen per Header-Scan (innerer Name @0x3C..0x7C, WBND-Layout).
    const xwbPaths = vfs.find((p) => p.startsWith('sounds/') && p.endsWith('.xwb'))
    for (const path of xwbPaths) {
      try {
        const head = await vfs.readSlice(path, 0, 0x7c)
        if (head.length < 0x7c) continue
        let end = 0x3c
        while (end < 0x7c && head[end] !== 0) end++
        const name = new TextDecoder('ascii').decode(head.subarray(0x3c, end))
        audio.waveBankFiles.set(name.toLowerCase(), path)
      } catch (e) {
        log(`Audio: ${path} Header unlesbar — ${e instanceof Error ? e.message : e}`)
      }
    }

    // The global settings: category tree + authored volumes (SupCom.xgs).
    // Missing file is loud, not silent — without it every cue runs untinted
    // through the destination and the volume options do nothing.
    try {
      const xgsPath = vfs.find((p) => p.startsWith('sounds/') && p.endsWith('.xgs'))[0]
      if (!xgsPath) throw new Error('no .xgs under sounds/')
      audio.xgs = parseXgs(await vfs.read(xgsPath))
      audio.buildCategoryNodes()
      log(`Audio: ${audio.xgs.categories.length} XACT-Kategorien (${xgsPath})`)
    } catch (e) {
      log(`Audio: GlobalSettings fehlen — ${e instanceof Error ? e.message : e}`)
    }

    log(`Audio: ${audio.soundBanks.size} Sound-Banks, ${audio.waveBankFiles.size} Wave-Banks bereit`)
    return audio
  }

  /** One GainNode per category, chained along `parent` up to destination. */
  private buildCategoryNodes(): void {
    if (!this.xgs) return
    const cats = this.xgs.categories
    this.categoryNodes = cats.map((c) => {
      const node = this.ctx.createGain()
      node.gain.value = c.volumeLinear
      return node
    })
    for (let i = 0; i < cats.length; i++) {
      const parent = cats[i]!.parent
      const target = parent >= 0 ? this.categoryNodes[parent]! : this.ctx.destination
      this.categoryNodes[i]!.connect(target)
    }
  }

  /**
   * SetVolume(category, float) — the raw user float, multiplied onto the
   * authored gain (FAudio: current = authored x set). Cached; GetVolume
   * never reads back from the engine (Moho AudioEngine, Cfile:605038,
   * insert-default 1.0).
   */
  setVolume(category: string, volume: number): void {
    this.userVolumes.set(category, volume)
    if (!this.xgs) return
    const i = this.xgs.categories.findIndex((c) => c.name === category)
    if (i < 0) {
      this.warnOnce(`SetVolume: Kategorie '${category}' unbekannt`)
      return
    }
    this.categoryNodes[i]!.gain.value = this.xgs.categories[i]!.volumeLinear * volume
  }

  getVolume(category: string): number {
    return this.userVolumes.get(category) ?? 1.0
  }

  private waveBank(innerName: string): Promise<{ bank: XwbBank; bytes: Uint8Array } | null> {
    const key = innerName.toLowerCase()
    let p = this.waveBanks.get(key)
    if (!p) {
      p = (async () => {
        const path = this.waveBankFiles.get(key)
        if (!path) {
          this.warnOnce(`WaveBank '${innerName}' nicht gefunden`)
          return null
        }
        const bytes = await this.vfs.read(path)
        return { bank: parseXwb(bytes), bytes }
      })()
      this.waveBanks.set(key, p)
    }
    return p
  }

  private warnOnce(msg: string): void {
    if (this.missWarned.has(msg)) return
    this.missWarned.add(msg)
    this.log(`Audio: ${msg}`)
  }

  /** PCM16 wave -> AudioBuffer (all FA waves are PCM16, no decoder). */
  private makeBuffer(
    wb: { bank: XwbBank; bytes: Uint8Array },
    waveIndex: number,
    wbName: string,
  ): AudioBuffer | null {
    const entry = wb.bank.entries[waveIndex]
    if (!entry) {
      this.warnOnce(`Wave ${waveIndex} fehlt in '${wbName}'`)
      return null
    }
    const frames = entry.length / entry.blockAlign
    const buffer = this.ctx.createBuffer(entry.channels, frames, entry.sampleRate)
    const pcm = new Int16Array(wb.bytes.buffer, wb.bytes.byteOffset + entry.offset, entry.length / 2)
    for (let ch = 0; ch < entry.channels; ch++) {
      const out = buffer.getChannelData(ch)
      for (let i = 0; i < frames; i++) {
        out[i] = pcm[i * entry.channels + ch]! / 32768
      }
    }
    return buffer
  }

  /**
   * RandomNoRepeats (FACT_internal.c:208-245): weighted pick over the
   * playlist (weight = weightMax − weightMin), excluding the previous
   * index while more than one entry exists. All 123 FA track variations
   * use exactly this selector (measured).
   */
  private pickVariant(cueKey: string, playlist: XsbPlaylistEntry[]): XsbPlaylistEntry {
    const last = this.lastVariant.get(cueKey) ?? -1
    const cands: { e: XsbPlaylistEntry; i: number; w: number }[] = []
    for (let i = 0; i < playlist.length; i++) {
      if (playlist.length > 1 && i === last) continue
      const e = playlist[i]!
      cands.push({ e, i, w: Math.max(1, e.weightMax - e.weightMin) })
    }
    let roll = Math.random() * cands.reduce((s, c) => s + c.w, 0)
    let pick = cands[cands.length - 1]!
    for (const c of cands) {
      roll -= c.w
      if (roll <= 0) {
        pick = c
        break
      }
    }
    this.lastVariant.set(cueKey, pick.i)
    return pick.e
  }

  /**
   * Enforce one instance limit (handle_instance_limit,
   * FACT_internal.c:541-596). Returns false when the NEW play must fail.
   */
  private admitAgainst(
    insts: PlayingInstance[],
    limit: number,
    behavior: number,
    fadeOutMs: number,
  ): boolean {
    if (insts.length < limit) return true
    if (behavior === 0) return false // FailToPlay (:541-545)
    let victim: PlayingInstance | null = null
    if (behavior === 4) {
      // ReplaceLowestPriority: the sound header priority byte (:569-576).
      for (const i of insts) if (!victim || i.priority < victim.priority) victim = i
    } else {
      // Queue/ReplaceOldest both replace the oldest (:555-561); Quietest is
      // stubbed upstream and lands on the oldest here too.
      for (const i of insts) if (!victim || i.seq < victim.seq) victim = i
    }
    if (victim) this.fadeOutAndStop(victim, fadeOutMs)
    return true
  }

  private fadeOutAndStop(inst: PlayingInstance, fadeOutMs: number): void {
    inst.stopped = true
    this.playing.delete(inst.handleId)
    const t = this.ctx.currentTime
    if (fadeOutMs > 0) {
      inst.gain.gain.setValueAtTime(inst.gain.gain.value, t)
      inst.gain.gain.linearRampToValueAtTime(0, t + fadeOutMs / 1000)
      const src = inst.source
      if (src) {
        try {
          src.stop(t + fadeOutMs / 1000)
        } catch {
          // schon beendet
        }
      }
    } else {
      try {
        inst.source?.stop()
      } catch {
        // schon beendet
      }
    }
  }

  /** __uiAudioSink: eine Cue abspielen (StartSound, ui-globals.lua). */
  play(bankName: string, cueName: string, handleId: number): void {
    const bankKey = String(bankName ?? '').toLowerCase()
    const sb = this.soundBanks.get(bankKey)
    if (!sb) {
      this.warnOnce(`Sound-Bank '${bankName}' unbekannt`)
      return
    }
    const cue = sb.cues.get(String(cueName ?? ''))
    if (!cue) {
      this.warnOnce(`Cue '${bankName}:${cueName}' nicht in der Bank`)
      return
    }
    const cueKey = `${bankKey}:${cueName}`

    // Instance limits BEFORE anything plays — cue level first, then the
    // category (play_sound order, FACT_internal.c:821-864). The check runs
    // synchronously so same-beat bursts count each other.
    const live = [...this.playing.values()].filter((i) => !i.stopped)
    if (
      !this.admitAgainst(
        live.filter((i) => i.cueKey === cueKey),
        cue.instanceLimit,
        cue.limitBehavior,
        cue.fadeOutMs,
      )
    ) {
      return
    }
    const cat = this.xgs?.categories[cue.category]
    if (
      cat &&
      !this.admitAgainst(
        live.filter((i) => i.category === cue.category && !i.stopped),
        cat.instanceLimit,
        cat.instanceFlags >> 3,
        cat.fadeOutMs,
      )
    ) {
      return
    }

    const gain = this.ctx.createGain()
    gain.connect(this.categoryNodes[cue.category] ?? this.ctx.destination)
    const inst: PlayingInstance = {
      handleId,
      source: null,
      gain,
      cueKey,
      category: cue.category,
      priority: cue.priority,
      seq: this.nextSeq++,
      stopped: false,
      loopsLeft: cue.loopCount > 0 && cue.loopCount < 255 ? cue.loopCount : 0,
    }
    this.playing.set(handleId, inst)

    const fadeInMs = Math.max(cue.fadeInMs, cat?.fadeInMs ?? 0)
    const startSource = (buffer: AudioBuffer, restart: boolean): void => {
      if (inst.stopped) return
      const source = this.ctx.createBufferSource()
      source.buffer = buffer
      // Effect variation (types 4/6): pitch in cents, volume in dB via the
      // volume-byte curve (flag inference 0x80=pitch/0x40=volume).
      const ev = cue.effectVariation
      if (ev && (ev.flags & 0x80) !== 0 && ev.maxPitchCents > ev.minPitchCents) {
        const cents = ev.minPitchCents + Math.random() * (ev.maxPitchCents - ev.minPitchCents)
        source.playbackRate.value = Math.pow(2, cents / 1200)
      }
      let base = 1
      if (ev && (ev.flags & 0x40) !== 0 && ev.maxVolByte > ev.minVolByte) {
        const db =
          xactVolumeByteToDb(ev.minVolByte) +
          Math.random() * (xactVolumeByteToDb(ev.maxVolByte) - xactVolumeByteToDb(ev.minVolByte))
        base = Math.pow(10, db / 20)
      }
      if (!restart && fadeInMs > 0) {
        const t = this.ctx.currentTime
        gain.gain.setValueAtTime(0, t)
        gain.gain.linearRampToValueAtTime(base, t + fadeInMs / 1000)
      } else {
        gain.gain.value = base
      }
      source.connect(gain)
      // Infinite loop WITHOUT re-roll delegates to the wave voice
      // (FACT_internal.c:272-278); FA LoopRegions are all 0 = whole buffer.
      if (cue.loopCount === 255 && !(cue.playlist && cue.newVariationOnLoop)) {
        source.loop = true
      }
      source.onended = () => {
        if (inst.stopped || this.playing.get(handleId) !== inst) return
        if (cue.loopCount === 255 && cue.playlist && cue.newVariationOnLoop) {
          // Music re-arm: each iteration rolls the next random track
          // (FACTAudioEngine_DoWork, FACT_upstream.c:556-570).
          void this.loadVariantBuffer(sb, cue, cueKey).then((b) => {
            if (b && !inst.stopped) startSource(b, true)
          })
          return
        }
        if (inst.loopsLeft > 0) {
          // Finite loopCount (2 cues in FA) — replay (FACT_internal.c:443-452).
          inst.loopsLeft--
          startSource(buffer, true)
          return
        }
        this.playing.delete(handleId)
      }
      inst.source = source
      source.start()
    }

    void this.loadVariantBuffer(sb, cue, cueKey).then((buffer) => {
      if (!buffer) {
        this.playing.delete(handleId)
        return
      }
      if (inst.stopped) return
      startSource(buffer, false)
      this.playedCount++
    })
  }

  /** Load the cue's next wave (playlist pick or the single wave). */
  private async loadVariantBuffer(
    sb: XsbBank,
    cue: XsbCueTarget,
    cueKey: string,
  ): Promise<AudioBuffer | null> {
    const pick = cue.playlist ? this.pickVariant(cueKey, cue.playlist) : cue
    const wbName = sb.waveBanks[pick.waveBankIndex]
    if (!wbName) return null
    const wb = await this.waveBank(wbName)
    if (!wb) return null
    return this.makeBuffer(wb, pick.waveIndex, wbName)
  }

  /** __uiAudioStopSink: eine laufende Quelle über ihre Handle-ID beenden. */
  stop(handleId: number): void {
    const inst = this.playing.get(handleId)
    if (inst) {
      inst.stopped = true
      try {
        inst.source?.stop()
      } catch {
        // schon beendet
      }
      this.playing.delete(handleId)
    }
  }

  dispose(): void {
    for (const inst of this.playing.values()) {
      inst.stopped = true
      try {
        inst.source?.stop()
      } catch {
        // schon beendet
      }
    }
    this.playing.clear()
    void this.ctx.close()
  }
}

/** One playing cue instance (limits, fades, loop chain state). */
interface PlayingInstance {
  handleId: number
  source: AudioBufferSourceNode | null
  gain: GainNode
  cueKey: string
  category: number
  /** Sound header priority byte — REPLACE_LOWEST_PRIORITY compares it. */
  priority: number
  /** Age stamp; REPLACE_OLDEST picks the smallest. */
  seq: number
  stopped: boolean
  /** Remaining finite loop iterations (loopCount 1..254). */
  loopsLeft: number
}
