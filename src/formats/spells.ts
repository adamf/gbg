/**
 * Spells: their names, from START.EXE like the item words, and what the ones the
 * early game leans on actually do.
 *
 * Pool of Radiance numbers spells in the order the utility prints them, one-based
 * from "Bless": the eight first-level prayers, then the thirteen first-level magic-
 * user spells, then second level, then third. A character's 56-byte spell book at
 * 0x33 has a 1 for each spell known, and the six bytes at 0xB2 are the spell slots
 * per level, cleric first then magic-user, three levels each.
 */

const FIRST_SPELL = 'Bless'
const MAX_SPELLS = 90

function printable(byte: number): boolean {
  return byte >= 32 && byte < 127
}

/** Scans the spell names out of START.EXE. Index 0 is empty. */
export function readSpellNames(exe: Uint8Array): string[] {
  const needle = [FIRST_SPELL.length, ...[...FIRST_SPELL].map((c) => c.charCodeAt(0))]
  let at = -1
  for (let i = 0; i + needle.length <= exe.length && at < 0; i++) {
    let match = true
    for (let j = 0; j < needle.length; j++) if (exe[i + j] !== needle[j]) { match = false; break }
    // "Bless" must be followed by "Curse" a few bytes on, or it is some other Bless.
    if (match) {
      let curse = false
      for (let k = i + needle.length; k < i + needle.length + 16; k++) {
        if (exe[k] === 5 && exe[k + 1] === 0x43 && exe[k + 2] === 0x75 && exe[k + 3] === 0x72) curse = true
      }
      if (curse) at = i
    }
  }
  if (at < 0) return []

  const names = ['']
  while (names.length <= MAX_SPELLS) {
    const length = exe[at]!
    let text = ''
    for (let i = 0; i < length; i++) text += String.fromCharCode(exe[at + 1 + i]!)
    names.push(text.trim())
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
  return names
}

export type CasterClass = 'cleric' | 'magic-user'
export type SpellTarget = 'self' | 'ally' | 'party' | 'foe' | 'foes'

export interface SpellEffect {
  kind: 'heal' | 'harm' | 'damage' | 'sleep' | 'hold' | 'bless' | 'shield' | 'none'
  dice?: number
  sides?: number
  bonus?: number
  /** Extra dice per caster level, for the spells that grow. */
  perLevel?: number
  /** For sleep: the most hit dice a target may have. */
  maxHitDice?: number
  /** For sleep and hold: how many targets at most. */
  count?: number
}

export interface Spell {
  id: number
  name: string
  class: CasterClass
  level: number
  target: SpellTarget
  effect: SpellEffect
  /** True for the spells that also work outside combat. */
  anytime?: boolean
}

/**
 * The spells the interpreter can actually cast. Ids are the game's. Others in a
 * character's book are known and can be memorised, but do nothing when cast.
 */
export const SPELLS: readonly Spell[] = [
  { id: 1, name: 'Bless', class: 'cleric', level: 1, target: 'party', effect: { kind: 'bless', bonus: 1 } },
  { id: 3, name: 'Cure Light Wounds', class: 'cleric', level: 1, target: 'ally', effect: { kind: 'heal', dice: 1, sides: 8 }, anytime: true },
  { id: 4, name: 'Cause Light Wounds', class: 'cleric', level: 1, target: 'foe', effect: { kind: 'harm', dice: 1, sides: 8 } },
  { id: 6, name: 'Protection From Evil', class: 'cleric', level: 1, target: 'ally', effect: { kind: 'shield', bonus: 2 } },
  { id: 9, name: 'Burning Hands', class: 'magic-user', level: 1, target: 'foe', effect: { kind: 'damage', dice: 0, sides: 1, bonus: 0, perLevel: 1 } },
  { id: 15, name: 'Magic Missile', class: 'magic-user', level: 1, target: 'foe', effect: { kind: 'damage', dice: 1, sides: 4, bonus: 1 } },
  { id: 19, name: 'Shield', class: 'magic-user', level: 1, target: 'self', effect: { kind: 'shield', bonus: 4 } },
  { id: 20, name: 'Shocking Grasp', class: 'magic-user', level: 1, target: 'foe', effect: { kind: 'damage', dice: 1, sides: 8, bonus: 0, perLevel: 0 } },
  { id: 21, name: 'Sleep', class: 'magic-user', level: 1, target: 'foes', effect: { kind: 'sleep', dice: 2, sides: 4, maxHitDice: 4 } },
  { id: 23, name: 'Hold Person', class: 'cleric', level: 2, target: 'foes', effect: { kind: 'hold', count: 3 } },
  { id: 28, name: 'Spiritual Hammer', class: 'cleric', level: 2, target: 'foe', effect: { kind: 'damage', dice: 1, sides: 6, bonus: 1 } },
  { id: 34, name: 'Stinking Cloud', class: 'magic-user', level: 2, target: 'foes', effect: { kind: 'hold', count: 4 } },
  { id: 45, name: 'Fireball', class: 'magic-user', level: 3, target: 'foes', effect: { kind: 'damage', dice: 0, sides: 6, perLevel: 1, count: 6 } },
  { id: 49, name: 'Hold Person', class: 'magic-user', level: 3, target: 'foes', effect: { kind: 'hold', count: 4 } },
  { id: 51, name: 'Lightning Bolt', class: 'magic-user', level: 3, target: 'foes', effect: { kind: 'damage', dice: 0, sides: 6, perLevel: 1, count: 3 } },
]

export function spellById(id: number): Spell | undefined {
  return SPELLS.find((s) => s.id === id)
}

/** The level and class of any spell id, from the game's numbering, for memorising. */
export function spellLevelOf(id: number): { class: CasterClass; level: number } | undefined {
  if (id >= 1 && id <= 8) return { class: 'cleric', level: 1 }
  if (id >= 9 && id <= 21) return { class: 'magic-user', level: 1 }
  if (id >= 22 && id <= 28) return { class: 'cleric', level: 2 }
  if (id >= 29 && id <= 35) return { class: 'magic-user', level: 2 }
  if (id >= 36 && id <= 44) return { class: 'cleric', level: 3 }
  if (id >= 45 && id <= 55) return { class: 'magic-user', level: 3 }
  return undefined
}

export const SPELLBOOK_OFFSET = 0x33
export const SPELLBOOK_SIZE = 56
export const SPELL_SLOTS_OFFSET = 0xb2
