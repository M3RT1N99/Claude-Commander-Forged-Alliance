import { parseXsb, type XsbBank } from '../formats/xsb'
import { parseXwb, type XwbBank } from '../formats/xwb'
import { parseXgs, type XgsData } from '../formats/xgs'
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
 * Stufe-1-Grenzen (dokumentiert): keine Loop-Auswertung (Musik spielt einen
 * Durchlauf), keine Zufalls-Variation (xsb.ts nimmt Playlist-Eintrag 0),
 * keine Instanz-Limits/Fades je Kategorie.
 *
 * KATEGORIE-LAUTSTÄRKEN (SupCom.xgs): every cue's sound carries a 0-based
 * category index; the xgs category table gives name, parent and the
 * authorized volume (dB byte). Per category one GainNode with
 * gain = authorizedLinear x userVolume, chained along the parent to
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
  /** inner WaveBank name (small) → VFS path of the .xwb. */
  private readonly waveBankFiles = new Map<string, string>()
  /** inner WaveBank name (small) → lazy loaded bank (bytes + metadata). */
  private readonly waveBanks = new Map<string, Promise<{ bank: XwbBank; bytes: Uint8Array } | null>>()
  /** Handle ID (from UI VM) → running source. */
  private readonly playing = new Map<number, AudioBufferSourceNode>()
  private readonly missWarned = new Set<string>()
  /** Cues played — the evidence counter for the self-test. */
  playedCount = 0

  private constructor(
    private readonly vfs: GameVfs,
    private readonly log: (msg: string) => void,
  ) {
    this.ctx = new AudioContext()
    // Autoplay policy: the context starts suspended until a user gesture
    // comes — the first click/button press wakes him up.
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

    // All sound banks (small): Bank name → Cues.
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

    // Wave bank names via header scan (inner name @0x3C..0x7C, WBND layout).
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

    // The global settings: category tree + authorized volumes (SupCom.xgs).
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
   * authorized gain (FAudio: current = authorized x set). cached; GetVolume
   * never reads back from the engine (Moho AudioEngine, Cfile:605038,
   * insert default 1.0).
   */
  setVolume(category: string, volume: number): void {
    this.userVolumes.set(category, volume)
    if (!this.xgs) return
    const i = this.xgs.categories.findIndex((c) => c.name === category)
    if (i < 0) {
      this.warnOnce(`SetVolume: Category '${category}' unknown`)
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

  /** __uiAudioSink: play a cue (StartSound, ui-globals.lua). */
  play(bankName: string, cueName: string, handleId: number): void {
    const sb = this.soundBanks.get(String(bankName ?? '').toLowerCase())
    if (!sb) {
      this.warnOnce(`Sound-Bank '${bankName}' unknown`)
      return
    }
    const cue = sb.cues.get(String(cueName ?? ''))
    if (!cue) {
      this.warnOnce(`Cue '${bankName}:${cueName}' not in the bank`)
      return
    }
    const wbName = sb.waveBanks[cue.waveBankIndex]
    if (!wbName) return
    void this.waveBank(wbName).then((wb) => {
      if (!wb) return
      const entry = wb.bank.entries[cue.waveIndex]
      if (!entry) {
        this.warnOnce(`Wave ${cue.waveIndex} is missing in '${wbName}'`)
        return
      }
      // PCM16 → AudioBuffer, without decoder (all FA waves are PCM16).
      const frames = entry.length / entry.blockAlign
      const buffer = this.ctx.createBuffer(entry.channels, frames, entry.sampleRate)
      const pcm = new Int16Array(
        wb.bytes.buffer,
        wb.bytes.byteOffset + entry.offset,
        entry.length / 2,
      )
      for (let ch = 0; ch < entry.channels; ch++) {
        const out = buffer.getChannelData(ch)
        for (let i = 0; i < frames; i++) {
          out[i] = pcm[i * entry.channels + ch]! / 32768
        }
      }
      const source = this.ctx.createBufferSource()
      source.buffer = buffer
      // Route through the cue's XACT category node (authored volume x user
      // volume, chained to Global); without xgs data fall back to the raw
      // destination.
      const catNode = this.categoryNodes[cue.category]
      source.connect(catNode ?? this.ctx.destination)
      source.onended = () => this.playing.delete(handleId)
      this.playing.set(handleId, source)
      source.start()
      this.playedCount++
    })
  }

  /** __uiAudioStopSink: stop a running source via its handle ID. */
  stop(handleId: number): void {
    const source = this.playing.get(handleId)
    if (source) {
      try {
        source.stop()
      } catch {
        // already finished
      }
      this.playing.delete(handleId)
    }
  }

  dispose(): void {
    for (const s of this.playing.values()) {
      try {
        s.stop()
      } catch {
        // already finished
      }
    }
    this.playing.clear()
    void this.ctx.close()
  }
}
