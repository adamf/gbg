/**
 * Getting the player's own game folder into the page.
 *
 * Nothing leaves the machine: the files are read in the browser and handed straight
 * to the parsers. There is no upload, no server, and no copy of anyone's game data
 * in this repository.
 */

import type { FileSource } from '../formats/library.js'

interface FileSystemDirectoryHandleLike {
  values(): AsyncIterableIterator<{ kind: string; name: string; getFile?(): Promise<File> }>
}

export function supportsDirectoryPicker(): boolean {
  return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
}

/** Builds a FileSource from a set of browser File objects, read on demand. */
export function sourceFromFiles(files: readonly File[]): FileSource {
  const byName = new Map<string, File>()
  for (const file of files) {
    const base = file.name.split(/[\\/]/).pop()!.toUpperCase()
    // Gold Box folders have no subdirectory collisions worth worrying about; first wins.
    if (!byName.has(base)) byName.set(base, file)
  }

  const cache = new Map<string, Promise<Uint8Array>>()

  return {
    list: () => [...byName.keys()],
    read: async (name) => {
      const key = name.toUpperCase()
      const file = byName.get(key)
      if (!file) return undefined
      let pending = cache.get(key)
      if (!pending) {
        pending = file.arrayBuffer().then((buffer) => new Uint8Array(buffer))
        cache.set(key, pending)
      }
      return pending
    },
  }
}

/** Opens the native folder picker, where the browser has one. */
export async function pickDirectory(): Promise<FileSource | undefined> {
  const picker = (globalThis as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandleLike> }).showDirectoryPicker
  if (!picker) return undefined

  const handle = await picker()
  const files: File[] = []
  for await (const entry of handle.values()) {
    if (entry.kind !== 'file' || !entry.getFile) continue
    files.push(await entry.getFile())
  }
  return sourceFromFiles(files)
}

/**
 * Dev server only: the folder Vite is serving at /dev-data/ (see vite.config.ts).
 * Returns undefined in a production build or when no folder was given.
 */
export async function devDataSource(): Promise<{ source: FileSource; folder: string } | undefined> {
  if (!import.meta.env.DEV) return undefined
  let index: { folder: string; names: string[] }
  try {
    const response = await fetch('/dev-data/index.json')
    if (!response.ok) return undefined
    index = await response.json()
  } catch {
    return undefined
  }
  const byName = new Map(index.names.map((name) => [name.toUpperCase(), name]))
  const cache = new Map<string, Promise<Uint8Array | undefined>>()
  const source: FileSource = {
    list: () => [...byName.keys()],
    read: (name) => {
      const key = name.toUpperCase()
      const real = byName.get(key)
      if (!real) return Promise.resolve(undefined)
      let pending = cache.get(key)
      if (!pending) {
        pending = fetch(`/dev-data/${encodeURIComponent(real)}`)
          .then((r) => (r.ok ? r.arrayBuffer().then((b) => new Uint8Array(b)) : undefined))
        cache.set(key, pending)
      }
      return pending
    },
  }
  return { source, folder: index.folder }
}
