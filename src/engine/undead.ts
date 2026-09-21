/**
 * Turning undead: a cleric holds up the holy symbol and the animated dead flee or
 * fall. The first edition table by cleric level against the monster's hit dice, as
 * the original kept it: a number to beat on two dice, T for an automatic turn, D for
 * destruction, and nothing at all above the cleric's reach.
 */

import type { Character } from '../formats/character.js'
import type { Random } from './combat.js'

/** Rows by hit dice 1..8 and up; columns by cleric level 1..9 and up. 0 no effect, 1..12 needed, 13 turn, 14 destroy. */
const TABLE: number[][] = [
  [10, 7, 4, 13, 13, 14, 14, 14, 14],
  [13, 10, 7, 4, 13, 13, 14, 14, 14],
  [16, 13, 10, 7, 4, 13, 13, 14, 14],
  [19, 16, 13, 10, 7, 4, 13, 13, 14],
  [20, 19, 16, 13, 10, 7, 4, 13, 13],
  [0, 20, 19, 16, 13, 10, 7, 4, 13],
  [0, 0, 20, 19, 16, 13, 10, 7, 4],
  [0, 0, 0, 20, 19, 16, 13, 10, 7],
]

export const UNDEAD = 4

export type TurnResult = 'unmoved' | 'turned' | 'destroyed'

export function canTurn(character: Character): boolean {
  return (character.levels[0] ?? 0) > 0 || (character.levels[3] ?? 0) >= 3
}

/** One undead against the cleric: what the dice say. */
export function turnOne(cleric: Character, undead: Character, random: Random): TurnResult {
  const level = Math.max(1, (cleric.levels[0] ?? 0) || Math.max(0, (cleric.levels[3] ?? 0) - 2))
  const row = TABLE[Math.min(TABLE.length - 1, Math.max(1, undead.hitDice) - 1)]!
  const needed = row[Math.min(row.length - 1, level - 1)]!
  if (needed === 0) return 'unmoved'
  if (needed === 14) return 'destroyed'
  if (needed === 13) return 'turned'
  const roll = random(5) + 1 + random(5) + 1
  return roll >= needed ? 'turned' : 'unmoved'
}
