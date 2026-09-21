import { describe, expect, it } from 'vitest'

import { CHARACTER_RECORD_SIZE, readCharacter, type Item } from '../src/formats/character.js'
import type { ItemType } from '../src/formats/items.js'
import { carried, movementUnder, spendMissile, missileWeapon } from '../src/engine/burden.js'

function character(str: number, pct = 0) {
  const data = new Uint8Array(CHARACTER_RECORD_SIZE)
  data[0] = 4; data[1] = 72; data[2] = 69; data[3] = 82; data[4] = 79
  data[0x10] = str; data[0x16] = pct
  data[0x72] = 12
  data[0x11c] = 12
  return readCharacter(data)
}
function item(type: number, weight: number, count = 0, readied = true): Item {
  return { name: '', type, names: [0, 0, type], plus: 0, readied, cursed: false, weight, count, value: 1, affects: [] }
}
const types: ItemType[] = []
for (let i = 0; i < 0x81; i++) types.push({ slot: 0, hands: 1, largeDice: 1, largeSides: 6, largeBonus: 0, attacks: 2, protection: 0, dice: 1, sides: 6, bonus: 0, range: [44, 46, 9].includes(i) ? 6 : 0, classFlags: 0, flags: 0 })

describe('the load', () => {
  it('slows a character by the manual\'s steps, with strength\'s allowance', () => {
    const weak = character(9)
    expect(movementUnder(weak, [item(50, 150)])).toBe(12)
    expect(movementUnder(weak, [item(58, 450), item(59, 100)])).toBe(9)
    expect(movementUnder(weak, [item(58, 450), item(59, 100), item(36, 200)])).toBe(6)
    const strong = character(18, 75)
    expect(movementUnder(strong, [item(58, 450), item(59, 100), item(36, 200)])).toBe(12)
    weak.money[0] = 500
    expect(carried(weak, [])).toBe(500)
  })

  it('spends arrows for a bow and the darts themselves, and stops when they run out', () => {
    const items = [item(44, 50), item(73, 4, 2, false)]
    expect(missileWeapon(items, types)?.type).toBe(44)
    expect(spendMissile(items, types)).toBeUndefined()
    expect(items[1]!.count).toBe(1)
    expect(spendMissile(items, types)).toBe('NO MORE ARROWS.')
    expect(items.length).toBe(1)
    expect(missileWeapon(items, types)).toBeUndefined()
    const darts = [item(9, 5, 2)]
    spendMissile(darts, types)
    expect(darts[0]!.count).toBe(1)
    expect(spendMissile(darts, types)).toBe('NO MORE OF THOSE TO THROW.')
    expect(darts.length).toBe(0)
  })
})
