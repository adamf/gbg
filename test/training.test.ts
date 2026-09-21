import { describe, expect, it } from 'vitest'

import { CHARACTER_RECORD_SIZE, readCharacter } from '../src/formats/character.js'
import { nextLevelAt, readyToTrain, spellSlotsFor, tracksInMask, train } from '../src/engine/training.js'

function character(levels: number[], experience: number, stats: { con?: number; wis?: number } = {}) {
  const data = new Uint8Array(CHARACTER_RECORD_SIZE)
  levels.forEach((l, i) => { data[0x96 + i] = l })
  data[0xac] = experience & 0xff
  data[0xad] = (experience >> 8) & 0xff
  data[0x14] = stats.con ?? 10
  data[0x12] = stats.wis ?? 10
  data[0x32] = 10
  data[0x11b] = 10
  data[0x2d] = 60 - 20
  data[0x110] = 40
  return readCharacter(data)
}

describe('training', () => {
  it('reads the halls’ masks as the classes they teach', () => {
    expect(tracksInMask(114)).toEqual(['cleric', 'paladin', 'ranger', 'druid'])
    expect(tracksInMask(113)).toContain('magic-user')
    expect(tracksInMask(120)).toContain('fighter')
    expect(tracksInMask(116)).toContain('thief')
  })

  it('offers a level only with the experience for it, split across classes', () => {
    expect(nextLevelAt('fighter', 1)).toBe(2000)
    const fighter = character([0, 0, 1], 2000)
    expect(readyToTrain(fighter, 120)).toEqual(['fighter'])
    expect(readyToTrain(fighter, 113)).toEqual([])
    const multi = character([1, 0, 1, 0, 0, 1], 3000) // 1000 each: not enough for any
    expect(readyToTrain(multi, 0x7f)).toEqual([])
    multi.experience = 7500 // 2500 each: magic-user and fighter, not cleric (1500 needs... yes cleric too)
    expect(readyToTrain(multi, 0x7f).sort()).toEqual(['cleric', 'fighter', 'magic-user'])
  })

  it('raises a level with a hit die, a better to-hit on schedule, and new slots', () => {
    const fighter = character([0, 0, 1], 2000, { con: 17 })
    const first = train(fighter, 'fighter', () => 9) // rolls the 10
    expect(first).toEqual({ track: 'fighter', level: 2, hitPoints: 13 })
    expect(fighter.hpMax).toBe(23)
    expect(fighter.thac0).toBe(20)
    train(fighter, 'fighter', () => 0)
    expect(fighter.levels[2]).toBe(3)
    expect(fighter.thac0).toBe(18)
    expect(fighter.hitBonusRaw).toBe(42)

    const cleric = character([1], 1500, { wis: 17 })
    expect(spellSlotsFor(cleric)).toEqual([3, 0, 0, 0, 0, 0])
    train(cleric, 'cleric', () => 3)
    expect(cleric.spellSlots).toEqual([4, 0, 0, 0, 0, 0])
    train(cleric, 'cleric', () => 3)
    expect(cleric.spellSlots).toEqual([4, 3, 0, 0, 0, 0])
  })
})

describe('race limits', () => {
  it('stops a dwarf fighter at ninth and lets a human go on', async () => {
    const { levelLimit } = await import('../src/engine/training.js')
    expect(levelLimit(1, 'fighter')).toBe(9)
    expect(levelLimit(1, 'magic-user')).toBe(0)
    expect(levelLimit(2, 'magic-user')).toBe(11)
    expect(levelLimit(7, 'fighter')).toBe(99)
  })
})
