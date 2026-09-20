/**
 * Rolling a character, the way the original's utility did: a race, a class the race
 * allows, three dice per ability with the race's adjustments, and the first-level
 * numbers from the tables — full hit die, the class's saving throws, a spell book.
 *
 * The result is a `Character` like one read from disk, so everything downstream
 * treats it the same. The record is not written back to disk.
 */

import { CHARACTER_RECORD_SIZE, CLASS_TRACKS, CLASSES, RACES, readCharacter, type Character } from '../formats/character.js'
import type { Random } from './combat.js'
import { spellSlotsFor } from './training.js'

export type RaceName = (typeof RACES)[number]
export type ClassName = (typeof CLASSES)[number]

/** Which classes each race may take. Numbers are indexes into CLASSES. */
export const CLASSES_BY_RACE: Record<Exclude<RaceName, 'monster'>, number[]> = {
  human: [0, 2, 3, 4, 5, 6],
  dwarf: [0, 2, 6, 14],
  elf: [0, 2, 5, 6, 13, 14, 15, 16],
  gnome: [0, 2, 5, 6, 13, 14],
  'half-elf': [0, 2, 4, 5, 6, 8, 9, 10, 11, 13, 14, 15, 16],
  halfling: [0, 2, 6, 14],
  'half-orc': [0, 2, 6, 8, 12, 14],
}

const RACE_ADJUSTMENTS: Record<Exclude<RaceName, 'monster'>, Partial<Record<'str' | 'int' | 'wis' | 'dex' | 'con' | 'cha', number>>> = {
  human: {},
  dwarf: { con: 1, cha: -1 },
  elf: { dex: 1, con: -1 },
  gnome: {},
  'half-elf': {},
  halfling: { dex: 1, str: -1 },
  'half-orc': { str: 1, con: 1, cha: -2 },
}

/** The tracks a class index covers. */
export function tracksOf(classIndex: number): number[] {
  const name = CLASSES[classIndex] ?? 'fighter'
  const parts = name.split('/')
  return parts.map((part) => CLASS_TRACKS.indexOf(part as (typeof CLASS_TRACKS)[number])).filter((i) => i >= 0)
}

const MINIMUMS: Partial<Record<(typeof CLASS_TRACKS)[number], Partial<Record<'str' | 'int' | 'wis' | 'dex' | 'con' | 'cha', number>>>> = {
  fighter: { str: 9 },
  paladin: { str: 12, con: 9, wis: 13, cha: 17 },
  ranger: { str: 13, int: 13, wis: 14, con: 14 },
  'magic-user': { int: 9 },
  cleric: { wis: 9 },
  thief: { dex: 9 },
}

const HIT_DIE = [8, 8, 10, 10, 8, 4, 6, 4]
const SAVES: Record<string, number[]> = {
  cleric: [10, 13, 14, 16, 15],
  druid: [10, 13, 14, 16, 15],
  fighter: [14, 15, 16, 17, 17],
  paladin: [12, 13, 14, 15, 15],
  ranger: [14, 15, 16, 17, 17],
  'magic-user': [14, 13, 11, 15, 12],
  thief: [13, 12, 14, 16, 15],
  monk: [13, 12, 14, 16, 15],
}

export interface Stats { str: number; int: number; wis: number; dex: number; con: number; cha: number }

/** Three dice each, with the race's adjustments, kept within 3 and 18. */
export function rollStats(race: RaceName, random: Random): Stats {
  const roll = () => random(5) + 1 + random(5) + 1 + random(5) + 1
  const stats: Stats = { str: roll(), int: roll(), wis: roll(), dex: roll(), con: roll(), cha: roll() }
  const adjust = RACE_ADJUSTMENTS[race as Exclude<RaceName, 'monster'>] ?? {}
  for (const [key, delta] of Object.entries(adjust)) {
    const k = key as keyof Stats
    stats[k] = Math.max(3, Math.min(18, stats[k] + (delta ?? 0)))
  }
  return stats
}

/** True when the dice allow the class. */
export function qualifies(classIndex: number, stats: Stats): boolean {
  return tracksOf(classIndex).every((track) => {
    const need = MINIMUMS[CLASS_TRACKS[track]!] ?? {}
    return Object.entries(need).every(([key, min]) => stats[key as keyof Stats] >= (min ?? 0))
  })
}

export interface Rolled {
  name: string
  race: RaceName
  classIndex: number
  sex: 0 | 1
  alignment: number
  stats: Stats
}

function constitutionBonus(con: number, fighterish: boolean): number {
  if (con >= 17) return fighterish ? con - 14 : 2
  if (con >= 15) return con - 14
  if (con <= 3) return -2
  if (con <= 6) return -1
  return 0
}

/** A first-level character from the choices and dice. */
export function createCharacter(rolled: Rolled, random: Random): Character {
  const c = readCharacter(new Uint8Array(CHARACTER_RECORD_SIZE))
  c.name = rolled.name.toUpperCase().slice(0, 15)
  c.race = RACES.indexOf(rolled.race)
  c.class = rolled.classIndex
  c.sex = rolled.sex
  c.alignment = rolled.alignment
  c.stats = { ...rolled.stats, strPercent: rolled.stats.str === 18 && tracksOf(rolled.classIndex).includes(2) ? random(99) + 1 : 0 }
  c.age = 16 + random(9)

  const tracks = tracksOf(rolled.classIndex)
  for (const track of tracks) c.levels[track] = 1
  const fighterish = tracks.some((t) => t === 2 || t === 3 || t === 4)
  const die = Math.max(...tracks.map((t) => HIT_DIE[t] ?? 6))
  c.hpMax = Math.max(1, die + constitutionBonus(rolled.stats.con, fighterish))
  c.hpCurrent = c.hpMax
  c.hitDice = 1
  c.thac0 = 20
  c.hitBonusRaw = 40
  c.ac = 10
  c.acBehind = 10
  c.baseAc = 10
  c.baseMovement = 12
  c.movement = 12
  c.savingThrows = [0, 1, 2, 3, 4].map((i) => Math.min(...tracks.map((t) => SAVES[CLASS_TRACKS[t]!]![i]!)))
  c.money = [0, 0, 0, (random(5) + 1 + random(5) + 1 + random(5) + 1) * 10, 0, 0, 0]
  c.control = 1
  c.status = 'okay'
  c.statusByte = 0
  c.attacks = { count: 2, dice: 1, sides: 2, bonus: 0, range: 0 }
  c.icon = tracks.every((t) => t === 2 || t === 6) ? 1 : 2
  c.iconColours = [0x91, 0xa2, 0xb3, 0xc4, 0xe6, 0xf7]
  c.iconSize = 2
  if (tracks.includes(6)) c.thiefSkills = [30, 25, 20, 15, 10, 10, 85, 0]

  // Clerics know every prayer of the first level; mages start with reading and two more.
  const book: number[] = []
  if (tracks.includes(0)) book.push(1, 2, 3, 4, 5, 6, 7, 8)
  if (tracks.includes(5)) {
    book.push(11, 18)
    const pool = [9, 10, 12, 13, 14, 15, 16, 17, 19, 20, 21]
    for (let i = 0; i < 2; i++) book.push(pool.splice(random(pool.length - 1), 1)[0]!)
  }
  c.spellbook = book.sort((a, b) => a - b)
  c.spellSlots = spellSlotsFor(c)
  return c
}

export const ALIGNMENTS = ['LAWFUL GOOD', 'LAWFUL NEUTRAL', 'LAWFUL EVIL', 'NEUTRAL GOOD', 'TRUE NEUTRAL', 'NEUTRAL EVIL', 'CHAOTIC GOOD', 'CHAOTIC NEUTRAL', 'CHAOTIC EVIL'] as const
