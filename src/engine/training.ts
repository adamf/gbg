/**
 * Training: when a character has the experience for the next level, a hall of the
 * right kind takes their gold and gives it to them.
 *
 * The thresholds are the first edition tables Pool of Radiance used. A level brings
 * a hit die (plus the constitution bonus), a better to-hit on the class's schedule,
 * and, for the casters, the slots their new level allows.
 */

import { CLASS_TRACKS, type Character } from '../formats/character.js'
import type { Random } from './combat.js'

export type Track = (typeof CLASS_TRACKS)[number]

/** Experience needed to *reach* level index (2 at [1], 3 at [2], …). */
const THRESHOLDS: Record<Track, number[]> = {
  cleric: [0, 1500, 3000, 6000, 13000, 27500, 55000, 110000, 225000],
  druid: [0, 2000, 4000, 7500, 12500, 20000, 35000, 60000, 90000],
  fighter: [0, 2000, 4000, 8000, 18000, 35000, 70000, 125000, 250000],
  paladin: [0, 2750, 5500, 12000, 24000, 45000, 95000, 175000, 350000],
  ranger: [0, 2250, 4500, 10000, 20000, 40000, 90000, 150000, 225000],
  'magic-user': [0, 2500, 5000, 10000, 22500, 40000, 60000, 90000, 135000],
  thief: [0, 1250, 2500, 5000, 10000, 20000, 42500, 70000, 110000],
  monk: [0, 2250, 4750, 10000, 22500, 47500, 98000, 200000, 350000],
}

const HIT_DIE: Record<Track, number> = {
  cleric: 8, druid: 8, fighter: 10, paladin: 10, ranger: 8, 'magic-user': 4, thief: 6, monk: 4,
}

/** Which classes a hall's mask trains. Bits read off the city's training script. */
export function tracksInMask(mask: number): Track[] {
  const tracks: Track[] = []
  if (mask & 0x01) tracks.push('magic-user')
  if (mask & 0x02) tracks.push('cleric')
  if (mask & 0x04) tracks.push('thief')
  if (mask & 0x08) tracks.push('fighter')
  if (mask & 0x10) tracks.push('paladin')
  if (mask & 0x20) tracks.push('ranger')
  if (mask & 0x40) tracks.push('druid')
  return tracks
}

/** A multi-class character splits experience between their classes. */
export function shareOfExperience(character: Character): number {
  const classes = character.levels.filter((l) => l > 0).length
  return Math.floor(character.experience / Math.max(1, classes))
}

export function nextLevelAt(track: Track, level: number): number {
  return THRESHOLDS[track][level] ?? Number.POSITIVE_INFINITY
}

/**
 * The manual's race limits: how far each race may go in each class. Humans are
 * unlimited; a dash in the table is a class the race cannot take at all.
 */
const RACE_LIMITS: Record<number, Partial<Record<Track, number>>> = {
  1: { fighter: 9, thief: 99 }, // dwarf
  2: { fighter: 7, 'magic-user': 11, thief: 99 }, // elf
  3: { fighter: 6, thief: 99 }, // gnome
  4: { cleric: 5, fighter: 8, 'magic-user': 8, thief: 99 }, // half-elf
  5: { fighter: 6, thief: 99 }, // halfling
}

export function levelLimit(race: number, track: Track): number {
  const limits = RACE_LIMITS[race]
  if (!limits) return 99
  return limits[track] ?? 0
}

/** The class tracks this character is ready to advance in, among those the hall teaches. */
export function readyToTrain(character: Character, mask: number): Track[] {
  const share = shareOfExperience(character)
  return tracksInMask(mask).filter((track) => {
    const level = character.levels[CLASS_TRACKS.indexOf(track)] ?? 0
    return level > 0 && share >= nextLevelAt(track, level) && level < levelLimit(character.race, track)
  })
}

export const TRAINING_COST = 1000

function constitutionBonus(con: number, track: Track): number {
  if (con >= 17) return track === 'fighter' || track === 'paladin' || track === 'ranger' ? con - 14 : 2
  if (con >= 15) return con - 14
  if (con <= 3) return -2
  if (con <= 6) return -1
  return 0
}

function thac0For(track: Track, level: number): number {
  switch (track) {
    case 'fighter': case 'paladin': case 'ranger': return 20 - 2 * Math.floor((level - 1) / 2)
    case 'cleric': case 'druid': case 'monk': return 20 - 2 * Math.floor((level - 1) / 3)
    case 'thief': return 20 - 2 * Math.floor((level - 1) / 4)
    case 'magic-user': return 20 - 2 * Math.floor((level - 1) / 5)
  }
}

const CLERIC_SLOTS = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 1, 0], [3, 2, 0], [3, 3, 1], [3, 3, 2], [3, 3, 2], [3, 3, 3], [4, 4, 3]]
const MAGIC_SLOTS = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 1, 0], [3, 2, 0], [4, 2, 1], [4, 2, 2], [4, 3, 2], [4, 3, 3], [4, 3, 3]]

function wisdomBonus(wis: number): number[] {
  if (wis >= 17) return [2, 2, 1]
  if (wis >= 15) return [2, 1, 0]
  if (wis >= 14) return [2, 0, 0]
  if (wis >= 13) return [1, 0, 0]
  return [0, 0, 0]
}

/** Recomputes the six slot bytes from levels and wisdom. */
export function spellSlotsFor(character: Character): number[] {
  const cleric = character.levels[CLASS_TRACKS.indexOf('cleric')] ?? 0
  const magic = character.levels[CLASS_TRACKS.indexOf('magic-user')] ?? 0
  const c = CLERIC_SLOTS[Math.min(cleric, CLERIC_SLOTS.length - 1)]!
  const m = MAGIC_SLOTS[Math.min(magic, MAGIC_SLOTS.length - 1)]!
  const wis = wisdomBonus(character.stats.wis)
  const withBonus = cleric > 0 ? c.map((n, i) => (n > 0 ? n + wis[i]! : 0)) : [0, 0, 0]
  return [...withBonus, ...m]
}

export interface Advancement {
  track: Track
  level: number
  hitPoints: number
}

/** Raises one class a level. Returns what changed. */
export function train(character: Character, track: Track, random: Random): Advancement {
  const index = CLASS_TRACKS.indexOf(track)
  const level = (character.levels[index] ?? 0) + 1
  character.levels[index] = level

  const classes = character.levels.filter((l) => l > 0).length
  const rolled = random(HIT_DIE[track] - 1) + 1 + constitutionBonus(character.stats.con, track)
  const hitPoints = Math.max(1, Math.round(rolled / classes))
  character.hpMax += hitPoints
  character.hpCurrent += hitPoints

  // The best schedule among the character's classes.
  const best = Math.min(...CLASS_TRACKS.map((t, i) => ((character.levels[i] ?? 0) > 0 ? thac0For(t, character.levels[i]!) : 99)))
  if (best < character.thac0) {
    character.hitBonusRaw += character.thac0 - best
    character.thac0 = best
  }
  character.spellSlots = spellSlotsFor(character)
  return { track, level, hitPoints }
}
