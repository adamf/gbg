import { describe, expect, it } from 'vitest'
import {
  OVERLAND_STEPS, readOverland, tileAt, unpackData, windowColumn, WORLD_HEIGHT, WORLD_WIDTH,
} from '../src/formats/overland.js'

/** A run token as the linker packs it: plain bytes before, B2, the tile, the count, B0. */
function run(before: number, tile: number, count: number): number[] {
  return [before & 0xff, before >> 8, 0xb2, tile, count & 0xff, count >> 8, 0xb0]
}

/** A START.EXE-shaped buffer: junk, then the map with its bottom rows packed, then junk. */
function fakeStartExe(): { exe: Uint8Array; expected: Uint8Array } {
  const expected = new Uint8Array(WORLD_WIDTH * WORLD_HEIGHT)
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let x = 0; x < WORLD_WIDTH; x++) {
      // Rows 0–33: varied ground (0x20–0x79, clear of the token bytes) with the opening the reader looks for; rows 34–35: one tile, the packed run.
      expected[y * WORLD_WIDTH + x] = y >= 34 ? 0x4e : y === 0 && x < 27 ? (x % 2 === 0 ? 1 : 2) : 0x20 + ((x * 7 + y * 3) % 90)
    }
  }
  const plainEnd = 34 * WORLD_WIDTH
  const junkBefore = 300
  const stream = [
    ...new Array(junkBefore).fill(0x33),
    ...expected.subarray(0, plainEnd),
    ...run(junkBefore + plainEnd, 0x4e, WORLD_WIDTH * 2),
    ...new Array(50).fill(0x44),
  ]
  return { exe: new Uint8Array(stream), expected }
}

describe('the overland map in START.EXE', () => {
  it('unpacks a run token and checks its chaining count', () => {
    const data = new Uint8Array([9, 8, 7, ...run(3, 0x4e, 4), 1, 2, ...run(2, 0x11, 2)])
    expect([...unpackData(data, 0, 3 + 4 + 2 + 2)!]).toEqual([9, 8, 7, 0x4e, 0x4e, 0x4e, 0x4e, 1, 2, 0x11, 0x11])
    // A token whose count does not match the plain bytes before it is plain data.
    const wrong = new Uint8Array([9, 8, 7, ...run(1, 0x4e, 4)])
    expect(unpackData(wrong, 3, 7)).toBeUndefined()
  })

  it('finds the map by its opening row and unpacks it whole', () => {
    const { exe, expected } = fakeStartExe()
    const map = readOverland(exe)
    expect(map).toBeDefined()
    expect(map!.offset).toBe(300)
    expect(map!.width).toBe(WORLD_WIDTH)
    expect(map!.height).toBe(WORLD_HEIGHT)
    expect([...map!.tiles]).toEqual([...expected])
    expect(tileAt(map!, 0, 0)).toBe(1)
    expect(tileAt(map!, 1, 0)).toBe(2)
    expect(tileAt(map!, 5, 35)).toBe(0x4e)
    expect(tileAt(map!, WORLD_WIDTH, 0)).toBeUndefined()
    expect(tileAt(map!, 0, -1)).toBeUndefined()
  })

  it('gives nothing when there is no map', () => {
    expect(readOverland(new Uint8Array(5000))).toBeUndefined()
  })

  it('places each wilderness script’s window thirteen columns on', () => {
    expect(windowColumn(25)).toBe(0)
    expect(windowColumn(26)).toBe(13)
    expect(windowColumn(27)).toBe(26)
    expect(windowColumn(20)).toBe(0)
    // Handing over at x = 15 to the next window’s x = 3 is a step of one column.
    expect(15 + windowColumn(25)).toBe(3 + windowColumn(26) - 1)
    expect(2 + windowColumn(26)).toBe(14 + windowColumn(25) + 1)
  })

  it('steps clockwise from north', () => {
    expect(OVERLAND_STEPS[0]).toEqual({ dx: 0, dy: -1 })
    expect(OVERLAND_STEPS[2]).toEqual({ dx: 1, dy: 0 })
    expect(OVERLAND_STEPS[5]).toEqual({ dx: -1, dy: 1 })
    expect(OVERLAND_STEPS[7]).toEqual({ dx: -1, dy: -1 })
  })
})
