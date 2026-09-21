/**
 * Random treasure: a TREASURE command whose item value is 0x80 or more asks for that
 * many items rolled from the game's own table. The table is coab's `CMD_Treasure`
 * (ovr003.cs), which is the original's: mostly ordinary arms and armour, some swords,
 * a few scrolls, potions and wands, the odd ring or bracers.
 *
 * The items themselves are built from a shipped record of the same type, so their
 * names, weights and values are the game's; whether the original also rolled a plus
 * for them is not known, and none is given here — a weapon whose only shipped record
 * is magical is handed out plain.
 */

import type { Item } from '../formats/character.js'

export type Random = (max: number) => number

const TYPE_SHIELD = 59
const TYPE_MU_SCROLL = 61
const TYPE_CLERIC_SCROLL = 62
const TYPE_POTION = 71
const TYPE_ARROW = 73
const TYPE_BRACERS = 77
const TYPE_WAND = 79
const TYPE_GIANT_STRENGTH = 84
const TYPE_RING_OF_PROTECTION = 93
const SWORDS = { bastard: 34, broad: 35, long: 36, short: 37, twoHanded: 38 } as const

/** One roll on the table: an item type. */
export function randomItemType(random: Random): number {
  const d = (sides: number) => random(sides - 1) + 1
  const first = d(100)
  if (first <= 60) {
    const second = d(100)
    if ((second >= 1 && second <= 47) || (second >= 50 && second <= 59)) return second === 45 ? TYPE_SHIELD : second
    if (second <= 90) {
      const sword = d(10)
      if (sword <= 4) return SWORDS.long
      if (sword <= 7) return SWORDS.broad
      if (sword === 8) return SWORDS.bastard
      if (sword === 9) return SWORDS.short
      return SWORDS.twoHanded
    }
    if (second <= 94) return TYPE_ARROW
    if (second <= 97) return TYPE_RING_OF_PROTECTION
    if (second <= 100) return TYPE_BRACERS
    return TYPE_SHIELD
  }
  if (first <= 85) return TYPE_MU_SCROLL
  if (first <= 90) return TYPE_CLERIC_SCROLL
  if (first <= 98) {
    const third = d(15)
    if (third <= 9) return TYPE_POTION
    if (third === 10) return TYPE_GIANT_STRENGTH
    return TYPE_WAND
  }
  return TYPE_SHIELD
}

/**
 * `count` rolled items, each a copy of the shipped record of its type. Types the
 * folder has no record of are skipped. Plain arms and armour lose any plus the
 * template carried; the magical kinds keep theirs.
 */
export function randomItems(count: number, templates: ReadonlyMap<number, Item>, random: Random): Item[] {
  const items: Item[] = []
  for (let i = 0; i < count; i++) {
    const type = randomItemType(random)
    const template = templates.get(type)
    if (!template) continue
    const item: Item = { ...template, names: [...template.names] as [number, number, number], affects: [...template.affects], readied: false }
    delete item.raw
    if (type < 50 && item.plus !== 0) {
      item.plus = 0
      item.names = [0, 0, type]
      item.value = Math.max(1, Math.min(item.value, 30))
    }
    items.push(item)
  }
  return items
}
