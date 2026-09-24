/**
 * Rolling a character the way the original did. The order and the dice follow the
 * community's C# port of the engine (coab, engine/ovr018.cs `createPlayer` and
 * `modifyPlayer`, Classes/Limits.cs): race, sex, class and alignment are chosen first,
 * then every ability is the best of six throws of 3d6+1, aged by the race's table,
 * held within the race's and sex's bounds and raised to the class's minimum. Hit
 * points are the better of two throws of each class's die, with the constitution
 * adjustment, shared between classes. The original's MODIFY then let a point be
 * added or taken from any ability or the hit points, within the same bounds, which
 * is why an 18 was easy to come by.
 *
 * The result is a `Character` like one read from disk, so everything downstream
 * treats it the same. The record is not written back to disk.
 */

import { CHARACTER_RECORD_SIZE, CLASS_TRACKS, CLASSES, RACES, readCharacter, type Character } from '../formats/character.js'
import type { Random } from './combat.js'
import { spellSlotsFor } from './training.js'

export type RaceName = (typeof RACES)[number]
export type ClassName = (typeof CLASSES)[number]
export type StatKey = 'str' | 'int' | 'wis' | 'dex' | 'con' | 'cha'
export const STAT_KEYS: readonly StatKey[] = ['str', 'int', 'wis', 'dex', 'con', 'cha']

export interface Stats { str: number; int: number; wis: number; dex: number; con: number; cha: number }

/** Which classes each race may take (coab Gbl.RaceClasses). Numbers are indexes into CLASSES. */
export const CLASSES_BY_RACE: Record<Exclude<RaceName, 'monster'>, number[]> = {
  human: [0, 2, 5, 6, 3, 4],
  dwarf: [2, 6, 14],
  elf: [2, 5, 6, 13, 14, 15, 16],
  gnome: [2, 6, 14],
  'half-elf': [0, 2, 5, 6, 4, 8, 10, 9, 11, 13, 14, 15, 16],
  halfling: [2, 6, 14],
  'half-orc': [0, 2, 6, 8, 12, 14],
}

/** The alignments each class may hold (coab Gbl.class_alignments), as indexes into ALIGNMENTS. */
const ANY = [0, 1, 2, 3, 4, 5, 6, 7, 8]
const ALIGNMENTS_BY_CLASS: number[][] = [
  ANY, [1, 3, 4, 5, 7], ANY, [0], [0, 3, 6], ANY, [1, 2, 3, 4, 5, 7, 8], ANY,
  ANY, ANY, [0, 3, 6], ANY, ANY, ANY, [1, 2, 3, 4, 5, 7, 8], [1, 2, 3, 4, 5, 7, 8], [1, 2, 3, 4, 5, 7, 8],
]

export function alignmentsFor(classIndex: number): number[] {
  return [...(ALIGNMENTS_BY_CLASS[classIndex] ?? ANY)]
}

/** The tracks a class index covers. */
export function tracksOf(classIndex: number): number[] {
  const name = CLASSES[classIndex] ?? 'fighter'
  const parts = name.split('/')
  return parts.map((part) => CLASS_TRACKS.indexOf(part as (typeof CLASS_TRACKS)[number])).filter((i) => i >= 0)
}

// ---- the tables (coab Classes/Limits.cs), by race index in RACES, then [min, max] by sex ----

type Bound = [male: number, female: number]
type RaceBounds = [min: Bound, max: Bound][]
const STR_BOUNDS: RaceBounds = [[[0, 5], [10, 0]], [[8, 8], [18, 17]], [[3, 3], [18, 16]], [[6, 6], [18, 15]], [[3, 3], [18, 17]], [[6, 6], [17, 14]], [[6, 6], [18, 18]], [[3, 3], [18, 18]]]
const STR00_BOUNDS: RaceBounds = [[[0, 0], [5, 5]], [[0, 0], [99, 0]], [[0, 0], [75, 0]], [[0, 0], [50, 0]], [[0, 0], [90, 0]], [[0, 0], [0, 0]], [[0, 0], [99, 75]], [[0, 0], [100, 50]]]
const INT_BOUNDS: RaceBounds = [[[10, 10], [15, 15]], [[3, 3], [18, 18]], [[8, 8], [18, 18]], [[7, 7], [18, 18]], [[4, 4], [18, 18]], [[6, 6], [18, 18]], [[3, 3], [17, 17]], [[3, 3], [18, 18]]]
const WIS_BOUNDS: RaceBounds = [[[5, 5], [10, 10]], [[3, 3], [18, 18]], [[3, 3], [18, 18]], [[3, 3], [18, 18]], [[3, 3], [18, 18]], [[3, 3], [17, 17]], [[3, 3], [14, 14]], [[3, 3], [18, 18]]]
const DEX_BOUNDS: RaceBounds = [[[10, 10], [15, 15]], [[3, 3], [17, 17]], [[7, 7], [19, 19]], [[3, 3], [18, 18]], [[6, 6], [18, 18]], [[8, 8], [18, 18]], [[3, 3], [17, 17]], [[3, 3], [18, 18]]]
const CON_BOUNDS: RaceBounds = [[[20, 20], [10, 10]], [[12, 12], [19, 19]], [[6, 6], [18, 18]], [[8, 8], [18, 18]], [[6, 6], [18, 18]], [[10, 10], [19, 19]], [[13, 13], [19, 19]], [[3, 3], [18, 18]]]
const CHA_BOUNDS: RaceBounds = [[[12, 12], [12, 12]], [[3, 3], [16, 16]], [[8, 8], [18, 18]], [[3, 3], [18, 18]], [[3, 3], [18, 18]], [[3, 3], [18, 18]], [[3, 3], [12, 12]], [[3, 3], [18, 18]]]
const BOUNDS: Record<StatKey, RaceBounds> = { str: STR_BOUNDS, int: INT_BOUNDS, wis: WIS_BOUNDS, dex: DEX_BOUNDS, con: CON_BOUNDS, cha: CHA_BOUNDS }

/** The least each class asks of an ability, by class index. */
const CLASS_MINIMUMS: Record<StatKey, number[]> = {
  str: [6, 0, 9, 12, 13, 0, 6, 15, 9, 9, 0, 0, 0, 9, 9, 9, 0],
  int: [6, 0, 0, 9, 13, 9, 6, 0, 0, 9, 13, 9, 0, 9, 0, 9, 9],
  wis: [9, 12, 6, 13, 14, 6, 0, 15, 9, 9, 14, 9, 9, 0, 0, 0, 0],
  dex: [0, 0, 6, 0, 0, 6, 9, 15, 0, 0, 0, 0, 9, 0, 9, 9, 9],
  con: [0, 0, 7, 9, 14, 0, 0, 11, 0, 0, 14, 0, 0, 0, 0, 0, 0],
  cha: [0, 15, 0, 17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
}

/** Ages past which the race's abilities shift, and by how much per bracket. */
const AGE_BRACKETS: number[][] = [
  [9999, 9999, 9999, 9999, 9999], [50, 150, 250, 350, 450], [175, 550, 875, 1200, 1600], [90, 300, 450, 600, 750],
  [40, 100, 175, 250, 325], [33, 68, 101, 144, 199], [15, 30, 45, 60, 80], [20, 40, 60, 90, 120],
]
const AGE_EFFECTS: Record<StatKey, number[]> = {
  str: [0, 1, -1, -2, -1], int: [0, 0, 1, 0, 1], wis: [-1, 1, 1, 1, 1], dex: [0, 0, 0, -2, -1], con: [1, 0, -1, -1, -1], cha: [0, 0, 0, 0, 0],
}

/** Starting age: [base, dice, sides] by race, then by single class (cleric … thief). */
type AgeDice = [base: number, dice: number, sides: number]
const NONE: AgeDice = [0, 0, 0]
const AGES: AgeDice[][] = [
  [NONE, NONE, NONE, NONE, NONE, NONE, NONE],
  [[250, 2, 20], NONE, [40, 5, 4], NONE, NONE, NONE, [75, 3, 6]],
  [[650, 10, 10], NONE, [130, 5, 6], NONE, NONE, [150, 5, 6], [100, 5, 6]],
  [[300, 3, 12], NONE, [60, 5, 4], NONE, NONE, [100, 2, 12], [80, 5, 4]],
  [[40, 2, 4], NONE, [22, 3, 4], NONE, NONE, [30, 2, 8], [22, 3, 8]],
  [NONE, NONE, [20, 3, 4], NONE, NONE, NONE, [40, 2, 4]],
  [[20, 1, 4], NONE, [13, 1, 4], NONE, NONE, NONE, [20, 2, 4]],
  [[18, 1, 4], [18, 1, 4], [15, 1, 4], [17, 1, 4], [20, 1, 4], [24, 2, 4], [18, 1, 4]],
]

/** Hit dice per track: sides, dice at first level, and the maximum's per-level bonus. */
const HIT_SIDES = [8, 8, 10, 10, 8, 4, 6, 4]
const FIRST_LEVEL_DICE = [1, 1, 1, 1, 2, 1, 1, 2]
const LEVEL_BONUS = [0, 0, 0, 0, 1, 0, 0, 1]
const HIT_DIE_CAP = [10, 15, 10, 10, 11, 12, 11, 13]
const CON_HP_ADJ = [0, 0, 0, -2, -1, -1, -1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]

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

/** A character in the making: everything the dice and MODIFY decide. */
export interface Draft {
  race: RaceName
  sex: 0 | 1
  classIndex: number
  age: number
  stats: Stats
  strPercent: number
  hp: number
}

const dice = (n: number, sides: number, random: Random): number => {
  let total = 0
  for (let i = 0; i < n; i++) total += random(sides - 1) + 1
  return total
}

const isFighterish = (classIndex: number) => tracksOf(classIndex).some((t) => t === 2 || t === 3 || t === 4)

/** Starting age: the class's dice on the race's table; a multi-class takes the largest of its first class's. */
export function rollAge(race: RaceName, classIndex: number, random: Random): number {
  const table = AGES[RACES.indexOf(race)] ?? AGES[7]!
  if (classIndex <= 7) {
    const [base, n, sides] = table[classIndex] ?? NONE
    return base + dice(n, sides, random)
  }
  const column = classIndex <= 12 ? 0 : classIndex === 14 ? 2 : 6
  const [base, n, sides] = table[column] ?? NONE
  return base + n * sides
}

function raceBound(key: StatKey, race: RaceName, sex: 0 | 1): [min: number, max: number] {
  const bounds = BOUNDS[key][RACES.indexOf(race)] ?? BOUNDS[key][7]!
  return [bounds[0][sex], bounds[1][sex]]
}

function strPercentMax(race: RaceName, sex: 0 | 1): number {
  return (STR00_BOUNDS[RACES.indexOf(race)] ?? STR00_BOUNDS[7]!)[1][sex]
}

function classMinimum(key: StatKey, classIndex: number): number {
  let min = CLASS_MINIMUMS[key][classIndex] ?? 0
  // A multi-class cleric needs the wisdom of one.
  if (key === 'wis' && classIndex >= 8 && classIndex <= 12) min = Math.max(min, 13)
  return min
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

/** The bounds MODIFY works within: the race's and sex's, raised to the class's minimum. */
export function limits(draft: Draft): Record<StatKey | 'hp', [min: number, max: number]> {
  const out = {} as Record<StatKey | 'hp', [number, number]>
  for (const key of STAT_KEYS) {
    const [min, max] = raceBound(key, draft.race, draft.sex)
    out[key] = [Math.max(min, classMinimum(key, draft.classIndex)), max]
  }
  out.hp = [minHitPoints(draft.classIndex, draft.stats.con), maxHitPoints(draft.classIndex, draft.stats.con)]
  return out
}

/** Every ability the best of six throws of 3d6+1, aged, bounded, raised to the class. */
export function rollStats(race: RaceName, sex: 0 | 1, classIndex: number, age: number, random: Random): { stats: Stats; strPercent: number } {
  const stats = { str: 0, int: 0, wis: 0, dex: 0, con: 0, cha: 0 }
  for (let i = 0; i < 6; i++) {
    for (const key of STAT_KEYS) stats[key] = Math.max(stats[key], dice(3, 6, random) + 1)
  }
  const brackets = AGE_BRACKETS[RACES.indexOf(race)] ?? AGE_BRACKETS[7]!
  for (const key of STAT_KEYS) {
    for (let i = 0; i < 5; i++) if (brackets[i]! < age) stats[key] += AGE_EFFECTS[key][i]!
    const [min, max] = raceBound(key, race, sex)
    stats[key] = clamp(stats[key], min, max)
    stats[key] = Math.max(stats[key], classMinimum(key, classIndex))
  }
  let strPercent = 0
  if (stats.str === 18 && isFighterish(classIndex)) strPercent = Math.min(random(99) + 1, strPercentMax(race, sex))
  return { stats, strPercent }
}

/** The constitution's share of first-level hit points, the way the roll counted it. */
function conHitPointAdjust(classIndex: number, con: number): number {
  let adj = 0
  for (const track of tracksOf(classIndex)) {
    if (HIT_DIE_CAP[track]! <= 1) continue
    adj += CON_HP_ADJ[Math.min(con, 25)] ?? 0
    if (classIndex === 2 || classIndex === 3 || classIndex === 4) adj += con === 17 ? 1 : con === 18 ? 2 : con >= 19 ? 3 : 0
  }
  return adj
}

function shareHitPoints(total: number, adj: number, count: number): number {
  if (adj < 0) return total > Math.abs(adj) + count ? Math.floor((total + adj) / count) : 1
  return Math.floor((total + adj) / count)
}

/** The better of two throws of each class's die, plus constitution, shared between classes. */
export function rollHitPoints(classIndex: number, con: number, random: Random): number {
  const tracks = tracksOf(classIndex)
  let total = 0
  for (const track of tracks) {
    const n = FIRST_LEVEL_DICE[track]!
    total += Math.max(dice(n, HIT_SIDES[track]!, random), dice(n, HIT_SIDES[track]!, random))
  }
  return Math.max(1, shareHitPoints(total, conHitPointAdjust(classIndex, con), tracks.length))
}

/** The constitution bonus a die gets, by track (coab con_bonus). */
function conBonus(track: number, con: number): number {
  if (con === 3) return -2
  if (con <= 6) return -1
  if (con <= 14) return 0
  if (con <= 16) return 1
  return track === 2 || track === 3 || track === 4 ? con - 14 : 2
}

/** The most a first-level character of the class can have: full dice with the bonus, shared. */
export function maxHitPoints(classIndex: number, con: number): number {
  const tracks = tracksOf(classIndex)
  let total = 0
  for (const track of tracks) total += (conBonus(track, con) + HIT_SIDES[track]!) * (1 + LEVEL_BONUS[track]!)
  return Math.max(1, Math.floor(total / tracks.length))
}

/** The least: a point a die, with the constitution's adjustment. */
export function minHitPoints(classIndex: number, con: number): number {
  const tracks = tracksOf(classIndex)
  let total = 0
  for (const track of tracks) total += 1 + LEVEL_BONUS[track]!
  return Math.max(1, shareHitPoints(total, conHitPointAdjust(classIndex, con), tracks.length))
}

/** A fresh draft: the age, the abilities and the hit points, all from the dice. */
export function rollDraft(race: RaceName, sex: 0 | 1, classIndex: number, random: Random): Draft {
  const age = rollAge(race, classIndex, random)
  const { stats, strPercent } = rollStats(race, sex, classIndex, age, random)
  return { race, sex, classIndex, age, stats, strPercent, hp: rollHitPoints(classIndex, stats.con, random) }
}

/**
 * The original's MODIFY: a point up or down on an ability or the hit points, held
 * within the race's, sex's and class's bounds. Strength at 18 goes on into the
 * percentile for the fighting classes, a point a press.
 */
export function modify(draft: Draft, key: StatKey | 'hp', delta: 1 | -1): Draft {
  const next: Draft = { ...draft, stats: { ...draft.stats } }
  if (key === 'hp') {
    next.hp = clamp(next.hp + delta, minHitPoints(next.classIndex, next.stats.con), maxHitPoints(next.classIndex, next.stats.con))
    return next
  }
  const [min, max] = raceBound(key, next.race, next.sex)
  if (key === 'str') {
    if (delta > 0) {
      next.stats.str = clamp(next.stats.str + 1, min, max)
      if (next.stats.str === 18 && isFighterish(next.classIndex)) next.strPercent = Math.min(next.strPercent + 1, strPercentMax(next.race, next.sex))
      else next.strPercent = 0
    } else if (next.strPercent > 0) {
      next.strPercent -= 1
    } else {
      next.stats.str = clamp(next.stats.str - 1, min, max)
    }
    next.stats.str = Math.max(next.stats.str, classMinimum('str', next.classIndex))
    return next
  }
  next.stats[key] = clamp(next.stats[key] + delta, min, max)
  next.stats[key] = Math.max(next.stats[key], classMinimum(key, next.classIndex))
  if (key === 'con') next.hp = clamp(next.hp, minHitPoints(next.classIndex, next.stats.con), maxHitPoints(next.classIndex, next.stats.con))
  return next
}

export interface Rolled {
  name: string
  alignment: number
  draft: Draft
}

/** A first-level character from the choices and dice. */
export function createCharacter(rolled: Rolled, random: Random): Character {
  const { draft } = rolled
  const c = readCharacter(new Uint8Array(CHARACTER_RECORD_SIZE))
  c.name = rolled.name.toUpperCase().slice(0, 15)
  c.race = RACES.indexOf(draft.race)
  c.class = draft.classIndex
  c.sex = draft.sex
  c.alignment = rolled.alignment
  c.stats = { ...draft.stats, strPercent: draft.stats.str === 18 && isFighterish(draft.classIndex) ? draft.strPercent : 0 }
  c.age = draft.age

  const tracks = tracksOf(draft.classIndex)
  for (const track of tracks) c.levels[track] = 1
  c.hpMax = Math.max(1, draft.hp)
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
  c.money = [0, 0, 0, dice(3, 6, random) * 10, 0, 0, 0]
  c.control = 1
  c.status = 'okay'
  c.statusByte = 0
  c.attacks = { count: 2, dice: 1, sides: 2, bonus: 0, range: 0 }
  c.icon = tracks.every((t) => t === 2 || t === 6) ? 1 : 2
  c.iconColours = [0x91, 0xa2, 0xb3, 0xc4, 0xe6, 0xf7]
  c.iconSize = draft.race === 'dwarf' || draft.race === 'gnome' || draft.race === 'halfling' ? 1 : 2
  if (tracks.includes(6)) c.thiefSkills = [30, 25, 20, 15, 10, 10, 85, 0]

  // Clerics know every prayer of the first level; a mage's book opens with the
  // original's four: detect magic, enlarge, read magic and sleep.
  const book: number[] = []
  if (tracks.includes(0)) book.push(1, 2, 3, 4, 5, 6, 7, 8)
  if (tracks.includes(5)) book.push(11, 12, 18, 21)
  c.spellbook = book.sort((a, b) => a - b)
  c.spellSlots = spellSlotsFor(c)
  return c
}

export const ALIGNMENTS = ['LAWFUL GOOD', 'LAWFUL NEUTRAL', 'LAWFUL EVIL', 'NEUTRAL GOOD', 'TRUE NEUTRAL', 'NEUTRAL EVIL', 'CHAOTIC GOOD', 'CHAOTIC NEUTRAL', 'CHAOTIC EVIL'] as const
