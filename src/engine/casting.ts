/**
 * Spells in play: who can cast what, memorising at camp, and what happens when one
 * goes off. Effects land on `Character` objects, so a party member and a monster are
 * treated alike; the fight-long ones (a blessing, a shield) live on the Combat.
 */

import { CLASS_TRACKS, type Character } from '../formats/character.js'
import { SPELLS, spellById, spellLevelOf, type CasterClass, type Spell } from '../formats/spells.js'
import type { Combat, Combatant, Random } from './combat.js'

export function casterLevel(character: Character, casterClass: CasterClass): number {
  return character.levels[CLASS_TRACKS.indexOf(casterClass)] ?? 0
}

/** Slots per spell level for one class, from the record's six bytes. */
export function slots(character: Character, casterClass: CasterClass): number[] {
  const base = casterClass === 'cleric' ? 0 : 3
  return [1, 2, 3].map((level) => character.spellSlots[base + level - 1] ?? 0)
}

export function canCast(character: Character): boolean {
  return slots(character, 'cleric').some((n) => n > 0) || slots(character, 'magic-user').some((n) => n > 0)
}

/** The spells a character may memorise at a level of a class: known, and of that level. */
export function knownAt(character: Character, casterClass: CasterClass, level: number): number[] {
  return character.spellbook.filter((id) => {
    const at = spellLevelOf(id)
    return at !== undefined && at.class === casterClass && at.level === level
  })
}

/** Checks a chosen list against the book and the slots; returns what did not fit. */
export function memorise(character: Character, ids: readonly number[]): number[] {
  const used = new Map<string, number>()
  const rejected: number[] = []
  const accepted: number[] = []
  for (const id of ids) {
    const at = spellLevelOf(id)
    if (!at || !character.spellbook.includes(id)) { rejected.push(id); continue }
    const key = `${at.class}:${at.level}`
    const have = used.get(key) ?? 0
    if (have >= (slots(character, at.class)[at.level - 1] ?? 0)) { rejected.push(id); continue }
    used.set(key, have + 1)
    accepted.push(id)
  }
  character.prepared = accepted
  character.memorised = [...accepted]
  return rejected
}

/** Fills every slot with something useful: cures for clerics, sleep then missiles for mages. */
export function autoPrepare(character: Character): void {
  const chosen: number[] = []
  const prefer: Record<CasterClass, number[]> = {
    cleric: [3, 1, 6, 23, 28],
    'magic-user': [21, 15, 9, 20, 19, 34, 45, 51, 49],
  }
  for (const casterClass of ['cleric', 'magic-user'] as const) {
    slots(character, casterClass).forEach((count, index) => {
      const level = index + 1
      const known = knownAt(character, casterClass, level)
      if (known.length === 0) return
      const ranked = [...prefer[casterClass].filter((id) => known.includes(id)), ...known.filter((id) => !prefer[casterClass].includes(id))]
      for (let i = 0; i < count; i++) chosen.push(ranked[i % ranked.length]!)
    })
  }
  memorise(character, chosen)
}

/** A rest gives back what was prepared. */
export function refresh(character: Character): void {
  character.memorised = [...character.prepared]
}

/** Spells ready now, as the table knows them. */
export function ready(character: Character): Spell[] {
  return character.memorised.map((id) => spellById(id)).filter((s): s is Spell => s !== undefined)
}

export function forget(character: Character, id: number): boolean {
  const at = character.memorised.indexOf(id)
  if (at < 0) return false
  character.memorised.splice(at, 1)
  return true
}

function roll(dice: number, sides: number, bonus: number, random: Random): number {
  let total = bonus
  for (let i = 0; i < dice; i++) total += random(Math.max(1, sides) - 1) + 1
  return total
}

function savesVsSpell(target: Character, random: Random): boolean {
  const needed = target.savingThrows[4] ?? 20
  return random(19) + 1 >= needed
}

export interface CastResult {
  lines: string[]
}

/**
 * Casts a spell. `targets` is whoever the caster pointed at: one ally, one foe, or
 * the foes in the area of a cloud or a bolt. The combat, when there is one, records
 * the lasting effects and knows who is standing.
 */
export function cast(
  spell: Spell,
  caster: Character,
  targets: readonly Character[],
  random: Random,
  combat?: Combat,
): CastResult {
  const level = Math.max(1, casterLevel(caster, spell.class))
  const lines: string[] = [`${caster.name} CASTS ${spell.name.toUpperCase()}.`]
  const e = spell.effect

  switch (e.kind) {
    case 'heal':
      for (const t of targets) {
        const amount = Math.min(t.hpMax - t.hpCurrent, roll(e.dice ?? 1, e.sides ?? 8, e.bonus ?? 0, random))
        t.hpCurrent += amount
        if (t.status === 'unconscious' && t.hpCurrent > 0) { t.status = 'okay'; t.statusByte = 0 }
        lines.push(`${t.name} IS HEALED ${amount}.`)
      }
      break

    case 'harm':
    case 'damage': {
      const dice = (e.dice ?? 0) + (e.perLevel ?? 0) * level
      const missiles = spell.id === 15 ? Math.floor((level + 1) / 2) : 1
      for (const t of targets) {
        let amount = 0
        for (let m = 0; m < missiles; m++) amount += roll(dice, e.sides ?? 6, e.bonus ?? 0, random)
        if (spell.id === 9 || spell.id === 20) amount = Math.max(amount, level)
        if (spell.target === 'foes' && savesVsSpell(t, random)) amount = Math.floor(amount / 2)
        hurt(t, amount, combat)
        lines.push(`${t.name} TAKES ${amount}${t.status === 'dead' || t.status === 'unconscious' ? ` AND IS ${t.status.toUpperCase()}` : ''}.`)
      }
      break
    }

    case 'sleep': {
      let budget = roll(e.dice ?? 2, e.sides ?? 4, 0, random)
      for (const t of targets) {
        if (t.hitDice > (e.maxHitDice ?? 4) || t.status !== 'okay') continue
        if (t.hitDice > budget) continue
        budget -= Math.max(1, t.hitDice)
        t.status = 'asleep'
        lines.push(`${t.name} FALLS ASLEEP.`)
      }
      if (lines.length === 1) lines.push('NOBODY IS AFFECTED.')
      break
    }

    case 'hold': {
      let left = e.count ?? 3
      for (const t of targets) {
        if (left === 0) break
        if (t.status !== 'okay') continue
        left--
        if (savesVsSpell(t, random)) { lines.push(`${t.name} RESISTS.`); continue }
        t.status = 'held'
        lines.push(`${t.name} IS HELD.`)
      }
      break
    }

    case 'bless':
      combat?.bless(e.bonus ?? 1)
      lines.push('THE PARTY IS BLESSED.')
      break

    case 'shield':
      for (const t of targets) {
        combat?.shield(t, e.bonus ?? 2)
        lines.push(`${t.name} IS PROTECTED.`)
      }
      break

    case 'none':
      lines.push('NOTHING HAPPENS.')
      break
  }
  return { lines }
}

function hurt(target: Character, amount: number, combat?: Combat): void {
  const left = target.hpCurrent - amount
  if (left > 0) {
    target.hpCurrent = left
    return
  }
  target.hpCurrent = 0
  const dead = -left >= 10 || target.race === 0
  target.status = dead ? 'dead' : 'unconscious'
  target.statusByte = dead ? 6 : 4
  combat?.fell(target)
}

/** Everything about spells a fight needs from a combatant list. */
export function charactersOf(combatants: readonly Combatant[]): Character[] {
  return combatants.map((c) => c.member.character)
}

export { SPELLS }
