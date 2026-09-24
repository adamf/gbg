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

/** A lasting effect on a character, with rounds to run. */
export type AffectKind = 'hit' | 'ac' | 'damage' | 'haste' | 'slow' | 'silence' | 'missileProof' | 'resistFire' | 'resistCold' | 'invisible'

export interface SpellEffect {
  kind: 'heal' | 'harm' | 'damage' | 'sleep' | 'hold' | 'bless' | 'curse' | 'shield' | 'buff' | 'weaken' | 'cure' | 'dispel' | 'utility' | 'none'
  dice?: number
  sides?: number
  bonus?: number
  /** Extra dice per caster level, for the spells that grow. */
  perLevel?: number
  /** For sleep: the most hit dice a target may have. */
  maxHitDice?: number
  /** For sleep and hold: how many targets at most. */
  count?: number
  /** For buffs and weakenings: what lands, how much, and for how long. */
  affect?: AffectKind
  amount?: number
  rounds?: number
  roundsPerLevel?: number
  /** A weakening the target may save against. */
  save?: boolean
  /** For cures: what is undone. */
  cures?: ('poison' | 'drain' | 'blind' | 'disease' | 'curse' | 'held')[]
  /** For utility spells: what the screen says. */
  text?: string
  /** Only creatures whose name matches are affected (snake charm). */
  only?: string
}

/** How far a spell reaches on the combat grid, in squares: a number, so many plus so many a level, or touch. */
export type SpellRange = number | { base: number; perLevel: number } | 'touch'
/** The squares a spell covers: a disc of so many squares' radius about the target, a block so many across, or a line so long from the caster. */
export type SpellArea = { kind: 'circle'; radius: number } | { kind: 'block'; size: number } | { kind: 'line'; length: number }

export interface Spell {
  id: number
  name: string
  class: CasterClass
  level: number
  target: SpellTarget
  effect: SpellEffect
  /** True for the spells that also work outside combat. */
  anytime?: boolean
  /** The manual's range; nothing means anywhere on the field. */
  range?: SpellRange
  /** For the spells that fill squares rather than pick foes: everyone inside is affected, friend or foe. */
  area?: SpellArea
}

/**
 * The spells the interpreter can actually cast. Ids are the game's. Others in a
 * character's book are known and can be memorised, but do nothing when cast.
 */
export const SPELLS: readonly Spell[] = [
  // ---- first level, cleric
  { id: 1, name: 'Bless', class: 'cleric', level: 1, target: 'party', effect: { kind: 'bless', bonus: 1, rounds: 6 }, range: 6 },
  { id: 2, name: 'Curse', class: 'cleric', level: 1, target: 'foes', effect: { kind: 'curse', bonus: 1, rounds: 6 }, range: 6 },
  { id: 3, name: 'Cure Light Wounds', class: 'cleric', level: 1, target: 'ally', effect: { kind: 'heal', dice: 1, sides: 8 }, anytime: true, range: 'touch' },
  { id: 4, name: 'Cause Light Wounds', class: 'cleric', level: 1, target: 'foe', effect: { kind: 'harm', dice: 1, sides: 8 }, range: 'touch' },
  { id: 5, name: 'Detect Magic', class: 'cleric', level: 1, target: 'self', effect: { kind: 'utility', text: 'THE MAGIC ABOUT YOU GLOWS FAINTLY.' }, anytime: true },
  { id: 6, name: 'Protection From Evil', class: 'cleric', level: 1, target: 'ally', effect: { kind: 'shield', bonus: 2, roundsPerLevel: 3 }, anytime: true },
  { id: 7, name: 'Protection From Good', class: 'cleric', level: 1, target: 'ally', effect: { kind: 'shield', bonus: 2, roundsPerLevel: 3 }, anytime: true },
  { id: 8, name: 'Resist Cold', class: 'cleric', level: 1, target: 'ally', effect: { kind: 'buff', affect: 'resistCold', amount: 1, roundsPerLevel: 10 }, anytime: true },
  // ---- first level, magic-user
  { id: 9, name: 'Burning Hands', class: 'magic-user', level: 1, target: 'foe', effect: { kind: 'damage', dice: 0, sides: 1, bonus: 0, perLevel: 1 }, range: 'touch' },
  { id: 10, name: 'Charm Person', class: 'magic-user', level: 1, target: 'foes', effect: { kind: 'hold', count: 1, rounds: 99 }, range: 12 },
  { id: 11, name: 'Detect Magic', class: 'magic-user', level: 1, target: 'self', effect: { kind: 'utility', text: 'THE MAGIC ABOUT YOU GLOWS FAINTLY.' }, anytime: true },
  { id: 12, name: 'Enlarge', class: 'magic-user', level: 1, target: 'ally', effect: { kind: 'buff', affect: 'damage', amount: 2, roundsPerLevel: 10 } },
  { id: 13, name: 'Reduce', class: 'magic-user', level: 1, target: 'foe', effect: { kind: 'weaken', affect: 'damage', amount: 2, roundsPerLevel: 10, save: true } },
  { id: 14, name: 'Friends', class: 'magic-user', level: 1, target: 'self', effect: { kind: 'utility', text: 'YOU SEEM A LITTLE MORE LIKEABLE.' }, anytime: true },
  { id: 15, name: 'Magic Missile', class: 'magic-user', level: 1, target: 'foe', effect: { kind: 'damage', dice: 1, sides: 4, bonus: 1 }, range: { base: 6, perLevel: 1 } },
  { id: 16, name: 'Protection From Evil', class: 'magic-user', level: 1, target: 'ally', effect: { kind: 'shield', bonus: 2, roundsPerLevel: 2 }, anytime: true },
  { id: 17, name: 'Protection From Good', class: 'magic-user', level: 1, target: 'ally', effect: { kind: 'shield', bonus: 2, roundsPerLevel: 2 }, anytime: true },
  { id: 18, name: 'Read Magic', class: 'magic-user', level: 1, target: 'self', effect: { kind: 'utility', text: 'THE WRITING MAKES SENSE FOR A WHILE.' }, anytime: true },
  { id: 19, name: 'Shield', class: 'magic-user', level: 1, target: 'self', effect: { kind: 'shield', bonus: 4, roundsPerLevel: 5 } },
  { id: 20, name: 'Shocking Grasp', class: 'magic-user', level: 1, target: 'foe', effect: { kind: 'damage', dice: 1, sides: 8, bonus: 0, perLevel: 0 }, range: 'touch' },
  { id: 21, name: 'Sleep', class: 'magic-user', level: 1, target: 'foes', effect: { kind: 'sleep', dice: 2, sides: 4, maxHitDice: 4, roundsPerLevel: 5 }, range: { base: 3, perLevel: 1 }, area: { kind: 'block', size: 3 } },
  // ---- second level, cleric
  { id: 22, name: 'Find Traps', class: 'cleric', level: 2, target: 'self', effect: { kind: 'utility', text: 'YOU SEE NO TRAPS NEARBY.' }, anytime: true },
  { id: 23, name: 'Hold Person', class: 'cleric', level: 2, target: 'foes', effect: { kind: 'hold', count: 3, rounds: 4, roundsPerLevel: 1 }, range: 6 },
  { id: 24, name: 'Resist Fire', class: 'cleric', level: 2, target: 'ally', effect: { kind: 'buff', affect: 'resistFire', amount: 1, roundsPerLevel: 10 }, anytime: true },
  { id: 25, name: "Silence, 15' Radius", class: 'cleric', level: 2, target: 'foes', effect: { kind: 'weaken', affect: 'silence', amount: 1, count: 3, roundsPerLevel: 2, save: true }, range: 12, area: { kind: 'block', size: 3 } },
  { id: 26, name: 'Slow Poison', class: 'cleric', level: 2, target: 'ally', effect: { kind: 'cure', cures: ['poison'] }, anytime: true },
  { id: 27, name: 'Snake Charm', class: 'cleric', level: 2, target: 'foes', effect: { kind: 'hold', count: 4, rounds: 5, only: 'SNAKE' }, range: 3 },
  { id: 28, name: 'Spiritual Hammer', class: 'cleric', level: 2, target: 'foe', effect: { kind: 'damage', dice: 1, sides: 6, bonus: 1 }, range: 3 },
  // ---- second level, magic-user
  { id: 29, name: 'Detect Invisibility', class: 'magic-user', level: 2, target: 'self', effect: { kind: 'utility', text: 'NOTHING UNSEEN IS NEAR.' } },
  { id: 30, name: 'Invisibility', class: 'magic-user', level: 2, target: 'self', effect: { kind: 'buff', affect: 'ac', amount: 4, rounds: 99 } },
  { id: 31, name: 'Knock', class: 'magic-user', level: 2, target: 'self', effect: { kind: 'utility', text: 'ANY LOCK NEARBY GIVES.' }, anytime: true },
  { id: 32, name: 'Mirror Image', class: 'magic-user', level: 2, target: 'self', effect: { kind: 'buff', affect: 'ac', amount: 2, roundsPerLevel: 2 } },
  { id: 33, name: 'Ray of Enfeeblement', class: 'magic-user', level: 2, target: 'foe', effect: { kind: 'weaken', affect: 'damage', amount: 3, roundsPerLevel: 1, save: true } },
  { id: 34, name: 'Stinking Cloud', class: 'magic-user', level: 2, target: 'foes', effect: { kind: 'hold', count: 4, dice: 1, sides: 4, rounds: 1 }, range: 3, area: { kind: 'block', size: 3 } },
  { id: 35, name: 'Strength', class: 'magic-user', level: 2, target: 'ally', effect: { kind: 'buff', affect: 'damage', amount: 2, rounds: 99 }, anytime: true },
  // ---- third level, cleric
  { id: 36, name: 'Animate Dead', class: 'cleric', level: 3, target: 'self', effect: { kind: 'none' } },
  { id: 37, name: 'Cure Blindness', class: 'cleric', level: 3, target: 'ally', effect: { kind: 'cure', cures: ['blind'] }, anytime: true },
  { id: 38, name: 'Cause Blindness', class: 'cleric', level: 3, target: 'foe', effect: { kind: 'weaken', affect: 'hit', amount: 4, rounds: 99, save: true } },
  { id: 39, name: 'Cure Disease', class: 'cleric', level: 3, target: 'ally', effect: { kind: 'cure', cures: ['disease'] }, anytime: true },
  { id: 40, name: 'Cause Disease', class: 'cleric', level: 3, target: 'foe', effect: { kind: 'weaken', affect: 'damage', amount: 2, rounds: 99, save: true } },
  { id: 41, name: 'Dispel Magic', class: 'cleric', level: 3, target: 'foes', effect: { kind: 'dispel' }, anytime: true },
  { id: 42, name: 'Prayer', class: 'cleric', level: 3, target: 'party', effect: { kind: 'bless', bonus: 1, roundsPerLevel: 1 } },
  { id: 43, name: 'Remove Curse', class: 'cleric', level: 3, target: 'ally', effect: { kind: 'cure', cures: ['curse'] }, anytime: true },
  { id: 44, name: 'Bestow Curse', class: 'cleric', level: 3, target: 'foe', effect: { kind: 'weaken', affect: 'hit', amount: 2, roundsPerLevel: 1, save: true } },
  // ---- third level, magic-user
  { id: 45, name: 'Blink', class: 'magic-user', level: 3, target: 'self', effect: { kind: 'buff', affect: 'ac', amount: 2, roundsPerLevel: 1 } },
  { id: 46, name: 'Dispel Magic', class: 'magic-user', level: 3, target: 'foes', effect: { kind: 'dispel' }, anytime: true },
  { id: 47, name: 'Fireball', class: 'magic-user', level: 3, target: 'foes', effect: { kind: 'damage', dice: 0, sides: 6, perLevel: 1, count: 6 }, range: { base: 10, perLevel: 1 }, area: { kind: 'circle', radius: 2 } },
  { id: 48, name: 'Haste', class: 'magic-user', level: 3, target: 'party', effect: { kind: 'buff', affect: 'haste', amount: 1, rounds: 3, roundsPerLevel: 1 } },
  { id: 49, name: 'Hold Person', class: 'magic-user', level: 3, target: 'foes', effect: { kind: 'hold', count: 4, rounds: 2, roundsPerLevel: 1 }, range: 12 },
  { id: 50, name: "Invisibility, 10' Radius", class: 'magic-user', level: 3, target: 'party', effect: { kind: 'buff', affect: 'ac', amount: 2, rounds: 99 } },
  { id: 51, name: 'Lightning Bolt', class: 'magic-user', level: 3, target: 'foes', effect: { kind: 'damage', dice: 0, sides: 6, perLevel: 1, count: 3 }, range: { base: 4, perLevel: 1 }, area: { kind: 'line', length: 8 } },
  { id: 52, name: "Protection From Evil, 10' Radius", class: 'cleric', level: 3, target: 'party', effect: { kind: 'shield', bonus: 2, roundsPerLevel: 1 } },
  { id: 53, name: "Protection From Good, 10' Radius", class: 'cleric', level: 3, target: 'party', effect: { kind: 'shield', bonus: 2, roundsPerLevel: 1 } },
  { id: 54, name: 'Protection From Normal Missiles', class: 'magic-user', level: 3, target: 'ally', effect: { kind: 'buff', affect: 'missileProof', amount: 1, roundsPerLevel: 10 } },
  { id: 55, name: 'Slow', class: 'magic-user', level: 3, target: 'foes', effect: { kind: 'weaken', affect: 'slow', amount: 1, count: 4, rounds: 3, roundsPerLevel: 1, save: true }, range: { base: 9, perLevel: 1 } },
  { id: 56, name: 'Restoration', class: 'cleric', level: 3, target: 'ally', effect: { kind: 'cure', cures: ['drain'] }, anytime: true },
]

/** Every spell's name by the game's number, so the ones without an effect still have one. */
export const SPELL_NAMES: readonly string[] = [
  '', 'Bless', 'Curse', 'Cure Light Wounds', 'Cause Light Wounds', 'Detect Magic', 'Protection From Evil',
  'Protection From Good', 'Resist Cold', 'Burning Hands', 'Charm Person', 'Detect Magic', 'Enlarge', 'Reduce',
  'Friends', 'Magic Missile', 'Protection From Evil', 'Protection From Good', 'Read Magic', 'Shield',
  'Shocking Grasp', 'Sleep', 'Find Traps', 'Hold Person', 'Resist Fire', "Silence, 15' Radius", 'Slow Poison',
  'Snake Charm', 'Spiritual Hammer', 'Detect Invisibility', 'Invisibility', 'Knock', 'Mirror Image',
  'Ray of Enfeeblement', 'Stinking Cloud', 'Strength', 'Animate Dead', 'Cure Blindness', 'Cause Blindness',
  'Cure Disease', 'Cause Disease', 'Dispel Magic', 'Prayer', 'Remove Curse', 'Bestow Curse', 'Blink',
  'Dispel Magic', 'Fireball', 'Haste', 'Hold Person', "Invisibility, 10' Radius", 'Lightning Bolt',
  "Protection From Evil, 10' Radius", "Protection From Good, 10' Radius", 'Protection From Normal Missiles',
  'Slow', 'Restoration',
]

/**
 * A spell by the game's number. Spells the table does not describe still come back,
 * with no effect, so they can be memorised and cast the way the original allowed.
 */
export function spellById(id: number): Spell | undefined {
  const known = SPELLS.find((s) => s.id === id)
  if (known) return known
  const at = spellLevelOf(id)
  const name = SPELL_NAMES[id]
  if (!at || !name) return undefined
  return { id, name, class: at.class, level: at.level, target: 'self', effect: { kind: 'none' } }
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
