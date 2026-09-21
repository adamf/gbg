/**
 * What a character carries and what it does to them: the manual's warning that
 * coins and gear slow a character down, and the arrows and darts a fight uses up.
 * Weights are in tenths of a pound; a coin is a tenth.
 */

import type { Character, Item } from '../formats/character.js'
import type { ItemType } from '../formats/items.js'
import { missileFor } from './sprites.js'

/** A member's reach and pace from what they carry: the missile in hand and the load. */
export function refit(character: Character, items: Item[], types: readonly ItemType[]): void {
  const missile = missileWeapon(items, types)
  character.attacks.range = missile ? types[missile.type]!.range : undefined
  character.attacks.missile = missile ? missileFor(missile.type) : undefined
  character.movement = movementUnder(character, items)
}

/** Everything carried, in tenths of a pound. */
export function carried(character: Character, items: readonly Item[]): number {
  const gear = items.reduce((n, item) => n + item.weight * Math.max(1, item.count), 0)
  const coins = character.money.slice(0, 5).reduce((n, c) => n + (c ?? 0), 0)
  return gear + coins
}

/** The first edition's strength allowance over the base thirty-five pounds, in tenths. */
export function allowance(character: Character): number {
  const str = character.stats.str
  if (str <= 5) return -350
  if (str <= 7) return -250
  if (str <= 11) return 0
  if (str <= 13) return 100
  if (str <= 15) return 200
  if (str === 16) return 350
  if (str === 17) return 500
  const pct = character.stats.strPercent
  if (pct === 0) return 750
  if (pct <= 50) return 1000
  if (pct <= 99) return 1250
  return 1500
}

/** Movement under the load: twelve unburdened, then nine, six and three. */
export function movementUnder(character: Character, items: readonly Item[]): number {
  const load = carried(character, items) - allowance(character)
  const base = character.baseMovement || 12
  if (load <= 350) return base
  if (load <= 700) return Math.min(base, 9)
  if (load <= 1050) return Math.min(base, 6)
  return Math.min(base, 3)
}

const ARROW = 73
const QUARREL = 28
const BOWS = new Set([41, 42, 43, 44])
const CROSSBOWS = new Set([45, 46])
const THROWN = new Set([2, 9, 20, 21, 86, 87])

/** The readied missile weapon, if it has anything to fire. */
export function missileWeapon(items: readonly Item[], types: readonly ItemType[]): Item | undefined {
  const weapon = items.find((item) => item.readied && (types[item.type]?.range ?? 0) > 0)
  if (!weapon) return undefined
  if (BOWS.has(weapon.type) && !items.some((i) => i.type === ARROW && i.count > 0)) return undefined
  if (CROSSBOWS.has(weapon.type) && !items.some((i) => i.type === QUARREL && i.count > 0)) return undefined
  return weapon
}

/**
 * A shot spends an arrow or a quarrel; a throw spends the dart or the axe itself.
 * Returns what ran out, if anything did.
 */
export function spendMissile(items: Item[], types: readonly ItemType[]): string | undefined {
  const weapon = missileWeapon(items, types)
  if (!weapon) return undefined
  const ammoType = BOWS.has(weapon.type) ? ARROW : CROSSBOWS.has(weapon.type) ? QUARREL : THROWN.has(weapon.type) ? weapon.type : undefined
  if (ammoType === undefined) return undefined
  const at = items.findIndex((i) => i.type === ammoType && (i.count > 0 || ammoType === weapon.type))
  if (at < 0) return undefined
  const stack = items[at]!
  stack.count = Math.max(0, stack.count - 1)
  if (stack.count === 0) {
    if (ammoType === weapon.type && stack === weapon) items.splice(at, 1)
    else if (ammoType !== weapon.type) items.splice(at, 1)
    return `NO MORE ${ammoType === ARROW ? 'ARROWS' : ammoType === QUARREL ? 'QUARRELS' : 'OF THOSE TO THROW'}.`
  }
  return undefined
}
