/**
 * Synthetic Gold Box files, built to the format spec so the readers can be tested
 * without shipping anyone's game data.
 */

import { DAX_HEADER_ENTRY_SIZE } from '../src/formats/dax.js'

/** Run-length encodes a buffer the way the original packer did. */
export function encodeRle(raw: Uint8Array): Uint8Array {
  const out: number[] = []
  let i = 0

  while (i < raw.length) {
    let run = 1
    while (i + run < raw.length && raw[i + run] === raw[i] && run < 127) run++

    if (run >= 2) {
      out.push(256 - run, raw[i]!)
      i += run
    } else {
      const start = i
      const literal: number[] = []
      while (i < raw.length && literal.length < 128) {
        const sameAsNext = i + 1 < raw.length && raw[i + 1] === raw[i]
        const sameAsAfter = i + 2 < raw.length && raw[i + 2] === raw[i]
        if (sameAsNext && sameAsAfter && i > start) break
        literal.push(raw[i]!)
        i++
      }
      out.push(literal.length - 1, ...literal)
    }
  }

  return Uint8Array.from(out)
}

export interface FixtureBlock {
  id: number
  data: Uint8Array
  /** Store the payload uncompressed (rawSize 0 in the index). */
  stored?: boolean
}

/** Assembles a DAX archive around the given blocks. */
export function buildDax(blocks: readonly FixtureBlock[]): Uint8Array {
  const headerBytes = blocks.length * DAX_HEADER_ENTRY_SIZE
  const header = new Uint8Array(2 + headerBytes)
  const view = new DataView(header.buffer)
  view.setUint16(0, headerBytes, true)

  const payloads: Uint8Array[] = []
  let offset = 0

  blocks.forEach((block, index) => {
    const payload = block.stored ? block.data : encodeRle(block.data)
    const at = 2 + index * DAX_HEADER_ENTRY_SIZE
    header[at] = block.id
    view.setInt32(at + 1, offset, true)
    view.setUint16(at + 5, block.stored ? 0 : block.data.length, true)
    view.setUint16(at + 7, payload.length, true)
    payloads.push(payload)
    offset += payload.length
  })

  const total = header.length + payloads.reduce((n, p) => n + p.length, 0)
  const file = new Uint8Array(total)
  file.set(header, 0)
  let at = header.length
  for (const payload of payloads) {
    file.set(payload, at)
    at += payload.length
  }
  return file
}

/** A plain image block: `count` frames of widthCells x heightPx, filled with `fill`. */
export function buildImageBlock(
  widthCells: number,
  heightPx: number,
  count: number,
  fill: (frame: number, index: number) => number,
): Uint8Array {
  const frameSize = heightPx * widthCells * 4
  const data = new Uint8Array(17 + frameSize * count)
  const view = new DataView(data.buffer)
  view.setUint16(0, heightPx, true)
  view.setUint16(2, widthCells, true)
  view.setUint16(4, 0, true)
  view.setUint16(6, 0, true)
  data[8] = count

  for (let f = 0; f < count; f++) {
    for (let i = 0; i < frameSize; i++) data[17 + f * frameSize + i] = fill(f, i)
  }
  return data
}

/** A GEO level block. `walls(row, col)` returns the four wall nibbles. */
export function buildGeoBlock(
  walls: (row: number, col: number) => { n: number; e: number; s: number; w: number },
  doors: (row: number, col: number) => number = () => 0,
  events: (row: number, col: number) => number = () => 0,
): Uint8Array {
  const data = new Uint8Array(1026)
  for (let i = 0; i < 256; i++) {
    const row = i >> 4
    const col = i & 0x0f
    const { n, e, s, w } = walls(row, col)
    data[2 + i] = ((n & 0x0f) << 4) | (e & 0x0f)
    data[258 + i] = ((s & 0x0f) << 4) | (w & 0x0f)
    data[514 + i] = events(row, col)
    data[770 + i] = doors(row, col)
  }
  return data
}

/** A WALLDEF block of `wallCount` walls, each view filled with a known tile index. */
export function buildWallDefBlock(wallCount: number, tileFor: (wall: number, byte: number) => number): Uint8Array {
  const data = new Uint8Array(wallCount * 156)
  for (let wall = 0; wall < wallCount; wall++) {
    for (let i = 0; i < 156; i++) data[wall * 156 + i] = tileFor(wall, i)
  }
  return data
}

// ---- ECL bytecode ---------------------------------------------------------

/** Operand forms an ECL instruction can take, mirroring the VM's operand codes. */
export type EclArg =
  | { imm: number }   // code 0x00, a literal byte
  | { mem: number }   // code 0x01, read from an address
  | { word: number }  // code 0x02, a literal word
  | { str: string }   // code 0x80, a compressed string inline
  | { strAt: number } // code 0x81, the address of a string

/** Packs text six bits per character, four characters to three bytes. */
export function compressEclString(text: string): Uint8Array {
  const codes = [...text].map((character) => {
    const ascii = character.charCodeAt(0)
    return ascii >= 0x40 && ascii <= 0x5f ? ascii - 0x40 : ascii & 0x3f
  })
  while (codes.length % 4 !== 0) codes.push(0)

  const out: number[] = []
  for (let i = 0; i < codes.length; i += 4) {
    const [c0, c1, c2, c3] = [codes[i]!, codes[i + 1]!, codes[i + 2]!, codes[i + 3]!]
    out.push(((c0 << 2) | (c1 >> 4)) & 0xff)
    out.push((((c1 & 0x0f) << 4) | (c2 >> 2)) & 0xff)
    out.push((((c2 & 0x03) << 6) | c3) & 0xff)
  }
  return Uint8Array.from(out)
}

function encodeArg(arg: EclArg): number[] {
  if ('imm' in arg) return [0x00, arg.imm & 0xff]
  if ('mem' in arg) return [0x01, arg.mem & 0xff, (arg.mem >> 8) & 0xff]
  if ('word' in arg) return [0x02, arg.word & 0xff, (arg.word >> 8) & 0xff]
  if ('strAt' in arg) return [0x81, arg.strAt & 0xff, (arg.strAt >> 8) & 0xff]
  const packed = compressEclString(arg.str)
  return [0x80, packed.length, ...packed]
}

/** One instruction: the opcode, then each operand's code/low/high bytes. */
export function eclInstruction(opcode: number, args: readonly EclArg[] = []): number[] {
  return [opcode, ...args.flatMap(encodeArg)]
}

/** A header entry: one unused byte, then a word operand. */
function eclHeaderEntry(address: number): number[] {
  return [0x00, 0x02, address & 0xff, (address >> 8) & 0xff]
}

export interface EclProgramSpec {
  memStart: number
  /** The five header addresses: vmRun, searchLocation, preCampCheck, campInterrupted, start. */
  header: readonly [number, number, number, number, number]
  /** Code to place at a given address. */
  code: readonly { at: number; bytes: number[] }[]
  /** Total image size; defaults to just past the last piece of code. */
  size?: number
}

/**
 * Assembles an ECL block. The two leading bytes are the ones the loader skips, so
 * the image proper starts at `memStart`.
 */
export function buildEclBlock(spec: EclProgramSpec): Uint8Array {
  const end = spec.size ?? Math.max(
    20,
    ...spec.code.map((piece) => piece.at - spec.memStart + piece.bytes.length),
  )
  const image = new Uint8Array(end)

  spec.header.forEach((address, index) => {
    image.set(eclHeaderEntry(address), index * 4)
  })

  for (const piece of spec.code) image.set(piece.bytes, piece.at - spec.memStart)

  const block = new Uint8Array(image.length + 2)
  block.set(image, 2)
  return block
}

/** Where code can start: just past the five four-byte header entries. */
export const ECL_CODE_START = 20
