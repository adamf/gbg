import { describe, expect, it } from 'vitest'

import { CHARACTER_RECORD_SIZE, readCharacter } from '../src/formats/character.js'
import { Combat, hits, labelMonsters, rollDamage } from '../src/engine/combat.js'

function fighter(name: string, hp: number, ac: number, thac0: number, dice: [number, number, number], exp = 0): ReturnType<typeof readCharacter> {
  const data = new Uint8Array(CHARACTER_RECORD_SIZE)
  data[0] = name.length
  for (let i = 0; i < name.length; i++) data[1 + i] = name.charCodeAt(i)
  data[0x2d] = 60 - thac0
  data[0x2e] = name === 'ORC' ? 0 : 7
  data[0x32] = hp
  data[0x11b] = hp
  data[0x111] = 60 - ac
  data[0xa1] = 2
  data[0x115] = dice[0]
  data[0x117] = dice[1]
  data[0x119] = dice[2]
  data[0x11c] = 9
  data[0xac] = exp
  return readCharacter(data)
}

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
    expect(combat.experience()).toBe(30)
    expect(party[0]!.member.character.hpCurrent).toBeLessThan(12)
    expect(monsters.every((m) => m.member.character.status === 'dead')).toBe(true)
  })

  it('leaves a beaten party unconscious rather than dead', () => {
    const party = [{ member: { character: fighter('HERO', 3, 10, 20, [1, 1, 0]), items: [] }, label: 'HERO' }]
    const monsters = labelMonsters([{ member: { character: fighter('OGRE', 30, 5, 15, [1, 4, 0]), items: [] }, count: 1 }])
    const combat = new Combat(party, monsters, (max) => (max === 19 ? 18 : Math.min(3, max)))
    while (!combat.over) combat.next()
    expect(party[0]!.member.character.status).toBe('unconscious')
    expect(combat.partyStanding.length).toBe(0)
  })
})
