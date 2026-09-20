/**
 * What the party wears and wields, and what that does to the sheet.
 *
 * The record carries armour class and attack dice as they were when the game last
 * computed them. Readying or dropping something recomputes them here the same way:
 * ten, less the armour, less a shield, less the dexterity bonus; the weapon's dice
 * with its plus and the strength bonus; attacks per round from the weapon or the
 * class. Recomputing the pre-made party from its gear reproduces its sheets.
 */

import { CLASS_TRACKS, type Character, type Item } from '../formats/character.js'
import { SLOT_ARMOUR, SLOT_SHIELD, SLOT_WEAPON, type ItemType } from '../formats/items.js'

function dexterityBonus(dex: number): number {
  if (dex >= 18) return 4
  if (dex >= 15) return dex - 14
  if (dex <= 3) return -4
  if (dex <= 6) return -1
  return 0
}

function strengthBonus(str: number, percent: number): { hit: number; damage: number } {
  if (str >= 18) {
    if (percent >= 100) return { hit: 3, damage: 6 }
    if (percent >= 91) return { hit: 2, damage: 5 }
    if (percent >= 76) return { hit: 2, damage: 4 }
    if (percent >= 51) return { hit: 2, damage: 3 }
    if (percent >= 1) return { hit: 1, damage: 3 }
    return { hit: 1, damage: 2 }
  }
  if (str === 17) return { hit: 1, damage: 1 }
  if (str === 16) return { hit: 0, damage: 1 }
  if (str <= 5) return { hit: -2, damage: -1 }
  if (str <= 7) return { hit: -1, damage: -1 }
  return { hit: 0, damage: 0 }
}

export function slotOf(item: Item, types: readonly ItemType[]): number | undefined {
  return types[item.type]?.slot
}

/** Recomputes armour class and the attack from what is readied. */
export function recompute(character: Character, items: readonly Item[], types: readonly ItemType[]): void {
  let ac = 10
  let shield = 0
  let weapon: { item: Item; type: ItemType } | undefined

  for (const item of items) {
    if (!item.readied) continue
    const type = types[item.type]
    if (!type) continue
    if (type.slot === SLOT_ARMOUR && type.protection & 0x80) ac = 60 - (type.protection & 0x7f) - item.plus
    else if (type.slot === SLOT_SHIELD && type.protection & 0x80) shield = (type.protection & 0x7f) + item.plus
    else if (type.slot === SLOT_WEAPON && (type.dice > 0 || type.sides > 0)) weapon = { item, type }
  }

  const dex = dexterityBonus(character.stats.dex)
  character.ac = ac - shield - dex
  character.acBehind = ac - dex
  character.baseAc = 10

  const str = strengthBonus(character.stats.str, character.stats.strPercent)
  if (weapon) {
    character.attacks = {
      count: weapon.type.attacks > 0 ? weapon.type.attacks : attacksByClass(character),
      dice: weapon.type.dice,
      sides: weapon.type.sides,
      bonus: weapon.type.bonus + weapon.item.plus + str.damage,
    }
  } else {
    character.attacks = { count: attacksByClass(character), dice: 1, sides: 2, bonus: str.damage }
  }
  character.hitBonusRaw = 40 + str.hit + (weapon?.item.plus ?? 0) + (20 - character.thac0)
}

/** Half-attacks per round: fighters gain at seven; everyone else has one. */
function attacksByClass(character: Character): number {
  const fighter = character.levels[CLASS_TRACKS.indexOf('fighter')] ?? 0
  return fighter >= 13 ? 4 : fighter >= 7 ? 3 : 2
}

/**
 * Readies an item, putting down whatever held its place: one weapon, one shield, one
 * suit; a two-handed weapon and a shield do not mix. Returns false if it cannot be readied.
 */
export function ready(character: Character, items: Item[], index: number, types: readonly ItemType[]): boolean {
  const item = items[index]
  if (!item) return false
  const type = types[item.type]
  if (!type) return false
  const slot = type.slot
  if (slot !== SLOT_WEAPON && slot !== SLOT_SHIELD && slot !== SLOT_ARMOUR) return false

  for (const other of items) {
    if (other === item || !other.readied) continue
    const otherType = types[other.type]
    if (!otherType) continue
    const clash = otherType.slot === slot
      || (slot === SLOT_WEAPON && type.hands === 2 && otherType.slot === SLOT_SHIELD)
      || (slot === SLOT_SHIELD && otherType.slot === SLOT_WEAPON && otherType.hands === 2)
    if (clash) other.readied = false
  }
  item.readied = true
  recompute(character, items, types)
  return true
}

export function unready(character: Character, items: Item[], index: number, types: readonly ItemType[]): void {
  const item = items[index]
  if (!item) return
  item.readied = false
  recompute(character, items, types)
}
