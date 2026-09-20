/**
 * Combat, resolved a round at a time.
 *
 * This is the AD&D fight without the grid: everyone who can act attacks something,
 * to-hit against armour class on a d20, damage from their current attack dice. It
 * is enough for the scripts' fights to have an outcome that costs hit points and
 * pays experience. The tactical map — moving, ranged fire, spells — comes later and
 * replaces the inside of `round`, not the shape of it.
 */

import type { Character } from '../formats/character.js'
import type { Member } from './roster.js'

export interface Combatant {
  member: Member
  /** Monsters carry their group's number so the log can tell two orcs apart. */
  label: string
}

export type Random = (max: number) => number

/** Whether an attacker's roll lands on a defender: THAC0 minus AC, on a d20. */
export function hits(attacker: Character, defender: Character, roll: number): boolean {
  const needed = attacker.thac0 - defender.ac
  return roll >= needed || roll === 20
}

export function rollDamage(attacker: Character, random: Random): number {
  const { dice, sides, bonus } = attacker.attacks
  let total = bonus
  for (let i = 0; i < Math.max(1, dice); i++) total += random(Math.max(1, sides) - 1) + 1
  return Math.max(1, total)
}

/** Up and able to act. */
function alive(c: Combatant): boolean {
  return c.member.character.status === 'okay' && c.member.character.hpCurrent > 0
}

/** Still a target: standing, or helpless but not yet down. */
function standing(c: Combatant): boolean {
  const s = c.member.character.status
  return (s === 'okay' || s === 'asleep' || s === 'held') && c.member.character.hpCurrent > 0
}

function helpless(c: Combatant): boolean {
  const s = c.member.character.status
  return s === 'asleep' || s === 'held'
}

function down(c: Combatant, overkill: number): void {
  const character = c.member.character
  character.hpCurrent = 0
  const dead = overkill >= 10 || character.race === 0 || character.status === 'asleep' || character.status === 'held'
  character.status = dead ? 'dead' : 'unconscious'
  character.statusByte = dead ? 6 : 4
}

export class Combat {
  round = 0
  readonly log: string[] = []
  /** To-hit bonus the party carries for the fight, from a blessing. */
  private partyHitBonus = 0
  /** Armour class bonus by character, from shields and protections. */
  private readonly acBonus = new Map<Character, number>()
  /** Who has already acted this round — casters, mostly. */
  readonly acted = new Set<Character>()

  constructor(
    readonly party: Combatant[],
    readonly monsters: Combatant[],
    private readonly random: Random,
  ) {}

  get partyStanding(): Combatant[] {
    return this.party.filter(standing)
  }

  get monstersStanding(): Combatant[] {
    return this.monsters.filter(standing)
  }

  get over(): boolean {
    return this.party.filter(alive).length === 0 || this.monstersStanding.length === 0
  }

  bless(bonus: number): void {
    this.partyHitBonus += bonus
  }

  shield(character: Character, bonus: number): void {
    this.acBonus.set(character, (this.acBonus.get(character) ?? 0) + bonus)
  }

  /** A spell dropped someone; nothing more to do, the status says it. */
  fell(_character: Character): void {}

  /** Woken by a blow: a sleeping foe that is hit and survives wakes up. */
  private wake(c: Combatant): void {
    if (c.member.character.status === 'asleep') { c.member.character.status = 'okay' }
  }

  /** Everyone acts once, in a random order that favours the quick. */
  next(): string[] {
    this.round++
    const lines: string[] = []
    const order = [...this.party.filter(alive), ...this.monsters.filter(alive)]
      .map((c) => ({ c, initiative: this.random(9) + Math.floor(c.member.character.movement / 3) }))
      .sort((a, b) => b.initiative - a.initiative)
      .map((x) => x.c)

    for (const attacker of order) {
      if (!alive(attacker) || this.acted.has(attacker.member.character)) continue
      const ours = this.party.includes(attacker)
      const foes = ours ? this.monstersStanding : this.partyStanding
      if (foes.length === 0) break
      // Helpless foes are finished off first; otherwise anyone.
      const easy = foes.filter(helpless)
      const target = (easy.length > 0 ? easy : foes)[this.random((easy.length > 0 ? easy : foes).length - 1)]!
      const attacks = Math.max(1, Math.round(attacker.member.character.attacks.count / 2))
      for (let i = 0; i < attacks && standing(target); i++) {
        const roll = this.random(19) + 1 + (ours ? this.partyHitBonus : 0)
        const defender = { ...target.member.character, ac: target.member.character.ac - (this.acBonus.get(target.member.character) ?? 0) }
        if (!helpless(target) && !hits(attacker.member.character, defender, roll)) {
          lines.push(`${attacker.label} MISSES ${target.label}.`)
          continue
        }
        const damage = rollDamage(attacker.member.character, this.random) * (helpless(target) ? 2 : 1)
        const left = target.member.character.hpCurrent - damage
        if (left > 0) {
          target.member.character.hpCurrent = left
          this.wake(target)
          lines.push(`${attacker.label} HITS ${target.label} FOR ${damage}.`)
        } else {
          down(target, -left)
          lines.push(`${attacker.label} HITS ${target.label} FOR ${damage}. ${target.label} IS ${target.member.character.status.toUpperCase()}!`)
        }
      }
    }
    this.acted.clear()
    this.log.push(...lines)
    return lines
  }

  /** Experience for the monsters that fell, split across the party members still up. */
  experience(): number {
    return this.monsters
      .filter((m) => !standing(m))
      .reduce((total, m) => total + m.member.character.experience, 0)
  }

  /** Clears what a fight did to the party: sleepers wake, the held are let go. */
  finish(): void {
    for (const c of this.party) {
      if (helpless(c)) c.member.character.status = 'okay'
    }
  }
}

/** Labels a group of monsters "ORC", "ORC 2", "ORC 3", so the log reads. */
export function labelMonsters(groups: readonly { member: Member; count: number }[]): Combatant[] {
  const combatants: Combatant[] = []
  const seen = new Map<string, number>()
  for (const group of groups) {
    for (let i = 0; i < group.count; i++) {
      const name = group.member.character.name
      const n = (seen.get(name) ?? 0) + 1
      seen.set(name, n)
      const label = n === 1 ? name : `${name} ${n}`
      // Each copy is its own character, named by its label so spell logs can tell them apart.
      const character = { ...group.member.character, name: label, money: [...group.member.character.money], levels: [...group.member.character.levels], memorised: [], prepared: [] }
      combatants.push({ member: { character, items: group.member.items }, label })
    }
  }
  return combatants
}
