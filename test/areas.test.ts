import { describe, expect, it } from 'vitest'
import { blastSquares, distance, spellRange } from '../src/engine/areas.js'
import { spellById } from '../src/formats/spells.js'

describe('spell areas on the grid', () => {
  it('measures squares the way the game did: diagonals count one', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(3)
    expect(distance({ x: 2, y: 5 }, { x: 0, y: 6 })).toBe(2)
  })

  it('reads the manual’s ranges, by level where they grow', () => {
    expect(spellRange(spellById(47)!, 5)).toBe(15)
    expect(spellRange(spellById(15)!, 1)).toBe(7)
    expect(spellRange(spellById(4)!, 9)).toBe(1)
    expect(spellRange(spellById(23)!, 3)).toBe(6)
    expect(spellRange(spellById(41)!, 3)).toBeUndefined()
  })

  it('a fireball is a five-square disc with the corners off', () => {
    const squares = blastSquares({ kind: 'circle', radius: 2 }, { x: 0, y: 0 }, { x: 10, y: 10 }, 50, 25)
    expect(squares).toHaveLength(21)
    const has = (x: number, y: number) => squares.some((s) => s.x === x && s.y === y)
    expect(has(10, 10)).toBe(true)
    expect(has(12, 11)).toBe(true)
    expect(has(12, 12)).toBe(false)
    expect(has(8, 10)).toBe(true)
  })

  it('a block is centred and cut off at the field’s edge', () => {
    const squares = blastSquares({ kind: 'block', size: 3 }, { x: 0, y: 0 }, { x: 0, y: 1 }, 50, 25)
    expect(squares).toHaveLength(6)
    expect(squares.every((s) => s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 2)).toBe(true)
  })

  it('a line runs from the caster through the target and on, so many squares', () => {
    const squares = blastSquares({ kind: 'line', length: 8 }, { x: 5, y: 5 }, { x: 7, y: 5 }, 50, 25)
    expect(squares.map((s) => `${s.x},${s.y}`)).toEqual(['6,5', '7,5', '8,5', '9,5', '10,5', '11,5', '12,5', '13,5'])
    const diagonal = blastSquares({ kind: 'line', length: 3 }, { x: 5, y: 5 }, { x: 6, y: 6 }, 50, 25)
    expect(diagonal.map((s) => `${s.x},${s.y}`)).toEqual(['6,6', '7,7', '8,8'])
    expect(blastSquares({ kind: 'line', length: 8 }, { x: 5, y: 5 }, { x: 5, y: 5 }, 50, 25)).toEqual([])
  })
})
