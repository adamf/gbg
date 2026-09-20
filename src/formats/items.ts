/**
 * Item names and item types.
 *
 * An item record names itself by three numbers into one list of words, and the list
 * is not in a data file: it is inline in START.EXE, the program that made characters,
 * as Pascal string literals between the instructions that display them. This scans
 * them out. The list is one-based from "Battle Axe" and runs past the items into
 * other words, which the byte-sized name numbers never reach.
 *
 * An item's *type* is its base name's index, and the type indexes the 16-byte
 * records of the ITEMS file, which say what a thing does: which slot it fills, how
 * many hands, its damage dice against small and large foes, its range.
 */

import type { Item } from './character.js'

const FIRST_NAME = 'Battle Axe'
const MAX_NAMES = 255

function printable(byte: number): boolean {
  return byte >= 32 && byte < 127
}

/** Scans the item name list out of START.EXE. Index 0 is the empty name. */
export function readItemNames(exe: Uint8Array): string[] {
  const needle = [FIRST_NAME.length, ...[...FIRST_NAME].map((c) => c.charCodeAt(0))]
  let at = -1
  for (let i = 0; i + needle.length <= exe.length && at < 0; i++) {
    let match = true
    for (let j = 0; j < needle.length; j++) {
      if (exe[i + j] !== needle[j]) { match = false; break }
    }
    if (match) at = i
  }
  if (at < 0) return []

  const names = ['']
  while (names.length <= MAX_NAMES) {
    const length = exe[at]!
    let text = ''
    for (let i = 0; i < length; i++) text += String.fromCharCode(exe[at + 1 + i]!)
    names.push(text)
    // The next literal is a few instructions on: a length byte, then that many printable bytes.
    const after = at + 1 + length
    let next = -1
    for (let k = after; k < after + 16 && k < exe.length; k++) {
      const candidate = exe[k]!
      if (candidate < 2 || candidate > 40 || k + 1 + candidate > exe.length) continue
      let ok = true
      for (let c = 0; c < candidate; c++) if (!printable(exe[k + 1 + c]!)) { ok = false; break }
      if (ok) { next = k; break }
    }
    if (next < 0) break
    at = next
  }
  return alignToGame(names)
}

/**
 * The game's list has five words START.EXE never shows — two after "Arrow", two
 * before "Holy Symbol", one after "of" — so its indexes run ahead of the scan by that
 * much. Found by matching every item the game ships against the scan; the missing
 * words themselves are unknown.
 */
function alignToGame(names: string[]): string[] {
  const aligned = [...names]
  const insertAfter = (word: string, count: number): void => {
    const at = aligned.indexOf(word)
    if (at > 0) aligned.splice(at + 1, 0, ...new Array<string>(count).fill(''))
  }
  const insertBefore = (word: string, count: number): void => {
    const at = aligned.indexOf(word)
    if (at > 0) aligned.splice(at, 0, ...new Array<string>(count).fill(''))
  }
  insertAfter('Arrow', 2)
  insertBefore('Holy Symbol', 2)
  insertAfter('of', 1)
  return aligned
}

/**
 * "Banded Mail", "Cloak of Displacement", "Sling of Seeking +2", "Broad Sword -2
 * Cursed": the name as the game printed it — the base word, then the middle, then the
 * first, which is where a plus or a curse goes. Unknown words are left out.
 */
export function itemDisplayName(item: Item, names: readonly string[]): string {
  const [first, second, third] = item.names
  const parts = [names[third], names[second], names[first]].filter((p): p is string => Boolean(p))
  let name = parts.length > 0 ? parts.join(' ') : item.name
  if (item.count > 1) name = `${item.count} ${name}${name.endsWith('s') ? '' : 's'}`
  return name
}

export interface ItemType {
  slot: number
  hands: number
  /** Damage dice against large foes. */
  largeDice: number
  largeSides: number
  largeBonus: number
  attacks: number
  dice: number
  sides: number
  bonus: number
  range: number
  classFlags: number
  flags: number
}

export const ITEM_TYPE_COUNT = 0x81

/** The ITEMS file: a two-byte header, then 16-byte records by item type. */
export function readItemTypes(data: Uint8Array): ItemType[] {
  const types: ItemType[] = []
  for (let i = 0; i < ITEM_TYPE_COUNT; i++) {
    const at = 2 + i * 16
    if (at + 16 > data.length) break
    const b = (o: number) => data[at + o]!
    const signed = (o: number) => (b(o) << 24) >> 24
    types.push({
      slot: b(0), hands: b(1),
      largeDice: b(2), largeSides: b(3), largeBonus: signed(4),
      attacks: b(5),
      dice: b(9), sides: b(10), bonus: signed(11),
      range: b(12), classFlags: b(13), flags: b(14),
    })
  }
  return types
}
