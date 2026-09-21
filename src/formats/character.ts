/**
 * Characters — the `.SAV`, `.ITM` and `.SPC` files a party member is saved as.
 *
 * Pool of Radiance keeps each character in three files named after the character
 * slot: `CHRDATA1.SAV` is the record, `.ITM` the inventory, `.SPC` the memorised
 * spells. The record is the Curse of the Azure Bonds one with a shorter spell book,
 * which is how `coab`'s `PoolRadPlayer` reads it; the offsets below were checked
 * against all twelve characters the game ships.
 *
 * Armour class and to-hit are stored on an inverted scale, `60 - value`, so a
 * bigger number is better. The readers turn them back into the numbers on the
 * character sheet.
 */

import { u16, u8 } from './bytes.js'

const i16 = (data: Uint8Array, at: number): number => (u16(data, at) << 16) >> 16

export const CHARACTER_RECORD_SIZE = 0x11d
export const ITEM_RECORD_SIZE = 0x3f

export const RACES = ['monster', 'dwarf', 'elf', 'gnome', 'half-elf', 'halfling', 'half-orc', 'human'] as const
export const CLASSES = [
  'cleric', 'druid', 'fighter', 'paladin', 'ranger', 'magic-user', 'thief', 'monk',
  'cleric/fighter', 'cleric/fighter/magic-user', 'cleric/ranger', 'cleric/magic-user', 'cleric/thief',
  'fighter/magic-user', 'fighter/thief', 'fighter/magic-user/thief', 'magic-user/thief',
] as const
/** Index into `levels`: the eight class tracks a character can have levels in. */
export const CLASS_TRACKS = ['cleric', 'druid', 'fighter', 'paladin', 'ranger', 'magic-user', 'thief', 'monk'] as const
export const SAVING_THROWS = ['paralysis/poison/death', 'petrification/polymorph', 'rod/staff/wand', 'breath', 'spell'] as const
export const COINS = ['copper', 'silver', 'electrum', 'gold', 'platinum', 'gems', 'jewellery'] as const

export type Status = 'okay' | 'animated' | 'temporarily gone' | 'running' | 'unconscious' | 'dying' | 'dead' | 'stoned' | 'gone'
  // Not in the file: what a spell did to someone in a fight.
  | 'asleep' | 'held'
const STATUSES: Status[] = ['okay', 'animated', 'temporarily gone', 'running', 'unconscious', 'dying', 'dead', 'stoned', 'gone']

export interface Character {
  name: string
  race: number
  class: number
  age: number
  sex: number
  alignment: number
  /** STR, INT, WIS, DEX, CON, CHA, and exceptional strength percentage. */
  stats: { str: number; int: number; wis: number; dex: number; con: number; cha: number; strPercent: number }
  /** Levels by class track, see CLASS_TRACKS. */
  levels: number[]
  hitDice: number
  hpMax: number
  hpCurrent: number
  /** Armour class as on the sheet: lower is better. */
  ac: number
  acBehind: number
  baseAc: number
  /** To-hit as on the sheet. */
  thac0: number
  /** To-hit bonus in the original's raw scale; 40 is none. */
  hitBonusRaw: number
  savingThrows: number[]
  thiefSkills: number[]
  baseMovement: number
  movement: number
  /** 0 player-controlled; higher is an NPC's morale. */
  control: number
  money: number[]
  experience: number
  /** What a monster is worth when it falls: base plus per-hit-point times the hit points rolled. */
  experienceBase: number
  experiencePerHp: number
  hpRolled: number
  /** For monsters: 4 is the animated dead, which clerics can turn. */
  monsterType: number
  /** The original's health byte; see STATUSES. */
  statusByte: number
  status: Status
  /** Fire or acid has touched them: a troll so marked does not regenerate. Not saved. */
  burnt?: boolean
  /** Dead of poison: slow poison or a temple brings them back. Not saved. */
  poisoned?: boolean
  /** Levels drained by the undead, which restoration gives back. Not saved. */
  drained?: number
  attacks: { count: number; dice: number; sides: number; bonus: number; range?: number; missile?: number }
  /** Old-to-new colour pairs, a nibble each, applied to the combat icon. */
  iconColours: number[]
  /** 1 small (dwarves, gnomes, halflings), 2 normal. */
  iconSize: number
  /** The combat icon's parts: a CHEAD strip over a CBODY frame, the body chosen by the weapon. */
  iconHead: number
  iconBody: number
  /** ICON block holding the combat icon, before recolouring. */
  icon: number
  /** Spell ids the character knows. */
  spellbook: number[]
  /** Spell slots per level: three cleric, then three magic-user. */
  spellSlots: number[]
  /** Spell ids memorised and ready to cast, in slot order. */
  memorised: number[]
  /** What was chosen at camp, refilled by a rest. */
  prepared: number[]
  /** The record as read, so a write-back keeps the bytes this reader does not model. */
  raw?: number[]
}

export interface Item {
  /** The name as the inventory screen last drew it; `itemDisplayName` does better. */
  name: string
  type: number
  /** Three indexes into the item name list; the middle one is a suffix like "Mail". */
  names: [number, number, number]
  plus: number
  readied: boolean
  cursed: boolean
  /** In tenths of a pound. */
  weight: number
  count: number
  value: number
  affects: number[]
  raw?: number[]
}

function pstring(data: Uint8Array, at: number, max: number): string {
  const length = Math.min(u8(data, at), max)
  let text = ''
  for (let i = 0; i < length; i++) text += String.fromCharCode(u8(data, at + 1 + i))
  return text
}

function sheetScale(raw: number): number {
  return 60 - raw
}

/** Reads one character record. Short data reads as zeros rather than failing. */
export function readCharacter(data: Uint8Array): Character {
  const stats = {
    str: u8(data, 0x10), int: u8(data, 0x11), wis: u8(data, 0x12),
    dex: u8(data, 0x13), con: u8(data, 0x14), cha: u8(data, 0x15), strPercent: u8(data, 0x16),
  }
  const levels: number[] = []
  for (let i = 0; i < 8; i++) levels.push(u8(data, 0x96 + i))
  const savingThrows: number[] = []
  for (let i = 0; i < 5; i++) savingThrows.push(u8(data, 0x6d + i))
  const thiefSkills: number[] = []
  for (let i = 0; i < 8; i++) thiefSkills.push(u8(data, 0x78 + i))
  const money: number[] = []
  for (let i = 0; i < 7; i++) money.push(i16(data, 0x88 + i * 2))
  const iconColours: number[] = []
  for (let i = 0; i < 6; i++) iconColours.push(u8(data, 0xc1 + i))
  const spellbook: number[] = []
  for (let i = 0; i < 56; i++) if (u8(data, 0x33 + i) !== 0) spellbook.push(i + 1)
  const spellSlots: number[] = []
  for (let i = 0; i < 6; i++) spellSlots.push(u8(data, 0xb2 + i))

  const statusByte = u8(data, 0x10c)
  return {
    name: pstring(data, 0, 15),
    race: u8(data, 0x2e),
    class: u8(data, 0x2f),
    age: i16(data, 0x30),
    sex: u8(data, 0x9e),
    monsterType: u8(data, 0x9f),
    alignment: u8(data, 0xa0),
    stats,
    levels,
    hitDice: u8(data, 0x73),
    hpMax: u8(data, 0x32),
    hpCurrent: u8(data, 0x11b),
    ac: sheetScale(u8(data, 0x111)),
    acBehind: sheetScale(u8(data, 0x112)),
    baseAc: sheetScale(u8(data, 0xa9)),
    thac0: sheetScale(u8(data, 0x2d)),
    hitBonusRaw: u8(data, 0x110),
    savingThrows,
    thiefSkills,
    baseMovement: u8(data, 0x72),
    movement: u8(data, 0x11c),
    control: u8(data, 0x85),
    money,
    experience: u8(data, 0xac) | (u8(data, 0xad) << 8) | (u8(data, 0xae) << 16) | (u8(data, 0xaf) << 24),
    experienceBase: i16(data, 0xb8),
    experiencePerHp: u8(data, 0xba),
    hpRolled: u8(data, 0xb1),
    statusByte,
    status: STATUSES[statusByte] ?? 'okay',
    attacks: { count: u8(data, 0xa1), dice: u8(data, 0x115), sides: u8(data, 0x117), bonus: u8(data, 0x119) },
    iconColours,
    iconSize: u8(data, 0xc0),
    iconHead: u8(data, 0xbd),
    iconBody: u8(data, 0xbe),
    icon: u8(data, 0xbe),
    spellbook,
    spellSlots,
    memorised: [],
    prepared: [],
    raw: [...data.subarray(0, CHARACTER_RECORD_SIZE)],
  }
}

/**
 * The name field is whatever the inventory screen last drew: a "Yes"/"No" readied
 * column, a count, and sometimes the last word again. This gets the name back out.
 */
export function cleanItemName(cached: string): string {
  const words = cached.trim().split(/\s+/).filter((w) => w !== 'Yes' && w !== 'No')
  if (words.length > 1 && words[words.length - 1] === words[words.length - 2]) words.pop()
  return words.join(' ')
}

/** Reads an inventory file: item records back to back. */
export function readItems(data: Uint8Array): Item[] {
  const items: Item[] = []
  for (let at = 0; at + ITEM_RECORD_SIZE <= data.length; at += ITEM_RECORD_SIZE) {
    items.push({
      name: cleanItemName(pstring(data, at, 0x29)),
      type: u8(data, at + 0x2e),
      names: [u8(data, at + 0x2f), u8(data, at + 0x30), u8(data, at + 0x31)],
      plus: (u8(data, at + 0x32) << 24) >> 24,
      readied: u8(data, at + 0x34) !== 0,
      cursed: u8(data, at + 0x36) !== 0,
      weight: i16(data, at + 0x37),
      count: u8(data, at + 0x39),
      value: i16(data, at + 0x3a),
      affects: [u8(data, at + 0x3c), u8(data, at + 0x3d), u8(data, at + 0x3e)],
      raw: [...data.subarray(at, at + ITEM_RECORD_SIZE)],
    })
  }
  return items
}

export function raceName(character: Character): string {
  return RACES[character.race] ?? `race ${character.race}`
}

export function className(character: Character): string {
  return CLASSES[character.class] ?? `class ${character.class}`
}

/** The highest level the character holds in any class. */
export function characterLevel(character: Character): number {
  return Math.max(0, ...character.levels)
}
