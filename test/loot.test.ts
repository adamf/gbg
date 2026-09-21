import { describe, expect, it } from 'vitest'

import { randomItems, randomItemType } from '../src/engine/loot.js'
import type { Item } from '../src/formats/character.js'

function item(type: number, plus = 0): Item {
  return { name: '', type, names: [0, plus ? 162 : 0, type], plus, readied: true, cursed: false, weight: 10, count: 0, value: plus ? 2000 : 15, affects: [] }
}

describe('random loot', () => {
  it('rolls the table: arms and armour mostly, swords, arrows, scrolls, potions, wands', () => {
    // A d100 of 30 then a d100 of 36: a long sword.
    let rolls = [29, 35]
    expect(randomItemType(() => rolls.shift() ?? 0)).toBe(36)
    // 30 then 45: the table's 45 is a shield.
    rolls = [29, 44]
    expect(randomItemType(() => rolls.shift() ?? 0)).toBe(59)
    // 30, 70 (a sword), d10 of 8: a bastard sword.
    rolls = [29, 69, 7]
    expect(randomItemType(() => rolls.shift() ?? 0)).toBe(34)
    // 70: a magic-user scroll.  88: a clerical scroll.  95 then d15 of 3: a potion.
    rolls = [69]
    expect(randomItemType(() => rolls.shift() ?? 0)).toBe(61)
    rolls = [87]
    expect(randomItemType(() => rolls.shift() ?? 0)).toBe(62)
    rolls = [94, 2]
    expect(randomItemType(() => rolls.shift() ?? 0)).toBe(71)
  })

  it('builds items from shipped records, unreadied, and hands magical weapons out plain', () => {
    const templates = new Map<number, Item>([[36, item(36, 1)], [59, item(59)]])
    const rolls = [29, 35, 29, 44, 29, 35]
    const loot = randomItems(3, templates, () => rolls.shift() ?? 0)
    expect(loot.map((i) => i.type)).toEqual([36, 59, 36])
    expect(loot.every((i) => !i.readied)).toBe(true)
    expect(loot[0]!.plus).toBe(0)
    expect(loot[0]!.names).toEqual([0, 0, 36])
    expect(loot[0]).not.toBe(templates.get(36))
    // A type the folder has no record of is skipped.
    expect(randomItems(1, templates, () => 69).length).toBe(0)
  })
})
