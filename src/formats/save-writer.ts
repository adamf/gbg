/**
 * Writing the original's files back: a character record, an inventory, a saved
 * game. Each starts from the bytes that were read, where there are any, and patches
 * in what this program models, so the fields it does not understand survive a trip
 * through it. A created character starts from zeros.
 */

import { CHARACTER_RECORD_SIZE, ITEM_RECORD_SIZE, type Character, type Item } from './character.js'
import { SAVED_GAME_EXTRA, SAVED_GAME_GLOBALS, SAVED_GAME_SCRATCH } from './library.js'

const STATUS_BYTES: Record<string, number> = {
  okay: 0, animated: 1, 'temporarily gone': 2, running: 3, unconscious: 4, dying: 5, dead: 6, stoned: 7, gone: 8,
  asleep: 0, held: 0,
}

function pstring(into: Uint8Array, at: number, text: string, max: number): void {
  const bytes = [...text.slice(0, max)].map((c) => c.charCodeAt(0) & 0xff)
  into[at] = bytes.length
  for (let i = 0; i < max; i++) into[at + 1 + i] = bytes[i] ?? 0
}

function i16(into: Uint8Array, at: number, value: number): void {
  into[at] = value & 0xff
  into[at + 1] = (value >> 8) & 0xff
}

export function writeCharacter(c: Character): Uint8Array {
  const data = new Uint8Array(CHARACTER_RECORD_SIZE)
  if (c.raw) data.set(c.raw.slice(0, CHARACTER_RECORD_SIZE))
  pstring(data, 0, c.name, 15)
  data.set([c.stats.str, c.stats.int, c.stats.wis, c.stats.dex, c.stats.con, c.stats.cha, c.stats.strPercent], 0x10)
  data[0x2d] = (60 - c.thac0) & 0xff
  data[0x2e] = c.race
  data[0x2f] = c.class
  i16(data, 0x30, c.age)
  data[0x32] = c.hpMax & 0xff
  for (let i = 0; i < 56; i++) data[0x33 + i] = c.spellbook.includes(i + 1) ? 1 : 0
  for (let i = 0; i < 5; i++) data[0x6d + i] = c.savingThrows[i] ?? 20
  data[0x72] = c.baseMovement
  data[0x73] = c.hitDice
  for (let i = 0; i < 8; i++) data[0x78 + i] = c.thiefSkills[i] ?? 0
  data[0x85] = c.control
  for (let i = 0; i < 7; i++) i16(data, 0x88 + i * 2, c.money[i] ?? 0)
  for (let i = 0; i < 8; i++) data[0x96 + i] = c.levels[i] ?? 0
  data[0x9e] = c.sex
  data[0xa0] = c.alignment
  data[0xa1] = c.attacks.count
  data[0xa9] = (60 - c.baseAc) & 0xff
  data[0xac] = c.experience & 0xff
  data[0xad] = (c.experience >> 8) & 0xff
  data[0xae] = (c.experience >> 16) & 0xff
  data[0xaf] = (c.experience >> 24) & 0xff
  for (let i = 0; i < 6; i++) data[0xb2 + i] = c.spellSlots[i] ?? 0
  data[0xc0] = c.icon
  for (let i = 0; i < 6; i++) data[0xc1 + i] = c.iconColours[i] ?? 0
  data[0xc7] = c.iconSize
  data[0x10c] = STATUS_BYTES[c.status] ?? c.statusByte
  data[0x110] = c.hitBonusRaw & 0xff
  data[0x111] = (60 - c.ac) & 0xff
  data[0x112] = (60 - c.acBehind) & 0xff
  data[0x115] = c.attacks.dice
  data[0x117] = c.attacks.sides
  data[0x119] = c.attacks.bonus & 0xff
  data[0x11b] = c.hpCurrent & 0xff
  data[0x11c] = c.movement
  return data
}

export function writeItems(items: readonly Item[], displayNames?: readonly string[]): Uint8Array {
  const data = new Uint8Array(items.length * ITEM_RECORD_SIZE)
  items.forEach((item, index) => {
    const at = index * ITEM_RECORD_SIZE
    if (item.raw) data.set(item.raw.slice(0, ITEM_RECORD_SIZE), at)
    pstring(data, at, displayNames?.[index] ?? item.name, 0x29)
    data[at + 0x2e] = item.type
    data[at + 0x2f] = item.names[0]
    data[at + 0x30] = item.names[1]
    data[at + 0x31] = item.names[2]
    data[at + 0x32] = item.plus & 0xff
    data[at + 0x34] = item.readied ? 1 : 0
    data[at + 0x36] = item.cursed ? 1 : 0
    i16(data, at + 0x37, item.weight)
    data[at + 0x39] = item.count
    i16(data, at + 0x3a, item.value)
    data.set(item.affects.slice(0, 3), at + 0x3c)
  })
  return data
}

export interface SavedGameParts {
  area: number
  globals: Uint8Array
  areaScratch: Uint8Array
  extra: Uint8Array
  /** The current script image, 0x1E00 bytes or fewer. */
  script: Uint8Array
  position: { col: number; row: number; facing: number; wallAhead: number; cellEvent: number }
  /** Base names of the party's character files. */
  party: readonly string[]
}

const SCRIPT_SIZE = 0x1e00
const NAME_SLOT = 0x29

/** Lays a saved game out as the original did. */
export function writeSavedGame(parts: SavedGameParts): Uint8Array {
  const data = new Uint8Array(1 + SAVED_GAME_GLOBALS + SAVED_GAME_SCRATCH + SAVED_GAME_EXTRA + SCRIPT_SIZE + 7 + 1 + 8 * NAME_SLOT)
  let at = 0
  data[at++] = parts.area
  data.set(parts.globals.slice(0, SAVED_GAME_GLOBALS), at); at += SAVED_GAME_GLOBALS
  data.set(parts.areaScratch.slice(0, SAVED_GAME_SCRATCH), at); at += SAVED_GAME_SCRATCH
  data.set(parts.extra.slice(0, SAVED_GAME_EXTRA), at); at += SAVED_GAME_EXTRA
  data.set(parts.script.slice(0, SCRIPT_SIZE), at); at += SCRIPT_SIZE
  data.set([parts.position.col, parts.position.row, parts.position.facing * 2, parts.position.wallAhead, parts.position.cellEvent, 1, 1], at); at += 7
  data[at++] = Math.min(8, parts.party.length)
  for (let i = 0; i < 8; i++) {
    const name = parts.party[i]
    if (name) pstring(data, at + i * NAME_SLOT, name, NAME_SLOT - 1)
  }
  return data
}
