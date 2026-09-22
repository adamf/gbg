import { describe, expect, it } from 'vitest'

import { CHARACTER_RECORD_SIZE, readCharacter, type Item } from '../src/formats/character.js'
import { canReadScroll, canScribe, readFromScroll, scribe, scrollReader, scrollSpells, TYPE_CLERIC_SCROLL, TYPE_MU_SCROLL } from '../src/engine/scrolls.js'

function caster(levels: number[], slots: number[] = []): ReturnType<typeof readCharacter> {
  const data = new Uint8Array(CHARACTER_RECORD_SIZE)
  data[0] = 3
  data[1] = 77; data[2] = 65; data[3] = 71
  data[0x2e] = 7
  levels.forEach((l, i) => { data[0x96 + i] = l })
  slots.forEach((n, i) => { data[0xb2 + i] = n })
  return readCharacter(data)
}

/** A Magic User Scroll With 3 Spells, as the shipped template: Fireball, Ray of Enfeeblement, Stinking Cloud. */
function muScroll(): Item {
  return { name: '', type: TYPE_MU_SCROLL, names: [0, 212, 209], plus: 2, readied: false, cursed: false, weight: 1, count: 1, value: 0, affects: [47, 33, 34] }
}

describe('scrolls', () => {
  it('lists the spells still written on it', () => {
    expect(scrollSpells(muScroll()).map((s) => s.name)).toEqual(['Fireball', 'Ray of Enfeeblement', 'Stinking Cloud'])
    const cleric: Item = { ...muScroll(), type: TYPE_CLERIC_SCROLL, names: [0, 211, 208], plus: 1, affects: [36, 37, 0] }
    expect(scrollSpells(cleric).map((s) => s.id)).toEqual([36, 37])
  })

  it('is read only by the class it is written for', () => {
    const mu = caster([0, 0, 0, 0, 0, 1, 0, 0])
    const fighter = caster([0, 0, 1, 0, 0, 0, 0, 0])
    expect(canReadScroll(mu, muScroll())).toBe(true)
    expect(canReadScroll(fighter, muScroll())).toBe(false)
  })

  it('reads as a sixth-level caster when the reader is lower', () => {
    const mu = caster([0, 0, 0, 0, 0, 1, 0, 0])
    expect(scrollReader(mu, muScroll()).levels[5]).toBe(6)
    expect(scrollReader(caster([0, 0, 0, 0, 0, 9, 0, 0]), muScroll()).levels[5]).toBe(9)
  })

  it('loses a spell when it is read, and its name counts down', () => {
    const item = muScroll()
    readFromScroll(item, 33)
    expect(item.affects).toEqual([47, 34, 0])
    expect(item.plus).toBe(1)
    expect(item.names[1]).toBe(211)
    readFromScroll(item, 47)
    readFromScroll(item, 34)
    expect(scrollSpells(item)).toEqual([])
  })

  it('is scribed by a magic-user with a slot of that level and no such spell yet', () => {
    const item = muScroll()
    const fireball = scrollSpells(item)[0]!
    const novice = caster([0, 0, 0, 0, 0, 1, 0, 0], [0, 0, 0, 1, 0, 0])
    expect(canScribe(novice, fireball)).toBe(false)
    const adept = caster([0, 0, 0, 0, 0, 5, 0, 0], [0, 0, 0, 4, 2, 1])
    expect(canScribe(adept, fireball)).toBe(true)
    scribe(adept, item, fireball)
    expect(adept.spellbook).toContain(47)
    expect(canScribe(adept, fireball)).toBe(false)
    expect(scrollSpells(item).map((s) => s.id)).toEqual([33, 34])
  })
})
