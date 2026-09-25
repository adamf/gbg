/**
 * A character's picture and combat icon, the way the original's character screens
 * put them together.
 *
 * The picture is a head over a body: a HEAD block (88×40 as decoded here) drawn above
 * a BODY block (88×48), 88×88 all told, the same size as a PIC. The record keeps the choice
 * at 0xBB (head) and 0xBC (body) as numbers from one up, each an index into a table
 * in START.EXE (at 0xE3B9 in the GOG build) that names the block: fourteen heads and
 * twelve bodies, all in the city's HEAD3.DAX and BODY3.DAX. The scripts show an
 * NPC's picture the same way: the body is PICTURE's operand when no PIC block has
 * that number, and the head is the word the script left at 0x6DE1, both from the
 * area's own files.
 *
 * The combat icon is a CHEAD strip (0xBD, fourteen of them) over a CBODY frame
 * (0xBE, thirty-two), small or large (0xC0), coloured by six pairs at 0xC1. The art
 * is drawn in six template colours, each with a bright twin eight above it; pair
 * `i` replaces template colour `ICON_TEMPLATE[i]` with its low nibble and the
 * bright twin with its high nibble. The editor called the pairs body, arm, leg,
 * hair-and-face, shield and weapon, and the nibbles COLOR-1 and COLOR-2.
 */

import type { Rgba } from './ega.js'

/** HEAD3.DAX block for picture head 1..14. */
export const PORTRAIT_HEADS: readonly number[] = [0, 8, 9, 13, 16, 18, 22, 34, 45, 51, 53, 57, 67, 68]
/** BODY3.DAX block for picture body 1..12. */
export const PORTRAIT_BODIES: readonly number[] = [1, 2, 3, 4, 7, 8, 18, 24, 26, 33, 35, 37]
/** The area whose HEAD and BODY files hold every picture the tables name. */
export const PORTRAIT_AREA = 3

export const PORTRAIT_WIDTH = 88
export const PORTRAIT_HEAD_HEIGHT = 40
export const PORTRAIT_BODY_HEIGHT = 48

/** The block a picture number names, wrapping the way the original's HEAD and BODY keys did. */
export function portraitHeadBlock(head: number): number {
  return PORTRAIT_HEADS[wrap(head - 1, PORTRAIT_HEADS.length)]!
}
export function portraitBodyBlock(body: number): number {
  return PORTRAIT_BODIES[wrap(body - 1, PORTRAIT_BODIES.length)]!
}

/** The number a step up or down from `value` in a cycle of `count` from one. */
export function stepPortrait(value: number, count: number, delta: number): number {
  return wrap(value - 1 + delta, count) + 1
}

function wrap(value: number, count: number): number {
  return ((value % count) + count) % count
}

/** The head above the body; either may be missing, leaving that part blank. The parts set the size. */
export function composePortrait(head: Rgba | undefined, body: Rgba | undefined): Rgba {
  const width = head?.width ?? body?.width ?? PORTRAIT_WIDTH
  const headHeight = head?.height ?? Math.round((width * PORTRAIT_HEAD_HEIGHT) / PORTRAIT_WIDTH)
  const bodyHeight = body?.height ?? Math.round((width * PORTRAIT_BODY_HEIGHT) / PORTRAIT_WIDTH)
  const out: Rgba = { width, height: headHeight + bodyHeight, pixels: new Uint8ClampedArray(width * (headHeight + bodyHeight) * 4) }
  if (body) paste(out, body, 0, headHeight)
  if (head) paste(out, head, 0, 0)
  return out
}

function paste(dst: Rgba, src: Rgba, x: number, y: number): void {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy
    if (dy < 0 || dy >= dst.height) continue
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx
      if (dx < 0 || dx >= dst.width) continue
      const from = (sy * src.width + sx) * 4
      if (src.pixels[from + 3] === 0) continue
      dst.pixels.set(src.pixels.subarray(from, from + 4), (dy * dst.width + dx) * 4)
    }
  }
}

// ---- the combat icon ----

/** The template colours the icon art is drawn in; pair i recolours this and this + 8. */
export const ICON_TEMPLATE: readonly number[] = [1, 2, 3, 4, 6, 7]
/** The pairs a new character starts with: every template colour kept as it is. */
export const DEFAULT_ICON_COLOURS: readonly number[] = ICON_TEMPLATE.map((c) => ((c + 8) << 4) | c)
/** What the original's editor called each pair, in pair order. */
export const ICON_PARTS: readonly { name: string; first: string; second: string }[] = [
  { name: 'Body', first: 'shade', second: 'light' },
  { name: 'Arm', first: 'shade', second: 'light' },
  { name: 'Leg', first: 'shade', second: 'light' },
  { name: 'Hair and face', first: 'hair', second: 'face' },
  { name: 'Shield', first: 'shade', second: 'light' },
  { name: 'Weapon', first: 'shade', second: 'light' },
]
export const ICON_HEADS = 14
export const ICON_WEAPONS = 32

/** A pair with one of its colours changed: `which` 0 is COLOR-1 (low nibble), 1 is COLOR-2 (high). */
export function withColour(pair: number, which: 0 | 1, colour: number): number {
  const c = colour & 0x0f
  return which === 0 ? (pair & 0xf0) | c : (pair & 0x0f) | (c << 4)
}
