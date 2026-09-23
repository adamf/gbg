/** A FileSource backed by a directory on disk. */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { FileSource } from '../formats/library.js'

export async function directorySource(path: string): Promise<FileSource> {
  const entries = await readdir(path, { withFileTypes: true })
  const byName = new Map<string, string>()
  for (const entry of entries) {
    // A symlink to a file counts: a test folder is often the game's files linked in plus a save.
    const file = entry.isFile() || (entry.isSymbolicLink() && (await stat(join(path, entry.name)).catch(() => undefined))?.isFile())
    if (file) byName.set(entry.name.toUpperCase(), join(path, entry.name))
  }

  return {
    list: () => [...byName.keys()],
    read: async (name) => {
      const file = byName.get(name.toUpperCase())
      if (!file) return undefined
      return new Uint8Array(await readFile(file))
    },
  }
}
