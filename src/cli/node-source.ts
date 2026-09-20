/** A FileSource backed by a directory on disk. */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { FileSource } from '../formats/library.js'

export async function directorySource(path: string): Promise<FileSource> {
  const entries = await readdir(path, { withFileTypes: true })
  const byName = new Map<string, string>()
  for (const entry of entries) {
    if (entry.isFile()) byName.set(entry.name.toUpperCase(), join(path, entry.name))
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
