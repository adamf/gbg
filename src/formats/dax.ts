/**
 * DAX archives — the container every Gold Box asset lives in.
 *
 * Layout:
 *   u16  headerBytes          (the index size; block data starts at headerBytes + 2)
 *   headerBytes / 9 entries, each 9 bytes:
 *     u8   id                 (block id, unique-ish within the file)
 *     i32  offset             (from the start of the data area)
 *     u16  rawSize            (decompressed size; 0 means the block is stored)
 *     u16  compressedSize     (bytes on disk)
 *
 * Block payloads are run-length encoded with a signed opcode byte:
 *   n >= 0  copy the next n + 1 bytes literally
 *   n <  0  repeat the next byte -n times
 *
 * Derived from the Gold Box Explorer reader (github.com/simeonpilgrim/goldboxexplorer),
 * which in turn came from disassembly of the original SSI loaders.
 */

import { has, i32, u16, u8 } from './bytes.js'

export const DAX_HEADER_ENTRY_SIZE = 9

export interface DaxBlock {
  /** Block id from the archive index. Not necessarily unique — duplicates exist in the wild. */
  id: number
  /** Decompressed payload. */
  data: Uint8Array
  /** True when the index declared rawSize 0 and the payload was stored uncompressed. */
  stored: boolean
  /** Byte offset of the payload within the file, for diagnostics. */
  fileOffset: number
}

export interface DaxArchive {
  /** Upper-cased base name, e.g. "GEO1.DAX". Format heuristics key off this. */
  name: string
  blocks: DaxBlock[]
  /** Entries the reader could not decode, with the reason. Never throws on a bad block. */
  problems: string[]
}

interface HeaderEntry {
  id: number
  offset: number
  rawSize: number
  compressedSize: number
}

/**
 * Expands one RLE payload into `rawSize` bytes.
 *
 * Some shipped blocks over-run their declared length (the original loader wrote into a
 * fixed scratch buffer and did not care), so this stops at the output boundary rather
 * than failing. Returns however much was decoded.
 */
export function decompressRle(input: Uint8Array, rawSize: number): Uint8Array {
  const out = new Uint8Array(rawSize)
  let inPos = 0
  let outPos = 0

  while (inPos < input.length && outPos < rawSize) {
    const op = (u8(input, inPos) << 24) >> 24

    if (op >= 0) {
      const count = op + 1
      for (let i = 0; i < count; i++) {
        if (inPos + 1 + i >= input.length || outPos + i >= rawSize) break
        out[outPos + i] = input[inPos + 1 + i]!
      }
      inPos += count + 1
      outPos += count
    } else {
      const count = -op
      if (inPos + 1 >= input.length) break
      const value = input[inPos + 1]!
      for (let i = 0; i < count && outPos + i < rawSize; i++) out[outPos + i] = value
      inPos += 2
      outPos += count
    }
  }

  return out
}

/** Parses a DAX archive. Bad blocks are collected in `problems` rather than thrown. */
export function readDax(name: string, file: Uint8Array): DaxArchive {
  const problems: string[] = []
  const blocks: DaxBlock[] = []

  if (file.length < 2) return { name: name.toUpperCase(), blocks, problems: ['file shorter than 2 bytes'] }

  const headerBytes = u16(file, 0)
  const dataOffset = headerBytes + 2
  const entryCount = Math.floor(headerBytes / DAX_HEADER_ENTRY_SIZE)

  if (entryCount === 0 || !has(file, 2, headerBytes)) {
    return { name: name.toUpperCase(), blocks, problems: [`implausible header size ${headerBytes}`] }
  }

  const headers: HeaderEntry[] = []
  for (let i = 0; i < entryCount; i++) {
    const at = 2 + i * DAX_HEADER_ENTRY_SIZE
    headers.push({
      id: u8(file, at),
      offset: i32(file, at + 1),
      rawSize: u16(file, at + 5),
      compressedSize: u16(file, at + 7),
    })
  }

  for (const entry of headers) {
    const start = dataOffset + entry.offset
    if (!has(file, start, entry.compressedSize)) {
      problems.push(`block ${entry.id}: payload at ${start}+${entry.compressedSize} runs past end of file`)
      continue
    }
    if (entry.compressedSize === 0) continue

    const payload = file.subarray(start, start + entry.compressedSize)
    if (entry.rawSize <= 0) {
      blocks.push({ id: entry.id, data: payload.slice(), stored: true, fileOffset: start })
    } else {
      blocks.push({ id: entry.id, data: decompressRle(payload, entry.rawSize), stored: false, fileOffset: start })
    }
  }

  return { name: name.toUpperCase(), blocks, problems }
}

/** All blocks carrying `id`. Duplicate ids happen, so this returns a list. */
export function blocksById(archive: DaxArchive, id: number): DaxBlock[] {
  return archive.blocks.filter((b) => b.id === id)
}
