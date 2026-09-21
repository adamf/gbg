import { describe, expect, it } from 'vitest'

import { CHARACTER_RECORD_SIZE, readCharacter } from '../src/formats/character.js'
import { readSpellNames, spellById, spellLevelOf } from '../src/formats/spells.js'
import { autoPrepare, cast, memorise, ready, refresh, slots } from '../src/engine/casting.js'
import { Combat, labelMonsters } from '../src/engine/combat.js'

function record(name: string, opts: { hp?: number; levels?: number[]; book?: number[]; slots?: number[]; hitDice?: number; race?: number; save?: number }): ReturnType<typeof readCharacter> {
  const data = new Uint8Array(CHARACTER_RECORD_SIZE)
  data[0] = name.length
  for (let i = 0; i < name.length; i++) data[1 + i] = name.charCodeAt(i)
  data[0x32] = opts.hp ?? 10
  data[0x11b] = opts.hp ?? 10
  data[0x2e] = opts.race ?? 7
  data[0x73] = opts.hitDice ?? 1
  data[0x111] = 60 - 7
  data[0x2d] = 60 - 20
  data[0xa1] = 2
  data[0x115] = 1
  data[0x117] = 6
  data[0x11c] = 9
  for (let i = 0; i < 5; i++) data[0x6d + i] = opts.save ?? 15
  ;(opts.levels ?? []).forEach((l, i) => { data[0x96 + i] = l })
  for (const id of opts.book ?? []) data[0x33 + id - 1] = 1
  ;(opts.slots ?? []).forEach((n, i) => { data[0xb2 + i] = n })
  return readCharacter(data)
}

describe('spell names and numbering', () => {
  it('scans the names from Bless onward, skipping any other Bless', () => {
    const literal = (t: string) => [t.length, ...[...t].map((c) => c.charCodeAt(0))]
    const exe = Uint8Array.from([...literal('Bless'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...literal('Bless'), 0xb2, 0, ...literal('Curse'), 0, 0xb0, ...literal('Cure Light Wounds'), 0xc3])
    expect(readSpellNames(exe).slice(0, 4)).toEqual(['', 'Bless', 'Curse', 'Cure Light Wounds'])
  })

  it('knows which class and level every id belongs to', () => {
    expect(spellLevelOf(3)).toEqual({ class: 'cleric', level: 1 })
    expect(spellLevelOf(21)).toEqual({ class: 'magic-user', level: 1 })
    expect(spellLevelOf(23)).toEqual({ class: 'cleric', level: 2 })
    expect(spellLevelOf(45)).toEqual({ class: 'magic-user', level: 3 })
    expect(spellLevelOf(99)).toBeUndefined()
  })
})

describe('memorising', () => {
  it('reads slots per class from the record and refuses what the book or slots lack', () => {
    const mage = record('DARKSTAR', { levels: [0, 0, 0, 0, 0, 1], book: [11, 18, 19, 21], slots: [0, 0, 0, 1, 0, 0] })
    expect(slots(mage, 'magic-user')).toEqual([1, 0, 0])
    expect(memorise(mage, [21, 15])).toEqual([15]) // Magic Missile is not in the book
    expect(mage.memorised).toEqual([21])
    expect(memorise(mage, [21, 19])).toEqual([19]) // only one first-level slot
  })

  it('auto-prepares cures for clerics and sleep for mages, and a rest refills', () => {
    const cleric = record('SEAN', { levels: [1], book: [1, 2, 3, 4, 5, 6, 7, 8], slots: [3, 0, 0, 0, 0, 0] })
    autoPrepare(cleric)
    expect(cleric.memorised).toEqual([3, 1, 6])
    const mage = record('DARKSTAR', { levels: [0, 0, 0, 0, 0, 1], book: [11, 18, 19, 21], slots: [0, 0, 0, 1, 0, 0] })
    autoPrepare(mage)
    expect(ready(mage).map((s) => s.name)).toEqual(['Sleep'])
    mage.memorised = []
    refresh(mage)
    expect(mage.memorised).toEqual([21])
  })
})

describe('casting', () => {
  it('sleep drops low hit-dice foes within its budget and blows on them always land', () => {
    const mage = record('DARKSTAR', { levels: [0, 0, 0, 0, 0, 1], hp: 5 })
    const fighter = record('THRENDER', { levels: [0, 0, 1], hp: 11 })
    const kobolds = labelMonsters([{ member: { character: record('KOBOLD', { hp: 2, hitDice: 1, race: 0 }), items: [] }, count: 5 }])
    const party = [{ member: { character: mage, items: [] }, label: 'DARKSTAR' }, { member: { character: fighter, items: [] }, label: 'THRENDER' }]
    const combat = new Combat(party, kobolds, () => 0)
    // 2d4 with every die at 1 sleeps two hit dice worth.
    const { lines } = cast(spellById(21)!, mage, kobolds.map((k) => k.member.character), () => 0, combat)
    expect(lines).toEqual(['DARKSTAR CASTS SLEEP.', 'KOBOLD FALLS ASLEEP.', 'KOBOLD 2 FALLS ASLEEP.'])
    expect(combat.monstersStanding.length).toBe(5)
    // Every roll a 1: no ordinary hit would land, but the fighter finishes a sleeper off.
    combat.acted.add(mage)
    const round = combat.next()
    expect(round.some((l) => l.startsWith('THRENDER HITS KOBOLD') && l.includes('DEAD'))).toBe(true)
  })

  it('magic missile hurts and cure light wounds never heals past the maximum', () => {
    const mage = record('DARKSTAR', { levels: [0, 0, 0, 0, 0, 1] })
    const orc = record('ORC', { hp: 5, race: 0 })
    let { lines } = cast(spellById(15)!, mage, [orc], () => 3)
    expect(lines[1]).toBe('ORC TAKES 5 AND IS DEAD.')
    const cleric = record('SEAN', { levels: [1] })
    const hurt = record('HERO', { hp: 10 })
    hurt.hpCurrent = 8
    ;({ lines } = cast(spellById(3)!, cleric, [hurt], () => 7))
    expect(lines[1]).toBe('HERO IS HEALED 2.')
    expect(hurt.hpCurrent).toBe(10)
  })

  it('names every spell and casts the plain ones for nothing, and curses the foe', () => {
    expect(spellById(47)?.name).toBe('Fireball')
    expect(spellById(24)).toMatchObject({ name: 'Resist Fire', class: 'cleric', level: 2, effect: { kind: 'buff', affect: 'resistFire' } })
    expect(spellById(36)).toMatchObject({ name: 'Animate Dead', effect: { kind: 'none' } })
    expect(spellById(99)).toBeUndefined()
    const cleric = record('SEAN', { levels: [1] })
    const orc = record('ORC', { race: 0 })
    const combat = new Combat([{ member: { character: cleric, items: [] }, label: 'SEAN' }], labelMonsters([{ member: { character: orc, items: [] }, count: 1 }]), () => 0)
    cast(spellById(2)!, cleric, [orc], () => 0, combat)
    expect(combat.hitBonusOf(orc)).toBe(-1)
    expect(combat.hitModifier(true)).toBe(0)
  })

  it('hold person lets a good save through and holds the rest', () => {
    const cleric = record('SEAN', { levels: [3] })
    const foes = [record('A', { race: 0, save: 20 }), record('B', { race: 0, save: 2 })]
    const { lines } = cast(spellById(23)!, cleric, foes, () => 10)
    expect(lines).toEqual(['SEAN CASTS HOLD PERSON.', 'A IS HELD.', 'B RESISTS.'])
  })
})


describe('lasting effects', () => {
  it('run for their rounds and fall off, doubling attacks under haste and gagging the silenced', () => {
    const mage = record('DARKSTAR', { levels: [0, 0, 0, 0, 0, 5], book: [48, 25, 55], slots: [0, 0, 0, 1, 1, 1] })
    const orc = record('ORC', { race: 0, hp: 8 })
    const combat = new Combat([{ member: { character: mage, items: [] }, label: 'DARKSTAR' }], labelMonsters([{ member: { character: orc, items: [] }, count: 1 }]), () => 0)
    cast(spellById(48)!, mage, [mage], () => 0, combat)
    expect(combat.has(mage, 'haste')).toBe(true)
    expect(combat.attacksOf(mage)).toBe(2)
    // Haste lasts three rounds plus one a level: eight. Seven stirs later it still holds; the eighth ends it.
    for (let i = 0; i < 7; i++) combat.stir()
    expect(combat.has(mage, 'haste')).toBe(true)
    combat.stir()
    expect(combat.has(mage, 'haste')).toBe(false)

    cast(spellById(55)!, mage, [orc], () => 0, combat)
    expect(combat.has(orc, 'slow')).toBe(true)
    expect(combat.attacksOf(orc)).toBe(1)
    combat.affect(orc, 'silence', 1, 3)
    expect(combat.has(orc, 'silence')).toBe(true)
    expect(combat.dispel(orc)).toBeGreaterThan(0)
    expect(combat.has(orc, 'slow')).toBe(false)
  })

  it('slow poison brings back the poisoned and restoration gives back a drained level', () => {
    const cleric = record('SEAN', { levels: [3], book: [26, 56], slots: [1, 1, 1, 0, 0, 0] })
    const victim = record('HERO', { levels: [0, 0, 3] })
    victim.status = 'dead'; victim.poisoned = true; victim.hpCurrent = 0
    const { lines } = cast(spellById(26)!, cleric, [victim], () => 0)
    expect(lines[1]).toBe('HERO BREATHES AGAIN.')
    expect(victim.status).toBe('okay')
    victim.levels[2] = 2; victim.drained = 1
    cast(spellById(56)!, cleric, [victim], () => 0)
    expect(victim.levels[2]).toBe(3)
    expect(victim.drained).toBe(0)
  })
})
