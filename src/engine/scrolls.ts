/**
 * Scrolls: a Magic User Scroll or Clerical Scroll carries up to three spells in its
 * affect bytes, and its name says how many are left. A caster of the right class
 * reads one to cast it, and a magic-user may copy one into the spellbook instead.
 */
import type { Character, Item } from '../formats/character.js'
import { spellById, type CasterClass, type Spell } from '../formats/spells.js'
import { casterLevel, slots } from './casting.js'

export const TYPE_MU_SCROLL = 61
export const TYPE_CLERIC_SCROLL = 62
/** The name-table entries "With 1 Spell", "With 2 Spells", "With 3 Spells" are 210 to 212. */
const WITH_SPELLS = 209
/** A scroll's spells work as a sixth-level caster's when the reader is lower. */
const SCROLL_CASTER_LEVEL = 6

export function isScroll(item: Item): boolean {
  return item.type === TYPE_MU_SCROLL || item.type === TYPE_CLERIC_SCROLL
}

export function scrollClass(item: Item): CasterClass | undefined {
  return item.type === TYPE_MU_SCROLL ? 'magic-user' : item.type === TYPE_CLERIC_SCROLL ? 'cleric' : undefined
}

/** The spells still on a scroll, in the order written. */
export function scrollSpells(item: Item): Spell[] {
  if (!isScroll(item)) return []
  return item.affects.slice(0, item.plus + 1).map((id) => (id > 0 ? spellById(id) : undefined)).filter((s): s is Spell => s !== undefined)
}

/** Whether this character's class can read the scroll at all. */
export function canReadScroll(character: Character, item: Item): boolean {
  const cls = scrollClass(item)
  return cls !== undefined && casterLevel(character, cls) > 0
}

/** The reader as the scroll's caster: their own level, or the scroll's sixth. */
export function scrollReader(character: Character, item: Item): Character {
  const cls = scrollClass(item)
  if (!cls) return character
  const at = cls === 'cleric' ? 0 : 5
  const levels = [...character.levels]
  levels[at] = Math.max(levels[at] ?? 0, SCROLL_CASTER_LEVEL)
  return { ...character, levels }
}

/** Takes one spell off the scroll: the affects close up and the name counts down. */
export function readFromScroll(item: Item, spellId: number): void {
  const at = item.affects.indexOf(spellId)
  if (at < 0) return
  const rest = item.affects.filter((id, i) => i !== at && id > 0)
  item.affects = [...rest, 0, 0, 0].slice(0, 3)
  item.plus = Math.max(0, rest.length - 1)
  if (rest.length > 0) item.names = [item.names[0], WITH_SPELLS + rest.length, item.names[2]]
}

/** A magic-user may copy a scroll's spell not yet in the book, if the level is one they can cast. */
export function canScribe(character: Character, spell: Spell): boolean {
  if (spell.class !== 'magic-user' || casterLevel(character, 'magic-user') === 0) return false
  if (character.spellbook.includes(spell.id)) return false
  return (slots(character, 'magic-user')[spell.level - 1] ?? 0) > 0
}

export function scribe(character: Character, item: Item, spell: Spell): void {
  character.spellbook.push(spell.id)
  readFromScroll(item, spell.id)
}
