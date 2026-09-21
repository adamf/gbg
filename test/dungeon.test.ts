import { describe, expect, it } from 'vitest'

import { readGeoMap } from '../src/formats/geo.js'
import { isSolid, isWalkable } from '../src/engine/dungeon.js'
import { walk } from '../src/engine/party.js'
import { buildGeoBlock } from './fixtures.js'

describe('solid rock', () => {
  it('is a cell walled on every side with no door, and a door makes it a room', () => {
    // (5,5) is walled all round; (5,6) too, but with a door west onto (5,5)'s east door.
    const map = readGeoMap(1, buildGeoBlock(
      (row, col) => (row === 5 && (col === 5 || col === 6) ? { n: 1, e: 1, s: 1, w: 1 } : { n: 0, e: 0, s: 0, w: 0 }),
      (row, col) => (row === 5 && col === 5 ? 0x04 : row === 5 && col === 6 ? 0x40 : 0),
    ))
    const rock = map.cells.find((c) => c.row === 5 && c.col === 5)!
    const hall = map.cells.find((c) => c.row === 5 && c.col === 6)!
    expect(rock.doors.east).toBe(1)
    expect(hall.doors.west).toBe(1)
    expect(isSolid(rock)).toBe(false)
    expect(isSolid(hall)).toBe(false)
    expect(isWalkable(map, 5, 6)).toBe(true)
    expect(walk(map, { row: 5, col: 7, facing: 'west' }, 'west').moved).toBe(false)
    expect(walk(map, { row: 5, col: 5, facing: 'east' }, 'east').moved).toBe(true)

    const plain = readGeoMap(1, buildGeoBlock((row, col) => (row === 5 && col === 5 ? { n: 1, e: 1, s: 1, w: 1 } : { n: 0, e: 0, s: 0, w: 0 })))
    expect(isSolid(plain.cells.find((c) => c.row === 5 && c.col === 5)!)).toBe(true)
  })
})
