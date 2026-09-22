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
import type { AffectKind } from '../formats/spells.js'
import type { Rgba } from '../formats/ega.js'
import type { Member } from './roster.js'

export interface Combatant {
  member: Member
  /** Monsters carry their group's number so the log can tell two orcs apart. */
  label: string
  /** The combat icon, when the art could be found. */
  icon?: Rgba
  /** The swing: the icon's action pose. */
  actionIcon?: Rgba
  /** For monsters: the CPIC block their icon is in. */
  picture?: number
}

export type Random = (max: number) => number

export interface Affect {
  kind: AffectKind
  amount: number
  rounds: number
}

/** Whether an attacker's roll lands on a defender: THAC0 minus AC, on a d20. */
/**
 * The manual's rule: a d20 at or above THAC0 less the target's armour class hits.
 * The record's to-hit byte at 0x110 is where the game kept the working number:
 * strength, the weapon's plus and every level trained are already in it.
 */
export function hits(attacker: Character, defender: Character, roll: number): boolean {
  const raw = attacker.hitBonusRaw
  // 60 - byte is the THAC0 the record actually fights with (orc leader 16 and 44,
  // ogre 15 and 45); the high bit means something else and the byte is then ignored.
  const effective = raw && !(raw & 0x80) ? 60 - raw : attacker.thac0
  const needed = effective - defender.ac
  return roll >= needed || roll === 20
}

/**
 * The record's dice, unless they are not dice: a few shipped monsters (quicklings,
 * bandits, a medusa) carry letters or nothing there, and then the blow is judged
 * by hit dice the way the rules would.
 */
export function damageDice(attacker: Character): { dice: number; sides: number; bonus: number } {
  const { dice, sides, bonus } = attacker.attacks
  const plausible = dice >= 1 && dice <= 20 && sides >= 1 && sides <= 30
  if (plausible) return { dice, sides, bonus }
  const hd = attacker.hitDice
  return { dice: 1, sides: hd <= 2 ? 4 : hd <= 5 ? 6 : hd <= 8 ? 8 : 10, bonus: 0 }
}

export function rollDamage(attacker: Character, random: Random): number {
  const { dice, sides, bonus } = damageDice(attacker)
  let total = bonus
  for (let i = 0; i < dice; i++) total += random(sides - 1) + 1
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

/** A downed troll is still in the fight: it can be finished, and it can get up. */
function lying(c: Combatant): boolean {
  const character = c.member.character
  return character.race === 0 && character.status === 'unconscious'
}

/** Anyone a blow can land on: the standing, and a troll lying regenerating. */
export function targetable(c: Combatant): boolean {
  return standing(c) || lying(c)
}

function helpless(c: Combatant): boolean {
  const s = c.member.character.status
  return s === 'asleep' || s === 'held'
}

/** Rolls a d20 against one of the five saving throws; index 0 is paralysis, poison and death. */
export function saves(character: Character, index: number, random: Random): boolean {
  const need = character.savingThrows[index] ?? 20
  return random(19) + 1 >= need
}

/** What a monster is, by its name: the kinds the rules single out. */
export function monsterKind(character: Character): 'troll' | 'ghoul' | 'poisoner' | 'drainer' | 'petrifier' | 'plain' {
  const name = character.name.toUpperCase()
  if (name.includes('TROLL')) return 'troll'
  if (/GHOUL|GHAST/.test(name)) return 'ghoul'
  if (/SPIDER|CENTIPEDE|SNAKE|SCORPION|WYVERN|NAGA|ASSASSIN|COBRA|VIPER|DRIDER|THRI-KREEN/.test(name)) return 'poisoner'
  if (/WIGHT|WRAITH|SPECTRE|VAMPIRE/.test(name)) return 'drainer'
  if (/MEDUSA|BASILISK/.test(name)) return 'petrifier'
  return 'plain'
}

/**
 * Hit points come off. At exactly zero a character is unconscious; below it they
 * are dying and bleed a point a round until minus ten, which is death (the manual's
 * rule; a round to bandage them stops it). Monsters die at zero, and so does anyone
 * helpless. A downed troll is only unconscious unless fire did it, and gets up
 * again unless somebody stands on it — see Battle.
 */
export function takeDamage(character: Character, amount: number, fire = false): 'hurt' | 'unconscious' | 'dying' | 'dead' {
  const helpless = character.status === 'asleep' || character.status === 'held'
  const left = character.hpCurrent - amount
  if (fire) character.burnt = true
  if (left > 0) {
    character.hpCurrent = left
    if (character.status === 'asleep') character.status = 'okay'
    return 'hurt'
  }
  const troll = character.race === 0 && monsterKind(character) === 'troll' && !character.burnt
  if (character.race === 0 && !troll) {
    character.hpCurrent = 0
    character.status = 'dead'
    character.statusByte = 6
    return 'dead'
  }
  if (troll) {
    // Lying already: a blow now is the end of it.
    if (character.status === 'unconscious') { character.hpCurrent = 0; character.status = 'dead'; character.statusByte = 6; return 'dead' }
    character.hpCurrent = Math.max(left, -9)
    character.status = 'unconscious'
    character.statusByte = 4
    return 'unconscious'
  }
  if (left <= -10 || helpless) {
    character.hpCurrent = 0
    character.status = 'dead'
    character.statusByte = 6
    return 'dead'
  }
  character.hpCurrent = left
  character.status = left === 0 ? 'unconscious' : 'dying'
  character.statusByte = left === 0 ? 4 : 5
  return character.status
}


export class Combat {
  round = 0
  readonly log: string[] = []
  /** What lasts on a character this fight: blessings, shields, haste, silence, each with rounds to run. */
  private readonly affects = new Map<Character, Affect[]>()
  /** Who has already acted this round — casters, mostly. */
  readonly acted = new Set<Character>()
  private readonly helplessSince = new Map<Character, number>()
  /** How long a sleep or a hold lasts on someone, in rounds; ten when nothing says. */
  private readonly helplessFor = new Map<Character, number>()

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
    return this.party.filter(alive).length === 0 || this.monsters.filter(targetable).length === 0
  }

  // ---- lasting effects --------------------------------------------------------

  affect(character: Character, kind: AffectKind, amount: number, rounds: number): void {
    const list = this.affects.get(character) ?? []
    list.push({ kind, amount, rounds })
    this.affects.set(character, list)
  }

  affectsOn(character: Character): readonly Affect[] {
    return this.affects.get(character) ?? []
  }

  has(character: Character, kind: AffectKind): boolean {
    return this.affectsOn(character).some((a) => a.kind === kind)
  }

  private sum(character: Character, kind: AffectKind): number {
    return this.affectsOn(character).reduce((n, a) => (a.kind === kind ? n + a.amount : n), 0)
  }

  /** Strips every magical effect from a character: dispel magic. */
  dispel(character: Character): number {
    const had = this.affectsOn(character).length
    this.affects.delete(character)
    return had
  }

  /** A round passes: every effect runs down, the spent ones fall off. */
  private tick(): void {
    for (const [character, list] of this.affects) {
      const left = list.map((a) => ({ ...a, rounds: a.rounds - 1 })).filter((a) => a.rounds > 0)
      if (left.length > 0) this.affects.set(character, left)
      else this.affects.delete(character)
    }
  }

  /** The old side-wide blessing and curse, kept for the callers that have them. */
  bless(bonus: number, rounds = 6): void {
    for (const c of this.party) this.affect(c.member.character, 'hit', bonus, rounds)
  }

  curse(penalty: number, rounds = 6): void {
    for (const c of this.monsters) this.affect(c.member.character, 'hit', -penalty, rounds)
  }

  shield(character: Character, bonus: number, rounds = 99): void {
    this.affect(character, 'ac', bonus, rounds)
  }

  /** What a side adds to its d20: kept for old callers, always the character's own now. */
  hitModifier(_ours: boolean): number {
    return 0
  }

  /** A character's to-hit bonus this fight, from blessings and curses. */
  hitBonusOf(character: Character): number {
    return this.sum(character, 'hit')
  }

  /** A character's armour class as it stands in this fight, protections counted. */
  acOf(character: Character): number {
    return character.ac - this.sum(character, 'ac')
  }

  damageBonusOf(character: Character): number {
    return this.sum(character, 'damage')
  }

  /** Attacks this round: the record's, doubled by haste, halved by slow. */
  attacksOf(character: Character): number {
    let count = Math.max(1, Math.round(character.attacks.count / 2))
    if (this.has(character, 'haste')) count *= 2
    if (this.has(character, 'slow')) count = Math.max(1, Math.floor(count / 2))
    return count
  }

  /** Sleep and hold with a set length: the stir below honours it. */
  helplessRounds(character: Character, rounds: number): void {
    this.helplessFor.set(character, rounds)
    this.helplessSince.set(character, this.round)
  }

  /** A spell dropped someone; nothing more to do, the status says it. */
  fell(_character: Character): void {}


  /**
   * Sleep and paralysis wear off: after ten rounds, or at once when nobody on either
   * side is left able to act, so a fight cannot stall with everyone lying down.
   */
  stir(): void {
    this.tick()
    const all = [...this.party, ...this.monsters]
    const nobody = !all.some((c) => alive(c) && !helpless(c))
    for (const c of all) {
      const character = c.member.character
      if (!helpless(c)) { this.helplessSince.delete(character); continue }
      const since = this.helplessSince.get(character) ?? this.round
      this.helplessSince.set(character, since)
      if (nobody || this.round - since >= (this.helplessFor.get(character) ?? 10)) {
        character.status = 'okay'
        this.helplessSince.delete(character)
        this.helplessFor.delete(character)
      }
    }
  }

  /** Everyone acts once, in a random order that favours the quick. */
  next(): string[] {
    this.round++
    this.stir()
    const lines: string[] = []
    const order = [...this.party.filter(alive), ...this.monsters.filter(alive)]
      .map((c) => ({ c, initiative: this.random(9) + Math.floor(c.member.character.movement / 3) }))
      .sort((a, b) => b.initiative - a.initiative)
      .map((x) => x.c)

    for (const attacker of order) {
      if (!alive(attacker) || this.acted.has(attacker.member.character)) continue
      const ours = this.party.includes(attacker)
      const foes = ours ? (this.monstersStanding.length > 0 ? this.monstersStanding : this.monsters.filter(targetable)) : this.partyStanding
      if (foes.length === 0) break
      // Helpless foes are finished off first; otherwise anyone.
      const easy = foes.filter(helpless)
      const target = (easy.length > 0 ? easy : foes)[this.random((easy.length > 0 ? easy : foes).length - 1)]!
      const attacks = this.attacksOf(attacker.member.character)
      for (let i = 0; i < attacks && targetable(target); i++) {
        const roll = this.random(19) + 1 + this.hitBonusOf(attacker.member.character)
        const defender = { ...target.member.character, ac: this.acOf(target.member.character) }
        if (!helpless(target) && !hits(attacker.member.character, defender, roll)) {
          lines.push(`${attacker.label} MISSES ${target.label}.`)
          continue
        }
        const damage = Math.max(1, rollDamage(attacker.member.character, this.random) + this.damageBonusOf(attacker.member.character)) * (helpless(target) ? 2 : 1)
        const result = takeDamage(target.member.character, damage)
        lines.push(`${attacker.label} HITS ${target.label} FOR ${damage}.${result === 'hurt' ? '' : ` ${target.label} IS ${result.toUpperCase()}!`}`)
      }
    }
    this.acted.clear()
    if (this.log.length < 2000) this.log.push(...lines)
    return lines
  }

  /**
   * Experience for the monsters that fell, the way the original priced them: a base
   * value plus so much per hit point rolled. (coab `calc_battle_exp`.)
   */
  experience(): number {
    return this.monsters
      .filter((m) => !standing(m) && m.member.character.status !== 'running')
      .reduce((total, m) => {
        const c = m.member.character
        return total + c.experienceBase + c.experiencePerHp * c.hpRolled
      }, 0)
  }

  /**
   * Clears what a fight did to the party: sleepers wake, the held are let go, those
   * who ran come back, and the dying are bandaged now that there is time.
   */
  finish(): void {
    for (const c of this.party) {
      const character = c.member.character
      if (helpless(c) || character.status === 'running') { character.status = 'okay'; character.statusByte = 0 }
      if (character.status === 'dying') { character.status = 'unconscious'; character.statusByte = 4; character.hpCurrent = 0 }
    }
    // A troll left lying is dead once the party walks away.
    for (const m of this.monsters) {
      if (m.member.character.status === 'unconscious') { m.member.character.status = 'dead'; m.member.character.statusByte = 6; m.member.character.hpCurrent = 0 }
    }
  }
}

/** Labels a group of monsters "ORC", "ORC 2", "ORC 3", so the log reads. */
export function labelMonsters(groups: readonly { member: Member; count: number; picture?: number }[]): Combatant[] {
  const combatants: Combatant[] = []
  const seen = new Map<string, number>()
  for (const group of groups) {
    for (let i = 0; i < group.count; i++) {
      const name = group.member.character.name
      const n = (seen.get(name) ?? 0) + 1
      seen.set(name, n)
      const label = n === 1 ? name : `${name} ${n}`
      // Each copy is its own character, named by its label so spell logs can tell them apart.
      const character = { ...group.member.character, name: label, money: [...group.member.character.money], levels: [...group.member.character.levels], memorised: [...group.member.character.memorised], prepared: [...group.member.character.prepared], attacks: { ...group.member.character.attacks } }
      combatants.push({ member: { character, items: group.member.items }, label, picture: group.picture })
    }
  }
  return combatants
}
