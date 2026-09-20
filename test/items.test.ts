import { describe, expect, it } from 'vitest'

import { ITEM_RECORD_SIZE, readCharacter, readItems, CHARACTER_RECORD_SIZE } from '../src/formats/character.js'
import { itemDisplayName, readItemNames, readItemTypes } from '../src/formats/items.js'
import { buy, emptyPool, pay, sell, shareCoins, take } from '../src/engine/treasure.js'

/** Inline Pascal literals with a few bytes of "code" between them, as START.EXE has. */
function fakeExe(names: string[]): Uint8Array {
  const bytes: number[] = [0x90, 0x90, 0xb2, 0x00]
  names.forEach((name, i) => {
    bytes.push(name.length, ...[...name].map((c) => c.charCodeAt(0)))
    // Sometimes a stray printable byte follows, sometimes zeros, sometimes an instruction.
    if (i % 3 === 0) bytes.push(0x33)
    bytes.push(...(i % 2 === 0 ? [0x00, 0xb2, 0x00, 0x0c, 0x00, 0xb0] : [0, 0, 0, 0, 0]))
  })
  bytes.push(0xc3)
  return Uint8Array.from(bytes)
}

const WORDS = ['Battle Axe', 'Hand Axe', 'Bardiche', 'Bec De Corbin', 'Bill-Guisarme', 'Bo Stick', 'Club', 'Dagger', 'Dart', 'Mail', 'Armor', 'Leather', 'Arrow', 'Potion', 'Holy Symbol', 'of', 'Cloak']

describe('item names', () => {
  it('scans the literals out of the program, one-based from Battle Axe', () => {
    const names = readItemNames(fakeExe(WORDS))
    expect(names[0]).toBe('')
    expect(names.slice(1, 13)).toEqual(WORDS.slice(0, 12))
    // The game's list has five words the program lacks; the slots are kept.
    expect(names.slice(13)).toEqual(['Arrow', '', '', 'Potion', '', '', 'Holy Symbol', 'of', '', 'Cloak'])
  })

  it('gives up cleanly when the program is not there', () => {
    expect(readItemNames(new Uint8Array(100))).toEqual([])
  })

  it('composes a display name from the three name numbers', () => {
    const names = ['', ...WORDS]
    const record = new Uint8Array(ITEM_RECORD_SIZE)
    record[0x2e] = 12
    record[0x2f] = 0
    record[0x30] = 10 // Mail
    record[0x31] = 12 // Leather
    const [item] = readItems(record)
    expect(itemDisplayName(item!, names)).toBe('Leather Mail')
    item!.names = [8, 10, 12] // a first word prints last: "Leather Mail Dagger"
    expect(itemDisplayName(item!, names)).toBe('Leather Mail Dagger')
    const darts = readItems((() => { const d = new Uint8Array(ITEM_RECORD_SIZE); d[0x31] = 9; d[0x39] = 4; return d })())[0]!
    expect(itemDisplayName(darts, names)).toBe('4 Darts')
  })

  it('reads the item type table after its two-byte header', () => {
    const data = new Uint8Array(2 + 16 * 0x81)
    data[2 + 16 * 12 + 9] = 1
    data[2 + 16 * 12 + 10] = 6
    data[2 + 16 * 12 + 11] = 0xff
    const types = readItemTypes(data)
    expect(types.length).toBe(0x81)
    expect(types[12]).toMatchObject({ dice: 1, sides: 6, bonus: -1 })
  })
})

describe('the treasure pool', () => {
  function member(gold: number, platinum = 0) {
    const c = readCharacter(new Uint8Array(CHARACTER_RECORD_SIZE))
    c.money[3] = gold
    c.money[4] = platinum
    return { character: c, items: [] as ReturnType<typeof readItems> }
  }

  it('shares coins evenly with the remainder to the first', () => {
    const pool = emptyPool()
    pool.coins[3] = 10
    const a = member(0)
    const b = member(0)
    const c = member(0)
    shareCoins(pool, [a, b, c])
    expect([a, b, c].map((m) => m.character.money[3])).toEqual([4, 3, 3])
    expect(pool.coins[3]).toBe(0)
  })

  it('pays in gold, breaking platinum when short, and refuses what it cannot afford', () => {
    const m = member(2, 1)
    expect(pay(m, 5)).toBe(true)
    expect(m.character.money.slice(3, 5)).toEqual([2, 0])
    expect(pay(m, 3)).toBe(false)
  })

  it('buys onto a member unreadied, sells for half, and takes from the ground', () => {
    const record = new Uint8Array(ITEM_RECORD_SIZE)
    record[0x34] = 1
    record[0x3a] = 30
    const [sword] = readItems(record)
    const m = member(40)
    expect(buy(m, sword!)).toBe(true)
    expect(m.items[0]!.readied).toBe(false)
    expect(m.character.money[3]).toBe(10)
    expect(sell(m, 0)).toBe(15)
    expect(m.items.length).toBe(0)
    expect(m.character.money[3]).toBe(25)
    const pool = emptyPool()
    pool.items.push(sword!)
    expect(take(pool, 0, m)).toBe(sword)
    expect(pool.items.length).toBe(0)
    expect(m.items.length).toBe(1)
  })
})
