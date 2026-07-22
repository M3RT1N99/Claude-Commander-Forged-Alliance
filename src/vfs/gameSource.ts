import { BlobFile, HttpRangeFile, type RandomAccessFile } from './randomAccess'

/**
 * Quelle für die Spieldateien. Die Assets bleiben immer auf dem Rechner des
 * Users (bring your own game) — es wird nichts hochgeladen oder verteilt.
 */
export interface GameDirEntry {
  name: string
  dir: boolean
  size: number
}

export interface GameSource {
  readonly label: string
  list(relDir: string): Promise<GameDirEntry[]>
  open(relPath: string): Promise<RandomAccessFile>
}

// ---------------------------------------------------------------------------
// File System Access API (Chrome/Edge): User wählt sein Spielverzeichnis.
// ---------------------------------------------------------------------------

export class FsaGameSource implements GameSource {
  readonly label: string

  constructor(private readonly root: FileSystemDirectoryHandle) {
    this.label = `Ordner: ${root.name}`
  }

  private async resolveDir(relDir: string): Promise<FileSystemDirectoryHandle> {
    let dir = this.root
    for (const seg of relDir.split(/[/\\]/).filter(Boolean)) {
      dir = await this.getChildDir(dir, seg)
    }
    return dir
  }

  /** Case-insensitive Verzeichnisnavigation (Windows-Semantik). */
  private async getChildDir(
    parent: FileSystemDirectoryHandle,
    name: string,
  ): Promise<FileSystemDirectoryHandle> {
    try {
      return await parent.getDirectoryHandle(name)
    } catch {
      const lower = name.toLowerCase()
      for await (const [entryName, handle] of parent.entries()) {
        if (handle.kind === 'directory' && entryName.toLowerCase() === lower) {
          return handle as FileSystemDirectoryHandle
        }
      }
      throw new Error(`Verzeichnis nicht gefunden: ${name}`)
    }
  }

  private async getChildFile(
    parent: FileSystemDirectoryHandle,
    name: string,
  ): Promise<FileSystemFileHandle> {
    try {
      return await parent.getFileHandle(name)
    } catch {
      const lower = name.toLowerCase()
      for await (const [entryName, handle] of parent.entries()) {
        if (handle.kind === 'file' && entryName.toLowerCase() === lower) {
          return handle as FileSystemFileHandle
        }
      }
      throw new Error(`Datei nicht gefunden: ${name}`)
    }
  }

  async list(relDir: string): Promise<GameDirEntry[]> {
    const dir = await this.resolveDir(relDir)
    const out: GameDirEntry[] = []
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file') {
        const file = await (handle as FileSystemFileHandle).getFile()
        out.push({ name, dir: false, size: file.size })
      } else {
        out.push({ name, dir: true, size: 0 })
      }
    }
    return out
  }

  async open(relPath: string): Promise<RandomAccessFile> {
    const segs = relPath.split(/[/\\]/).filter(Boolean)
    const fileName = segs.pop()
    if (!fileName) throw new Error(`Ungültiger Pfad: ${relPath}`)
    const dir = await this.resolveDir(segs.join('/'))
    const handle = await this.getChildFile(dir, fileName)
    return new BlobFile(await handle.getFile())
  }
}

// ---------------------------------------------------------------------------
// Fallback für Browser ohne File System Access API: <input webkitdirectory>
// ---------------------------------------------------------------------------

export class FileListGameSource implements GameSource {
  readonly label = 'Ordner (Datei-Auswahl)'
  /** Key: relativer Pfad in Kleinbuchstaben (ohne Wurzelordner-Namen). */
  private readonly files = new Map<string, File>()

  constructor(fileList: FileList) {
    for (const file of Array.from(fileList)) {
      const rel = file.webkitRelativePath.split('/').slice(1).join('/')
      if (rel) this.files.set(rel.toLowerCase(), file)
    }
  }

  async list(relDir: string): Promise<GameDirEntry[]> {
    const prefix = relDir ? `${relDir.toLowerCase().replace(/\/+$/, '')}/` : ''
    const seen = new Map<string, GameDirEntry>()
    for (const [path, file] of this.files) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash < 0) {
        seen.set(rest, { name: file.name, dir: false, size: file.size })
      } else {
        const dirName = rest.slice(0, slash)
        if (!seen.has(dirName)) seen.set(dirName, { name: dirName, dir: true, size: 0 })
      }
    }
    return [...seen.values()]
  }

  async open(relPath: string): Promise<RandomAccessFile> {
    const file = this.files.get(relPath.toLowerCase().replaceAll('\\', '/'))
    if (!file) throw new Error(`Datei nicht gefunden: ${relPath}`)
    return new BlobFile(file)
  }
}

// ---------------------------------------------------------------------------
// Dev-Modus: Vite-Middleware /gamefiles (siehe vite.config.ts)
// ---------------------------------------------------------------------------

export class HttpGameSource implements GameSource {
  readonly label = 'Dev-Server (lokale Installation)'

  constructor(private readonly base = '/gamefiles') {}

  async list(relDir: string): Promise<GameDirEntry[]> {
    const res = await fetch(`${this.base}/__list?dir=${encodeURIComponent(relDir)}`)
    if (!res.ok) throw new Error(`Dev-Server: HTTP ${res.status} für "${relDir}"`)
    return res.json()
  }

  open(relPath: string): Promise<RandomAccessFile> {
    return HttpRangeFile.open(
      `${this.base}/${relPath.split(/[/\\]/).map(encodeURIComponent).join('/')}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Persistenz des Directory-Handles (IndexedDB), damit der User den Ordner
// nicht bei jedem Besuch neu wählen muss.
// ---------------------------------------------------------------------------

const DB_NAME = 'claude-commander-fa'
const STORE = 'handles'
const KEY_GAME_DIR = 'gameDir'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveDirHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  // Ask the browser to protect our storage from eviction — without this a
  // storage-pressure cleanup can silently drop the saved handle.
  try {
    await navigator.storage?.persist?.()
  } catch {
    // persistence is best-effort
  }
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(handle, KEY_GAME_DIR)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

export async function loadDirHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDb()
    const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(KEY_GAME_DIR)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => reject(req.error)
    })
    db.close()
    return handle
  } catch {
    return null
  }
}
