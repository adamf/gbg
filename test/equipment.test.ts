import { describe, expect, it } from 'vitest'

import { CHARACTER_RECORD_SIZE, ITEM_RECORD_SIZE, readCharacter, readItems } from '../src/formats/character.js'
import { readItemTypes } from '../src/formats/items.js'
import { ready, recompute, unready } from '../src/engine/equipment.js'

/** A type table with the entries the tests use, laid out as ITEMS has them. */
function types() {
  const data = new Uint8Array(2 + 16 * 0x81)
  const put = (type: number, bytes: number[]) => data.set(bytes, 2 + type * 16)
  put(12, [0, 1, 2, 4, 0, 0, 0, 0x80, 0x80, 1, 6, 1, 0, 0x4a, 4, 0]) // Flail 1d6+1
  put(38, [0, 2, 3, 6, 0, 0, 0, 0, 0x80, 1, 10, 0, 0, 0x48, 4, 0]) // Two-Handed Sword 1d10
  put(9, [0, 1, 1, 2, 0, 6, 0, 1, 0x80, 1, 3, 0, 6, 0x5d, 16, 0]) // Dart, 3 a round
  put(57, [2, 0, 0, 0, 0, 0, 0xb8, 0, 0, 0, 0, 0, 0, 0x4a, 0, 0]) // Banded, AC 4
  put(59, [1, 1, 0, 0, 0, 0, 0x81, 0, 0, 0, 0, 0, 0, 0x5a, 0, 0]) // Shield +1
  return readItemTypes(data)
}

function item(type: number, readied: boolean, plus = 0) {
  const data = new Uint8Array(ITEM_RECORD_SIZE)
  data[0x2e] = type
  data[0x31] = type
  data[0x32] = plus & 0xff
  data[0x34] = readied ? 1 : 0
  return readItems(data)[0]!
}

function fighter(str: number, dex: number) {
  const data = new Uint8Array(CHARACTER_RECORD_SIZE)
  data[0x10] = str
  data[0x13] = dex
  data[0x2d] = 60 - 20
  data[0x96 + 2] = 1
  return readCharacter(data)
}

describe('equipment', () => {
  it('reproduces the pre-made fighter’s sheet from banded mail, a flail and 17 dexterity', () => {
    const c = fighter(17, 17)
    recompute(c, [item(12, true), item(57, true)], types())
    expect(c.ac).toBe(1)
    expect(c.acBehind).toBe(1)
    expect(c.attacks).toEqual({ count: 2, dice: 1, sides: 6, bonus: 2 })
  })

  it('counts a shield, its plus, and puts it down for a two-handed sword', () => {
    const c = fighter(10, 10)
    const items = [item(57, true), item(59, true, 1), item(38, false)]
    recompute(c, items, types())
    expect(c.ac).toBe(2)
    expect(ready(c, items, 2, types())).toBe(true)
    expect(items[1]!.readied).toBe(false)
    expect(c.ac).toBe(4)
    expect(c.attacks).toMatchObject({ dice: 1, sides: 10, bonus: 0 })
    unready(c, items, 0, types())
    expect(c.ac).toBe(10)
    expect(ready(c, items, 1, types())).toBe(true) // the shield sends the sword away
    expect(items[2]!.readied).toBe(false)
  })

  it('takes attacks per round from the weapon and fists when there is none', () => {
    const c = fighter(18, 10)
    c.stats.strPercent = 50
    recompute(c, [item(9, true)], types())
    expect(c.attacks).toEqual({ count: 6, dice: 1, sides: 3, bonus: 3 })
    recompute(c, [], types())
    expect(c.attacks).toEqual({ count: 2, dice: 1, sides: 2, bonus: 3 })
  })
})
