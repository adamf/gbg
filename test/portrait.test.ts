import { describe, expect, it } from 'vitest'
import { EGA_PALETTE } from '../src/formats/ega.js'
import { composePortrait, DEFAULT_ICON_COLOURS, PORTRAIT_BODIES, PORTRAIT_HEADS, portraitBodyBlock, portraitHeadBlock, stepPortrait, withColour } from '../src/formats/portrait.js'
import { readCharacter } from '../src/formats/character.js'
import { writeCharacter } from '../src/formats/save-writer.js'

describe('a character’s picture and icon', () => {
  it('names the blocks the original’s tables did, from one, wrapping', () => {
    expect(PORTRAIT_HEADS).toHaveLength(14)
    expect(PORTRAIT_BODIES).toHaveLength(12)
    expect(portraitHeadBlock(1)).toBe(0)
    expect(portraitHeadBlock(4)).toBe(13)
    expect(portraitBodyBlock(3)).toBe(3)
    expect(portraitBodyBlock(9)).toBe(26)
    expect(portraitBodyBlock(13)).toBe(1)
    expect(stepPortrait(14, 14, 1)).toBe(1)
    expect(stepPortrait(1, 12, -1)).toBe(12)
  })

  it('puts the head above the body in a picture the size of a PIC', () => {
    const solid = (w: number, h: number, colour: number): { width: number; height: number; pixels: Uint8ClampedArray } => {
      const pixels = new Uint8ClampedArray(w * h * 4)
      const [r, g, b] = EGA_PALETTE[colour]!
      for (let i = 0; i < w * h; i++) pixels.set([r, g, b, 255], i * 4)
      return { width: w, height: h, pixels }
    }
    const out = composePortrait(solid(88, 40, 4), solid(88, 48, 1))
    expect([out.width, out.height]).toEqual([88, 88])
    const at = (x: number, y: number) => out.pixels[(y * 88 + x) * 4]
    expect(at(10, 10)).toBe(EGA_PALETTE[4]![0])
    expect(at(10, 60)).toBe(EGA_PALETTE[1]![0])
    const headless = composePortrait(undefined, solid(88, 48, 1))
    expect([headless.width, headless.height]).toEqual([88, 88])
    expect(headless.pixels[3]).toBe(0)
    expect(at(10, 60)).toBe(EGA_PALETTE[1]![0])
  })

  it('keeps a pair’s other colour when one is chosen, and starts every pair plain', () => {
    expect(withColour(0x91, 0, 4)).toBe(0x94)
    expect(withColour(0x91, 1, 12)).toBe(0xc1)
    expect(DEFAULT_ICON_COLOURS).toEqual([0x91, 0xa2, 0xb3, 0xc4, 0xe6, 0xf7])
  })
})

describe('the record’s picture and icon bytes', () => {
  it('reads and writes head, body, icon parts, slot, size and colours where the original kept them', () => {
    const data = new Uint8Array(0x1ff)
    data[0] = 4; data.set([65, 66, 67, 68], 1)
    data[0xbb] = 4; data[0xbc] = 3; data[0xbd] = 2; data[0xbe] = 3; data[0xbf] = 5; data[0xc0] = 1
    data.set([0xb1, 0xa2, 0xb3, 0xc4, 0xe6, 0xfa], 0xc1)
    const c = readCharacter(data)
    expect([c.portraitHead, c.portraitBody, c.iconHead, c.iconBody, c.iconId, c.iconSize]).toEqual([4, 3, 2, 3, 5, 1])
    expect(c.iconColours).toEqual([0xb1, 0xa2, 0xb3, 0xc4, 0xe6, 0xfa])
    c.portraitHead = 9; c.iconColours[5] = 0xf7; c.iconSize = 2
    const back = writeCharacter(c)
    expect([back[0xbb], back[0xbc], back[0xbd], back[0xbe], back[0xbf], back[0xc0], back[0xc6]]).toEqual([9, 3, 2, 3, 5, 2, 0xf7])
  })
})
