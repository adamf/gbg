import { describe, expect, it } from 'vitest'

import { CLASSES } from '../src/formats/character.js'
import { createCharacter, qualifies, rollStats, tracksOf, CLASSES_BY_RACE } from '../src/engine/create.js'

describe('creating a character', () => {
  it('rolls three dice with the race’s adjustments', () => {
    const stats = rollStats('dwarf', () => 2) // every die a 3
    expect(stats).toEqual({ str: 9, int: 9, wis: 9, dex: 9, con: 10, cha: 8 })
  })

  it('knows which classes need what', () => {
    const weak = { str: 8, int: 9, wis: 9, dex: 9, con: 9, cha: 9 }
    expect(qualifies(CLASSES.indexOf('fighter'), weak)).toBe(false)
    expect(qualifies(CLASSES.indexOf('magic-user'), weak)).toBe(true)
    expect(tracksOf(CLASSES.indexOf('fighter/magic-user/thief'))).toEqual([2, 5, 6])
    expect(CLASSES_BY_RACE.dwarf).not.toContain(CLASSES.indexOf('magic-user'))
  })

  it('makes a first-level fighter with a full hit die, the fighter saves and coin', () => {
    const c = createCharacter({ name: 'grimwald', race: 'human', classIndex: CLASSES.indexOf('fighter'), sex: 0, alignment: 0, stats: { str: 17, int: 10, wis: 10, dex: 12, con: 16, cha: 10 } }, () => 4)
    expect(c.name).toBe('GRIMWALD')
    expect(c.levels[2]).toBe(1)
    expect(c.hpMax).toBe(12)
    expect(c.savingThrows).toEqual([14, 15, 16, 17, 17])
    expect(c.money[3]).toBe(150)
    expect(c.spellbook).toEqual([])
    expect(c.icon).toBe(1)
  })

  it('gives a cleric/magic-user both books and slots', () => {
    const c = createCharacter({ name: 'x', race: 'half-elf', classIndex: CLASSES.indexOf('cleric/magic-user'), sex: 1, alignment: 3, stats: { str: 10, int: 15, wis: 17, dex: 10, con: 10, cha: 10 } }, () => 0)
    expect(c.spellbook.slice(0, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(c.spellbook).toContain(18)
    expect(c.spellbook.length).toBe(12)
    expect(c.spellSlots).toEqual([3, 0, 0, 1, 0, 0])
    expect(c.hpMax).toBe(8)
  })
})
