/**
 * The two picture layouts found inside DAX blocks, plus the heuristics that tell
 * them apart. A DAX block carries no type tag: the original game knew what it had
 * asked for, so identification is by trial fit, exactly as Gold Box Explorer does it.
 */

import { has, u16, u32, u8 } from './bytes.js'
import { decode4bpp, usesCombatPalette, type PaletteOptions, type Rgba } from './ega.js'

export type BlockKind = 'image' | 'sprite' | 'walldef' | 'geo' | 'unknown'

export interface DecodedImage {
  frames: Rgba[]
  /** Where the block asked to be drawn on the 320x200 screen, in pixels. */
  origin: { x: number; y: number }
  /** Per-frame delay in ticks, sprites only. */
  delays?: number[]
}

const IMAGE_HEADER_SIZE = 17
const SPRITE_FRAME_HEADER_SIZE = 21

/** Header shared by the plain image layout. */
function readImageHeader(data: Uint8Array) {
  const heightPx = u16(data, 0)
  const widthCells = u16(data, 2)
  const xCells = u16(data, 4)
  const yCells = u16(data, 6)
  const count = u8(data, 8)
  return { heightPx, widthCells, xCells, yCells, count }
}

/**
 * A plain image block: one header, then `count` same-sized frames back to back.
 * Used for backdrops, portraits, and the 8x8 tile sets the walls are built from.
 */
export function isImageBlock(data: Uint8Array): boolean {
  if (data.length < IMAGE_HEADER_SIZE) return false
  const { heightPx, widthCells, count } = readImageHeader(data)
  const widthPx = widthCells * 8
  if (widthPx === 0 || heightPx === 0 || widthPx > 320 || heightPx > 200) return false

  const frameSize = heightPx * widthCells * 4
  if (frameSize === 0) return false
  // Death Knights of Krynn stores one more frame than it declares.
  return data.length === frameSize * count + IMAGE_HEADER_SIZE ||
    data.length === frameSize * (count + 1) + IMAGE_HEADER_SIZE
}

export function decodeImageBlock(data: Uint8Array, fileName = ''): DecodedImage {
  const { heightPx, widthCells, xCells, yCells, count } = readImageHeader(data)
  const frameSize = heightPx * widthCells * 4
  const declared = data.length === frameSize * (count + 1) + IMAGE_HEADER_SIZE ? count + 1 : count

  const options: PaletteOptions = usesCombatPalette(fileName)
    ? { combat: true, transparentIndex: 0 }
    : {}

  const frames: Rgba[] = []
  for (let i = 0; i < declared; i++) {
    frames.push(decode4bpp(data, IMAGE_HEADER_SIZE + i * frameSize, widthCells, heightPx, options))
  }

  return { frames, origin: { x: xCells * 8, y: yCells * 8 } }
}

/**
 * A sprite block: a frame count, then per-frame headers each followed by pixels.
 * Animated portraits and monster art use this.
 */
export function isSpriteBlock(data: Uint8Array): boolean {
  if (data.length < 1) return false
  const frames = u8(data, 0)
  if (frames === 0 || frames > 8) return false

  let offset = 1
  for (let f = 0; f < frames; f++) {
    if (!has(data, offset, SPRITE_FRAME_HEADER_SIZE)) return false
    const heightPx = u16(data, offset + 4)
    const widthCells = u16(data, offset + 6)
    const widthPx = widthCells * 8
    if (widthPx < 1 || heightPx < 1 || widthPx > 320 || heightPx > 200) return false

    offset += SPRITE_FRAME_HEADER_SIZE
    const frameSize = heightPx * widthCells * 4
    if (!has(data, offset, frameSize)) return false
    offset += frameSize
  }
  // A sprite block accounts for every byte; anything left over means this is something else.
  return offset === data.length
}

export function decodeSpriteBlock(data: Uint8Array, fileName = ''): DecodedImage {
  const upper = fileName.toUpperCase()
  // PIC and FINAL animations store frames after the first as XOR deltas against frame 0.
  const xorFrames = upper.startsWith('PIC') || upper.startsWith('FINAL')
  const options: PaletteOptions = upper.startsWith('SPRI')
    ? { transparentIndex: 0 }
    : usesCombatPalette(fileName)
      ? { combat: true, transparentIndex: 0 }
      : {}

  const frameCount = u8(data, 0)
  const frames: Rgba[] = []
  const delays: number[] = []
  let offset = 1
  let firstFramePixels: Uint8Array | null = null
  let originX = 0
  let originY = 0

  for (let f = 0; f < frameCount; f++) {
    if (!has(data, offset, SPRITE_FRAME_HEADER_SIZE)) break
    delays.push(u32(data, offset))
    const heightPx = u16(data, offset + 4)
    const widthCells = u16(data, offset + 6)
    if (f === 0) {
      originX = u16(data, offset + 8) * 8
      originY = u16(data, offset + 10) * 8
    }
    offset += SPRITE_FRAME_HEADER_SIZE

    const frameSize = heightPx * widthCells * 4
    if (!has(data, offset, frameSize)) break

    let pixelSource = data
    let pixelOffset = offset
    if (xorFrames) {
      if (f === 0) {
        firstFramePixels = data.slice(offset, offset + frameSize)
      } else if (firstFramePixels) {
        // Undo the delta into a scratch buffer rather than mutating the caller's block.
        const resolved = new Uint8Array(frameSize)
        for (let i = 0; i < frameSize; i++) resolved[i] = data[offset + i]! ^ (firstFramePixels[i] ?? 0)
        pixelSource = resolved
        pixelOffset = 0
      }
    }

    frames.push(decode4bpp(pixelSource, pixelOffset, widthCells, heightPx, options))
    offset += frameSize
  }

  return { frames, origin: { x: originX, y: originY }, delays }
}

/**
 * Best guess at what a block holds. Order matters: the wall and geometry layouts
 * are exact-size matches and so are cheap to rule in first.
 */
export function classifyBlock(data: Uint8Array, fileName = ''): BlockKind {
  const upper = fileName.toUpperCase()
  if (upper.startsWith('GEO') && data.length >= 1026) return 'geo'
  if (upper.startsWith('WALLDEF') && data.length >= 156 && data.length % 156 === 0) return 'walldef'
  if (isImageBlock(data)) return 'image'
  if (isSpriteBlock(data)) return 'sprite'
  return 'unknown'
}

/** Decodes whatever pictures a block holds, or null if it is not a picture. */
export function decodeAnyImage(data: Uint8Array, fileName = ''): DecodedImage | null {
  if (isImageBlock(data)) return decodeImageBlock(data, fileName)
  if (isSpriteBlock(data)) return decodeSpriteBlock(data, fileName)
  return null
}
