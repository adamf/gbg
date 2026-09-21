import { describe, expect, it } from 'vitest'

import { CHARACTER_RECORD_SIZE, characterLevel, className, ITEM_RECORD_SIZE, raceName, readCharacter, readItems } from '../src/formats/character.js'
import { EclMemory, SELECTED_CHARACTER_BASE } from '../src/engine/ecl-vm.js'
import { Roster } from '../src/engine/roster.js'

/** A record built to the spec: a level 1 dwarf fighter, as the game would save one. */
function fighterRecord(overrides: Partial<{ hp: number; ac: number }> = {}): Uint8Array {
  const data = new Uint8Array(CHARACTER_RECORD_SIZE)
  const name = 'THRENDER GRONE'
  data[0] = name.length
  for (let i = 0; i < name.length; i++) data[1 + i] = name.charCodeAt(i)
  data.set([17, 12, 12, 17, 16, 15, 0], 0x10)
  data[0x2d] = 60 - 20 // thac0 20
  data[0x2e] = 1 // dwarf
  data[0x2f] = 2 // fighter
  data[0x30] = 52
  data[0x32] = overrides.hp ?? 11
  data.set([14, 15, 16, 17, 17], 0x6d)
  data[0x72] = 12
  data[0x73] = 1
  data[0x85] = 1
  data[0x88 + 2] = 36 // silver
  data[0x88 + 8] = 2 // platinum
  data[0x96 + 2] = 1 // fighter level 1
  data[0xa9] = 60 - 10
  data[0xac] = 32
  data[0x110] = 41
  data[0x111] = 60 - (overrides.ac ?? 1)
  data[0x112] = 60 - 6
  data[0x115] = 1
  data[0x117] = 6
  data[0x119] = 2
  data[0x11b] = overrides.hp ?? 11
  data[0x11c] = 9
  return data
}

describe('character records', () => {
  it('reads the sheet out of a saved character', () => {
    const c = readCharacter(fighterRecord())
    expect(c.name).toBe('THRENDER GRONE')
    expect(raceName(c)).toBe('dwarf')
    expect(className(c)).toBe('fighter')
    expect(characterLevel(c)).toBe(1)
    expect(c.stats).toEqual({ str: 17, int: 12, wis: 12, dex: 17, con: 16, cha: 15, strPercent: 0 })
    expect(c.hpMax).toBe(11)
    expect(c.hpCurrent).toBe(11)
    expect(c.ac).toBe(1)
    expect(c.thac0).toBe(20)
    expect(c.savingThrows).toEqual([14, 15, 16, 17, 17])
    expect(c.money).toEqual([0, 36, 0, 0, 2, 0, 0])
    expect(c.experience).toBe(32)
    expect(c.movement).toBe(9)
    expect(c.status).toBe('okay')
    expect(c.attacks).toEqual({ count: 0, dice: 1, sides: 6, bonus: 2 })
  })

  it('reads an inventory as fixed-size records', () => {
    const data = new Uint8Array(ITEM_RECORD_SIZE * 2)
    const put = (at: number, name: string) => {
      data[at] = name.length
      for (let i = 0; i < name.length; i++) data[at + 1 + i] = name.charCodeAt(i)
    }
    put(0, 'Flail')
    data[0x2e] = 12
    data[0x34] = 1
    data[0x37] = 150
    data[0x3a] = 3
    put(ITEM_RECORD_SIZE, 'Banded Mail')
    data[ITEM_RECORD_SIZE + 0x32] = 0xff // -1
    const items = readItems(data)
    expect(items.map((i) => i.name)).toEqual(['Flail', 'Banded Mail'])
    expect(items[0]).toMatchObject({ type: 12, readied: true, weight: 150, value: 3, plus: 0 })
    expect(items[1]!.plus).toBe(-1)
  })
})

describe('the roster', () => {
  function roster(): Roster {
    const r = new Roster()
    r.members = [
      { character: readCharacter(fighterRecord()), items: [] },
      { character: readCharacter(fighterRecord({ hp: 5, ac: 7 })), items: [] },
    ]
    return r
  }

  it('shows the selected character to scripts at 0x6B00', () => {
    const r = roster()
    const memory = new EclMemory()
    memory.character = r.hook()
    expect(memory.read(SELECTED_CHARACTER_BASE + 0x72)).toBe(1) // race: dwarf
    expect(memory.read(SELECTED_CHARACTER_BASE + 0x73)).toBe(2) // class: fighter
    expect(memory.read(SELECTED_CHARACTER_BASE + 0xbf)).toBe(36) // silver
    expect(memory.read(SELECTED_CHARACTER_BASE + 0x100)).toBe(1) // present and standing
    expect(memory.read(SELECTED_CHARACTER_BASE + 0x33e)).toBe(2) // party size
    expect(memory.readString(SELECTED_CHARACTER_BASE)).toBe('THRENDER GRONE')
    memory.character.select(5)
    expect(memory.read(SELECTED_CHARACTER_BASE + 0x100)).toBe(0) // nobody there
    memory.character.select(0)
    memory.write(SELECTED_CHARACTER_BASE + 0xc1, 50)
    expect(r.members[0]!.character.money[3]).toBe(50)
    // Scratch beyond the character's fields is ordinary memory.
    memory.write(0x6dd2, 7)
    expect(memory.read(0x6dd2)).toBe(7)
  })

  it('rolls damage against everyone and knocks out whoever runs dry', () => {
    const r = roster()
    const lines = r.applyDamage({ flags: 0xc0 | 0x10, dice: 2, sides: 3, bonus: 0, kind: 0 }, () => 2)
    // Past zero is dying, at zero unconscious: the second member had exactly six.
    expect(lines[0]).toBe('THRENDER GRONE TAKES 6 DAMAGE.')
    expect(lines[1]).toMatch(/THRENDER GRONE TAKES 6 DAMAGE AND IS (UNCONSCIOUS|DYING)\./)
    expect(r.members[0]!.character.hpCurrent).toBe(5)
    expect(r.members[1]!.character.hpCurrent).toBeLessThanOrEqual(0)
    expect(r.active.length).toBe(1)
  })

  it('lets a saving throw avoid damage', () => {
    const r = roster()
    // Save kind 1 needs 14; a roll of 19 + 1 makes it.
    const saved = r.applyDamage({ flags: 0x80, dice: 1, sides: 6, bonus: 0, kind: 0x81 }, () => 18)
    expect(saved).toEqual(['THRENDER GRONE RESISTS.'])
    const failed = r.applyDamage({ flags: 0x80, dice: 1, sides: 6, bonus: 0, kind: 0x81 }, () => 0)
    expect(failed).toEqual(['THRENDER GRONE TAKES 1 DAMAGE.'])
  })

  it('measures strength the way the original did', () => {
    const r = roster()
    // Each fighter: hp + (hit bonus 41 - 39) * 5 = 11 + 10 → 2, and 5 + 10 → 1.
    expect(r.strength()).toBe(3)
    expect(r.movement()).toEqual({ min: 9, max: 9 })
  })
})
