/**
 * The party: who is in it, how hurt they are, and what the scripts may ask of them.
 *
 * This is the character side of the rules the scripts lean on — damage with saving
 * throws, the party's strength and movement, coins — and the view of the selected
 * character that the interpreter maps in at 0x6B00. Combat itself is not here yet.
 */

import { CLASS_TRACKS, type Character, type Item, type Status } from '../formats/character.js'
import type { CharacterHook, DamageSpec, Treasure } from './ecl-vm.js'

export interface Member {
  character: Character
  items: Item[]
}

const ACTIVE: readonly Status[] = ['okay', 'animated', 'running']

/** Charisma to the reaction score the scripts compare against, as the original tabulated it. */
function charismaScore(cha: number): number {
  if (cha <= 3) return 0
  if (cha <= 7) return (cha - 3) * 5
  if (cha <= 12) return 25
  if (cha <= 17) return [30, 35, 40, 50, 55][cha - 13]!
  return 60
}

export class Roster {
  members: Member[] = []
  selected = 0

  get active(): Member[] {
    return this.members.filter((m) => ACTIVE.includes(m.character.status))
  }

  get current(): Member | undefined {
    return this.members[this.selected]
  }

  /** The original's measure of how dangerous the party looks. */
  strength(): number {
    let power = 0
    for (const { character: c } of this.members) {
      const cleric = c.levels[CLASS_TRACKS.indexOf('cleric')] ?? 0
      const magic = c.levels[CLASS_TRACKS.indexOf('magic-user')] ?? 0
      const armour = Math.max(0, (60 - c.ac) - 60)
      const hitBonus = Math.max(0, c.hitBonusRaw - 39)
      power += Math.floor((cleric * 4 + c.hpCurrent + armour * 5 + hitBonus * 5 + magic * 8) / 10)
    }
    return power & 0xff
  }

  movement(): { min: number; max: number } {
    const moves = this.active.map((m) => m.character.movement)
    if (moves.length === 0) return { min: 12, max: 12 }
    return { min: Math.min(...moves), max: Math.max(...moves) }
  }

  /** Takes hit points off a member, knocking them out at zero and killing them well past it. */
  hurt(member: Member, amount: number): void {
    const c = member.character
    const left = c.hpCurrent - amount
    if (left > 0) {
      c.hpCurrent = left
      return
    }
    c.hpCurrent = 0
    c.status = left <= -10 ? 'dead' : 'unconscious'
    c.statusByte = c.status === 'dead' ? 6 : 4
  }

  /**
   * The DAMAGE command. The flags say who is hit and whether a saving throw avoids
   * it; the kind picks which save. Returns a line per person hurt.
   */
  applyDamage(spec: DamageSpec, random: (max: number) => number): string[] {
    const roll = (): number => {
      let total = spec.bonus
      for (let i = 0; i < spec.dice; i++) total += random(Math.max(1, spec.sides) - 1) + 1
      return Math.max(0, total)
    }
    const lines: string[] = []
    const active = this.active
    if (active.length === 0) return lines

    const saveKind = spec.kind & 7
    const saveBonus = spec.flags & 0x1f
    const saves = (member: Member): boolean => {
      if (saveKind === 0 || saveKind > 5) return false
      const needed = member.character.savingThrows[saveKind - 1] ?? 20
      return random(19) + 1 + saveBonus >= needed
    }
    const hit = (member: Member, withSave: boolean): void => {
      if (withSave && saves(member)) {
        lines.push(`${member.character.name} RESISTS.`)
        return
      }
      const amount = roll()
      this.hurt(member, amount)
      lines.push(`${member.character.name} TAKES ${amount} DAMAGE${member.character.status === 'okay' ? '' : ` AND IS ${member.character.status.toUpperCase()}`}.`)
    }
    const pick = (): Member => active[random(active.length - 1)]!

    if ((spec.flags & 0x80) === 0) {
      for (let i = 0; i < Math.max(1, spec.flags); i++) hit(pick(), false)
    } else if (spec.flags & 0x40) {
      for (const member of active) hit(member, (spec.flags & 0x30) === 0)
    } else if (spec.kind & 0x80) {
      const member = this.current ?? pick()
      hit(member, saveKind !== 0 && (spec.flags & 0x10) === 0)
    } else {
      hit(pick(), (spec.flags & 0x10) === 0)
    }
    return lines
  }

  /** Coins go to whoever is first on the list; the original pooled them and asked. */
  addTreasure(treasure: Treasure): void {
    const first = this.active[0] ?? this.members[0]
    if (!first) return
    const money = first.character.money
    const add = [treasure.copper, treasure.silver, treasure.electrum, treasure.gold, treasure.platinum, treasure.gems, treasure.jewellery]
    for (let i = 0; i < add.length; i++) money[i] = (money[i] ?? 0) + add[i]!
  }

  /** Thieves at work: keep a share of the coins, and each item may go. */
  rob(members: readonly Member[], keepPercent: number, itemChance: number, random: (max: number) => number): string[] {
    const lines: string[] = []
    for (const member of members) {
      const money = member.character.money
      let lost = 0
      for (let i = 0; i < money.length; i++) {
        const keep = Math.floor((money[i] ?? 0) * keepPercent / 100)
        lost += (money[i] ?? 0) - keep
        money[i] = keep
      }
      const gone = member.items.filter(() => random(99) < itemChance)
      member.items = member.items.filter((item) => !gone.includes(item))
      if (lost > 0 || gone.length > 0) lines.push(`${member.character.name} IS ROBBED OF ${lost > 0 ? `${lost} COINS` : ''}${lost > 0 && gone.length > 0 ? ' AND ' : ''}${gone.length > 0 ? `${gone.length} ITEM${gone.length === 1 ? '' : 'S'}` : ''}.`)
    }
    return lines
  }

  /** Who has a spell ready, as the SPELL command asks. */
  spellHolder(spellId: number): { player: number; index: number } | undefined {
    for (const [player, member] of this.members.entries()) {
      const index = member.character.memorised.indexOf(spellId)
      if (index >= 0) return { player, index: index + 1 }
    }
    return undefined
  }

  /** CHECK PARTY: the least, greatest and average of a number across the party. */
  checkParty(kind: 'movement' | 'skill' | 'affect', which: number): [number, number, number, number] {
    if (kind === 'affect' || this.members.length === 0) return [0, 0, 0, 0]
    const values = this.members.map((m) => (kind === 'movement' ? m.character.movement : m.character.thiefSkills[which] ?? 0))
    const avg = Math.floor(values.reduce((a, b) => a + b, 0) / values.length)
    return [0, avg, Math.max(...values), Math.min(...values)]
  }

  /** The selected character as the scripts see them at 0x6B00. */
  hook(): CharacterHook {
    const roster = this
    return {
      select(index) { roster.selected = index },
      name() { return roster.current?.character.name ?? '' },
      read(offset) {
        const c = roster.current?.character
        switch (offset) {
          case 0x100: return c ? (ACTIVE.includes(c.status) ? 1 : 0x80) : 0
          case 0x10c: return 0
          case 0x2b1: case 0x2b4: return roster.selected
          case 0x312: return undefined
          case 0x33e: return roster.members.length
        }
        if (!c) return undefined
        switch (offset) {
          case 0x15: return c.stats.int
          case 0x18: return c.stats.con
          case 0x72: return c.race
          case 0x73: return c.class
          case 0x9b: return c.savingThrows[1]
          case 0xa0: return c.hitDice
          case 0xb8: return c.control
          case 0xbb: return c.money[0]
          case 0xbd: return c.money[2]
          case 0xbf: return c.money[1]
          case 0xc1: return c.money[3]
          case 0xc3: return c.money[4]
          case 0xc9: return c.levels[CLASS_TRACKS.indexOf('magic-user')]
          case 0xd6: return c.sex
          case 0xd8: return c.alignment
          case 0x11b: return c.movement
          case 0x2cf: return charismaScore(c.stats.cha)
        }
        if (offset >= 0xa5 && offset <= 0xac) return c.thiefSkills[offset - 0xa5]
        return undefined
      },
      write(offset, value) {
        const c = roster.current?.character
        if (!c) return false
        const coin: Record<number, number> = { 0xbb: 0, 0xbd: 2, 0xbf: 1, 0xc1: 3, 0xc3: 4 }
        if (offset in coin) {
          c.money[coin[offset]!] = value
          return true
        }
        switch (offset) {
          case 0xb8:
            c.control = value > 0xb2 ? value - 0x32 : value
            return true
          case 0x100:
            if (value === 0x87) {
              c.status = 'stoned'
              c.statusByte = 7
            }
            return true
          case 0x10c:
            return true
        }
        return false
      },
    }
  }
}
