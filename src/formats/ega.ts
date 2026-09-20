/**
 * The 16-colour EGA palette the DOS Gold Box games draw with, and the 4bpp
 * packed-pixel decoder every image block shares.
 *
 * Pixels are two-per-byte, high nibble first, with a row stride of `width * 4`
 * bytes where `width` counts 8-pixel cells. There are no bit planes: SSI
 * pre-swizzled the art into linear nibbles at build time.
 */

export interface Rgba {
  width: number
  height: number
  /** RGBA8888, length width * height * 4. */
  pixels: Uint8ClampedArray
}

/** Standard EGA, as RGB triples. */
export const EGA_PALETTE: readonly (readonly [number, number, number])[] = [
  [0x00, 0x00, 0x00], [0x00, 0x00, 0xaa], [0x00, 0xaa, 0x00], [0x00, 0xaa, 0xaa],
  [0xaa, 0x00, 0x00], [0xaa, 0x00, 0xaa], [0xaa, 0x55, 0x00], [0xaa, 0xaa, 0xaa],
  [0x55, 0x55, 0x55], [0x55, 0x55, 0xff], [0x55, 0xff, 0x55], [0x55, 0xff, 0xff],
  [0xff, 0x55, 0x55], [0xff, 0x55, 0xff], [0xff, 0xff, 0x55], [0xff, 0xff, 0xff],
]

/** Which palette index a decode should treat as transparent, if any. */
export interface PaletteOptions {
  /** Index rendered with alpha 0. Combat art uses 0; sprites use 0 as well. */
  transparentIndex?: number
  /**
   * Combat art swaps entries 0 and 8: index 0 is the transparent "background"
   * and index 8 is real black. Set for CPIC/CHEAD/CBODY/*COM/COMSPR files.
   */
  combat?: boolean
}

/** Filenames whose blocks use the combat palette (colour 0 transparent, 8 black). */
const COMBAT_FILE_MARKERS = ['CPIC', 'CHEAD', 'CBODY', 'DUNGCOM', 'WILDCOM', 'RANDCOM', 'COMSPR']

export function usesCombatPalette(fileName: string): boolean {
  const upper = fileName.toUpperCase()
  return COMBAT_FILE_MARKERS.some((marker) => upper.includes(marker))
}

/** Resolves a palette index to RGBA, honouring the combat swap and transparency. */
export function paletteEntry(index: number, options: PaletteOptions = {}): [number, number, number, number] {
  let lookup = index & 0x0f
  if (options.combat) {
    if (lookup === 0) lookup = 8
    else if (lookup === 8) lookup = 0
  }
  const alpha = options.transparentIndex !== undefined && (index & 0x0f) === options.transparentIndex ? 0 : 255
  const rgb = EGA_PALETTE[lookup]!
  return [rgb[0], rgb[1], rgb[2], alpha]
}

/**
 * Decodes one 4bpp image.
 *
 * @param widthCells width in 8-pixel cells (the field stored in the block header)
 * @param heightPx   height in pixels
 */
export function decode4bpp(
  data: Uint8Array,
  offset: number,
  widthCells: number,
  heightPx: number,
  options: PaletteOptions = {},
): Rgba {
  const widthPx = widthCells * 8
  const stride = widthCells * 4
  const pixels = new Uint8ClampedArray(widthPx * heightPx * 4)

  for (let y = 0; y < heightPx; y++) {
    for (let x = 0; x < widthPx; x += 2) {
      const byteAt = offset + y * stride + (x >> 1)
      const packed = byteAt < data.length ? data[byteAt]! : 0
      writePixel(pixels, widthPx, x, y, paletteEntry(packed >> 4, options))
      writePixel(pixels, widthPx, x + 1, y, paletteEntry(packed & 0x0f, options))
    }
  }

  return { width: widthPx, height: heightPx, pixels }
}

function writePixel(
  pixels: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  rgba: [number, number, number, number],
): void {
  const at = (y * width + x) * 4
  pixels[at] = rgba[0]
  pixels[at + 1] = rgba[1]
  pixels[at + 2] = rgba[2]
  pixels[at + 3] = rgba[3]
}

/** An empty image, used where a tile index points past the end of a tile set. */
export function blankRgba(width: number, height: number): Rgba {
  return { width, height, pixels: new Uint8ClampedArray(width * height * 4) }
}

/** Copies `src` into `dst` at (x, y), skipping fully transparent source pixels. */
export function blit(dst: Rgba, src: Rgba, x: number, y: number): void {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy
    if (dy < 0 || dy >= dst.height) continue
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx
      if (dx < 0 || dx >= dst.width) continue
      const from = (sy * src.width + sx) * 4
      if (src.pixels[from + 3] === 0) continue
      const to = (dy * dst.width + dx) * 4
      dst.pixels[to] = src.pixels[from]!
      dst.pixels[to + 1] = src.pixels[from + 1]!
      dst.pixels[to + 2] = src.pixels[from + 2]!
      dst.pixels[to + 3] = src.pixels[from + 3]!
    }
  }
}

/**
 * Swaps colours in a decoded image the way the combat screen coloured a party
 * member's icon: each pair is an old EGA index in the high nibble and the new one in
 * the low. Pixels are matched back to the palette by their RGB.
 */
export function recolour(image: Rgba, pairs: readonly number[]): Rgba {
  const swap = new Map<number, number>()
  for (const pair of pairs) swap.set(pair >> 4, pair & 0x0f)
  const out = new Uint8ClampedArray(image.pixels)
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) continue
    const index = EGA_PALETTE.findIndex(([r, g, b]) => r === out[i] && g === out[i + 1] && b === out[i + 2])
    const to = index >= 0 ? swap.get(index) : undefined
    if (to === undefined) continue
    const [r, g, b] = EGA_PALETTE[to]!
    out[i] = r
    out[i + 1] = g
    out[i + 2] = b
  }
  return { width: image.width, height: image.height, pixels: out }
}
