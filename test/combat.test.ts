import * as combatModule from '../src/engine/combat.js'
import { describe, expect, it } from 'vitest'

import { CHARACTER_RECORD_SIZE, readCharacter } from '../src/formats/character.js'
import { Combat, hits, labelMonsters, rollDamage } from '../src/engine/combat.js'

function fighter(name: string, hp: number, ac: number, thac0: number, dice: [number, number, number], exp = 0): ReturnType<typeof readCharacter> {
  const data = new Uint8Array(CHARACTER_RECORD_SIZE)
  data[0] = name.length
  for (let i = 0; i < name.length; i++) data[1 + i] = name.charCodeAt(i)
  data[0x2d] = 60 - thac0
  data[0x2e] = name === 'ORC' || name === 'TROLL' ? 0 : 7
  data[0x32] = hp
  data[0x11b] = hp
  data[0x111] = 60 - ac
  data[0xa1] = 2
  data[0x115] = dice[0]
  data[0x117] = dice[1]
  data[0x119] = dice[2]
  data[0x11c] = 9
  // Monsters are priced as a base value plus so much per hit point rolled.
  data[0xb8] = exp
  data[0xb1] = hp
  data[0xba] = exp ? 1 : 0
  return readCharacter(data)
}

describe('helplessness', () => {
  it('wears off when nobody on either side can act, and after ten rounds regardless', () => {
    const party = [{ member: { character: fighter('HERO', 12, 2, 20, [1, 8, 2]), items: [] }, label: 'HERO' }]
    const monsters = labelMonsters([{ member: { character: fighter('ORC', 5, 6, 19, [1, 8, 0], 15), items: [] }, count: 1 }])
    const combat = new Combat(party, monsters, () => 0)
    party[0]!.member.character.status = 'asleep'
    monsters[0]!.member.character.status = 'held'
    combat.stir()
    expect(party[0]!.member.character.status).toBe('okay')
    expect(monsters[0]!.member.character.status).toBe('okay')

    monsters[0]!.member.character.status = 'held'
    combat.round = 1
    combat.stir()
    expect(monsters[0]!.member.character.status).toBe('held')
    combat.round = 11
    combat.stir()
    expect(monsters[0]!.member.character.status).toBe('okay')
  })
})

describe('to-hit and damage', () => {
  it('needs THAC0 minus AC on the die, and a 20 always lands', () => {
    const a = fighter('A', 10, 10, 20, [1, 6, 0])
    const d = fighter('D', 10, 4, 20, [1, 6, 0])
    expect(hits(a, d, 15)).toBe(false)
    expect(hits(a, d, 16)).toBe(true)
    expect(hits(a, fighter('X', 1, -5, 20, [1, 1, 0]), 20)).toBe(true)
  })

  it('rolls the current attack dice plus bonus', () => {
    const a = fighter('A', 10, 10, 20, [2, 6, 1])
    expect(rollDamage(a, () => 5)).toBe(13)
    expect(rollDamage(a, () => 0)).toBe(3)
  })

  it('judges a blow by hit dice when the record carries no dice', () => {
    // Quicklings ship with 65d68 in the damage bytes and a medusa with 0d0.
    const letters = fighter('Q', 10, 10, 20, [65, 68, 0])
    letters.hitDice = 1
    expect(rollDamage(letters, () => 3)).toBe(4)
    const wild = fighter('B', 10, 10, 20, [1, 8, 102])
    expect(rollDamage(wild, () => 3)).toBe(4)
    const nothing = fighter('M', 10, 10, 20, [0, 0, 0])
    nothing.hitDice = 6
    expect(rollDamage(nothing, () => 7)).toBe(8)
  })

  it('knows the monsters the rules single out by name', async () => {
    const { monsterKind } = await import('../src/engine/combat.js')
    const named = (name: string) => monsterKind(fighter(name, 10, 10, 20, [1, 6, 0]))
    expect(named('MEDUSA')).toBe('petrifier')
    expect(named('BASILISK')).toBe('petrifier')
    expect(named('DRIDER')).toBe('poisoner')
    expect(named('THRI-KREEN')).toBe('poisoner')
    expect(named('WIGHT')).toBe('drainer')
    expect(named('ORC LEADER')).toBe('plain')
  })
})

describe('a fight', () => {
  it('runs until one side is down and pays experience for the fallen', () => {
    const party = [{ member: { character: fighter('HERO', 12, 2, 20, [1, 8, 2]), items: [] }, label: 'HERO' }]
    const monsters = labelMonsters([{ member: { character: fighter('ORC', 5, 6, 19, [1, 8, 0], 15), items: [] }, count: 2 }])
    expect(monsters.map((m) => m.label)).toEqual(['ORC', 'ORC 2'])

    // Every d20 comes up 19: everybody hits; damage dice come up 3.
    const combat = new Combat(party, monsters, (max) => (max === 19 ? 18 : Math.min(2, max)))
    const first = combat.next()
    expect(first.length).toBeGreaterThan(0)
    let rounds = 1
    while (!combat.over && rounds < 20) {
      combat.next()
      rounds++
    }
    expect(combat.over).toBe(true)
    expect(combat.monstersStanding.length).toBe(0)
    expect(combat.experience()).toBe(40)
    expect(party[0]!.member.character.hpCurrent).toBeLessThan(12)
    expect(monsters.every((m) => m.member.character.status === 'dead')).toBe(true)
  })

  it('leaves a beaten party unconscious rather than dead', () => {
    const party = [{ member: { character: fighter('HERO', 3, 10, 20, [1, 1, 0]), items: [] }, label: 'HERO' }]
    const monsters = labelMonsters([{ member: { character: fighter('OGRE', 30, 5, 15, [1, 4, 0]), items: [] }, count: 1 }])
    const combat = new Combat(party, monsters, (max) => (max === 19 ? 18 : Math.min(3, max)))
    while (!combat.over) combat.next()
    expect(['unconscious', 'dying']).toContain(party[0]!.member.character.status)
    expect(combat.partyStanding.length).toBe(0)
  })
})

describe('taking damage', () => {
  const { takeDamage, monsterKind } = combatModule
  it('knocks a character out at zero, leaves them dying below it, and kills at minus ten', () => {
    const hero = fighter('HERO', 5, 2, 20, [1, 8, 0])
    expect(takeDamage(hero, 3)).toBe('hurt')
    expect(hero.hpCurrent).toBe(2)
    expect(takeDamage(hero, 2)).toBe('unconscious')
    const other = fighter('OTHER', 5, 2, 20, [1, 8, 0])
    expect(takeDamage(other, 8)).toBe('dying')
    expect(other.hpCurrent).toBe(-3)
    expect(takeDamage(fighter('THIRD', 5, 2, 20, [1, 8, 0]), 15)).toBe('dead')
  })

  it('kills a monster at zero, but only downs a troll unless it was burnt', () => {
    expect(takeDamage(fighter('ORC', 5, 6, 19, [1, 8, 0]), 5)).toBe('dead')
    const troll = fighter('TROLL', 20, 4, 15, [1, 8, 0])
    expect(monsterKind(troll)).toBe('troll')
    expect(takeDamage(troll, 25)).toBe('unconscious')
    expect(troll.status).toBe('unconscious')
    const burnt = fighter('TROLL', 20, 4, 15, [1, 8, 0])
    expect(takeDamage(burnt, 25, true)).toBe('dead')
  })
})
