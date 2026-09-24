import { describe, expect, it } from 'vitest'

import { CLASSES } from '../src/formats/character.js'
import { alignmentsFor, createCharacter, limits, maxHitPoints, minHitPoints, modify, rollAge, rollDraft, rollHitPoints, rollStats, tracksOf, CLASSES_BY_RACE, type Draft } from '../src/engine/create.js'

/** A die sequence: each call returns the next value, as random(n) does (0..n). */
const sequence = (values: number[]) => { let i = 0; return (_n: number) => values[i++ % values.length]! }

describe('creating a character, the original’s way', () => {
  it('takes the best of six throws of 3d6+1 for every ability', () => {
    // Every die a 1: 3d6+1 = 4 six times over, then held up to the race’s and class’s least.
    const low = rollStats('human', 0, CLASSES.indexOf('magic-user'), 19, () => 0)
    expect(low.stats).toEqual({ str: 4, int: 9, wis: 6, dex: 6, con: 4, cha: 4 })
    // Every die a 6: 3d6+1 = 19, capped at the race’s best — 18 for a human, 19 dexterity for an elf.
    const high = rollStats('elf', 0, CLASSES.indexOf('fighter'), 140, () => 5)
    expect(high.stats).toEqual({ str: 18, int: 18, wis: 18, dex: 19, con: 18, cha: 18 })
    expect(high.strPercent).toBe(6)
    // One great throw among six is kept: the first three dice sixes, the rest ones.
    const mixed = rollStats('human', 0, CLASSES.indexOf('fighter'), 19, sequence([5, 5, 5, ...Array<number>(105).fill(0)]))
    expect(mixed.stats.str).toBe(18)
    expect(mixed.stats.int).toBe(4)
  })

  it('ages a character by the race’s table and lets the years tell', () => {
    expect(rollAge('human', CLASSES.indexOf('fighter'), () => 1)).toBe(17)
    expect(rollAge('elf', CLASSES.indexOf('fighter/magic-user'), () => 0)).toBe(100 + 5 * 6)
    // A human past twenty is a point wiser for the worse and a point hardier.
    const grown = rollStats('human', 0, CLASSES.indexOf('thief'), 21, () => 2)
    expect(grown.stats).toEqual({ str: 10, int: 10, wis: 9, dex: 10, con: 11, cha: 10 })
  })

  it('holds a woman’s strength and a halfling’s to the race’s bounds, and raises a class’s minimums', () => {
    const she = rollStats('dwarf', 1, CLASSES.indexOf('fighter'), 60, () => 5)
    expect(she.stats.str).toBe(17)
    expect(she.strPercent).toBe(0)
    const paladin = rollStats('human', 0, CLASSES.indexOf('paladin'), 19, () => 0)
    expect(paladin.stats).toMatchObject({ str: 12, int: 9, wis: 13, con: 9, cha: 17 })
    const mcCleric = rollStats('half-elf', 0, CLASSES.indexOf('cleric/fighter'), 45, () => 0)
    expect(mcCleric.stats.wis).toBe(13)
  })

  it('rolls hit points as the better of two dice, shared between classes', () => {
    // A fighter: d10 twice, the better kept; con 16 adds two.
    expect(rollHitPoints(CLASSES.indexOf('fighter'), 16, sequence([2, 7]))).toBe(10)
    // A fighter/magic-user: (10 + 4 + 0) / 2.
    expect(rollHitPoints(CLASSES.indexOf('fighter/magic-user'), 10, (n) => n)).toBe(7)
    expect(rollHitPoints(CLASSES.indexOf('magic-user'), 3, () => 0)).toBe(1)
    expect(maxHitPoints(CLASSES.indexOf('fighter'), 18)).toBe(14)
    expect(maxHitPoints(CLASSES.indexOf('ranger'), 10)).toBe(16)
    expect(maxHitPoints(CLASSES.indexOf('cleric/magic-user'), 17)).toBe(8)
    expect(minHitPoints(CLASSES.indexOf('fighter'), 10)).toBe(1)
  })

  it('MODIFY nudges within the bounds and runs strength on into the percentile', () => {
    let draft: Draft = { race: 'human', sex: 0, classIndex: CLASSES.indexOf('fighter'), age: 19, stats: { str: 17, int: 10, wis: 10, dex: 10, con: 10, cha: 10 }, strPercent: 0, hp: 5 }
    // Reaching 18 opens the percentile at 01, as the port has it; each press past that adds one.
    draft = modify(draft, 'str', 1)
    expect(draft).toMatchObject({ strPercent: 1, stats: { str: 18 } })
    draft = modify(draft, 'str', 1)
    expect(draft.strPercent).toBe(2)
    draft = modify(draft, 'str', -1)
    draft = modify(draft, 'str', -1)
    expect(draft).toMatchObject({ strPercent: 0, stats: { str: 18 } })
    for (let i = 0; i < 20; i++) draft = modify(draft, 'str', -1)
    expect(draft.stats.str).toBe(9)
    for (let i = 0; i < 30; i++) draft = modify(draft, 'hp', 1)
    expect(draft.hp).toBe(10)
    draft = modify(draft, 'con', 1)
    expect(limits(draft).hp).toEqual([1, 10])
    const halfling: Draft = { ...draft, race: 'halfling', stats: { ...draft.stats, str: 17 } }
    expect(modify(halfling, 'str', 1)).toMatchObject({ strPercent: 0, stats: { str: 17 } })
  })

  it('knows who may be what', () => {
    expect(tracksOf(CLASSES.indexOf('fighter/magic-user/thief'))).toEqual([2, 5, 6])
    expect(CLASSES_BY_RACE.dwarf).toEqual([2, 6, 14])
    expect(CLASSES_BY_RACE.human).toContain(CLASSES.indexOf('paladin'))
    expect(alignmentsFor(CLASSES.indexOf('paladin'))).toEqual([0])
    expect(alignmentsFor(CLASSES.indexOf('thief'))).not.toContain(0)
  })

  it('makes a first-level fighter with the fighter saves and coin', () => {
    const draft = rollDraft('human', 0, CLASSES.indexOf('fighter'), () => 4)
    const c = createCharacter({ name: 'grimwald', alignment: 0, draft }, () => 4)
    expect(c.name).toBe('GRIMWALD')
    expect(c.levels[2]).toBe(1)
    expect(c.hpMax).toBe(draft.hp)
    expect(c.age).toBe(20)
    expect(c.savingThrows).toEqual([14, 15, 16, 17, 17])
    expect(c.money[3]).toBe(150)
    expect(c.spellbook).toEqual([])
    expect(c.icon).toBe(1)
  })

  it('gives a cleric/magic-user both books and slots', () => {
    const draft: Draft = { race: 'half-elf', sex: 1, classIndex: CLASSES.indexOf('cleric/magic-user'), age: 40, stats: { str: 10, int: 15, wis: 17, dex: 10, con: 10, cha: 10 }, strPercent: 0, hp: 6 }
    const c = createCharacter({ name: 'x', alignment: 3, draft }, () => 0)
    expect(c.spellbook).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 18, 21])
    expect(c.spellSlots).toEqual([3, 0, 0, 1, 0, 0])
    expect(c.hpMax).toBe(6)
  })
})
