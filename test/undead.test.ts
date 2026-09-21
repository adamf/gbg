import { describe, expect, it } from 'vitest'

import { CHARACTER_RECORD_SIZE, readCharacter } from '../src/formats/character.js'
import { turnOne } from '../src/engine/undead.js'
import { Battle } from '../src/engine/battle.js'
import { labelMonsters } from '../src/engine/combat.js'
import { readGeoMap } from '../src/formats/geo.js'
import { buildGeoBlock } from './fixtures.js'
import { EclMemory, EclVm, type EclHost } from '../src/engine/ecl-vm.js'
import { buildEclBlock, ECL_CODE_START, eclInstruction } from './fixtures.js'
import { Roster } from '../src/engine/roster.js'

function who(name: string, opts: { cleric?: number; hd?: number; undead?: boolean; hp?: number; move?: number }) {
  const d = new Uint8Array(CHARACTER_RECORD_SIZE)
  d[0] = name.length
  for (let i = 0; i < name.length; i++) d[1 + i] = name.charCodeAt(i)
  d[0x96] = opts.cleric ?? 0
  d[0x73] = opts.hd ?? 1
  d[0x9f] = opts.undead ? 4 : 0
  d[0x2e] = opts.undead ? 0 : 7
  d[0x32] = opts.hp ?? 8
  d[0x11b] = opts.hp ?? 8
  d[0x11c] = opts.move ?? 12
  d[0x111] = 50
  d[0x2d] = 40
  d[0xa1] = 2
  d[0x115] = 1
  d[0x117] = 6
  d[0x78] = 30
  return readCharacter(d)
}

describe('turning undead', () => {
  it('follows the table: a first-level cleric turns a skeleton on a ten, destroys nothing, and cannot touch a wight', () => {
    const cleric = who('SEAN', { cleric: 1 })
    expect(turnOne(cleric, who('SKELETON', { hd: 1, undead: true }), () => 5)).toBe('turned') // 6 + 6
    expect(turnOne(cleric, who('SKELETON', { hd: 1, undead: true }), () => 2)).toBe('unmoved') // 3 + 3
    expect(turnOne(cleric, who('WIGHT', { hd: 6, undead: true }), () => 5)).toBe('unmoved')
    expect(turnOne(who('BISHOP', { cleric: 9 }), who('SKELETON', { hd: 1, undead: true }), () => 0)).toBe('destroyed')
  })

  it('a cleric in a fight sends the nearest undead running', () => {
    const map = readGeoMap(1, buildGeoBlock(() => ({ n: 0, e: 0, s: 0, w: 0 })))
    const party = [{ member: { character: who('SEAN', { cleric: 3 }), items: [] }, label: 'SEAN' }]
    const monsters = labelMonsters([{ member: { character: who('ZOMBIE', { hd: 2, undead: true }), items: [] }, count: 2 }])
    const battle = new Battle(map, party, monsters, { row: 8, col: 8, facing: 'north' }, 1, () => 5)
    const sean = battle.fighters.find((f) => f.side === 'party')!
    expect(battle.undead().length).toBe(2)
    const lines = battle.turnUndead(sean)
    expect(lines[0]).toBe('SEAN PRESENTS THE HOLY SYMBOL.')
    expect(lines.filter((l) => l.endsWith('FLEES!')).length).toBeGreaterThan(0)
    expect(battle.undead().length).toBeLessThan(2)
  })
})

describe('the party the scripts ask about', () => {
  it('reports movement, skills, spell holders, and robs by the percentages', () => {
    const r = new Roster()
    const a = who('A', { move: 12 })
    const b = who('B', { move: 6 })
    b.memorised = [3, 21]
    a.money[3] = 100
    r.members = [{ character: a, items: [] }, { character: b, items: [] }]
    expect(r.checkParty('movement', 0)).toEqual([0, 9, 12, 6])
    expect(r.checkParty('skill', 0)).toEqual([0, 30, 30, 30])
    expect(r.spellHolder(21)).toEqual({ player: 1, index: 2 })
    expect(r.spellHolder(15)).toBeUndefined()
    r.rob(r.members, 40, 0, () => 99)
    expect(a.money[3]).toBe(40)
  })

  it('answers CHECK PARTY and SPELL through the host', async () => {
    const MEM = 0x9900
    const at = (o: number) => MEM + ECL_CODE_START + o
    const code = [
      ...eclInstruction(0x1e, [{ mem: 0x809e }, { imm: 0 }, { mem: 0x4a00 }, { mem: 0x4a01 }, { mem: 0x4a02 }, { mem: 0x4a03 }]),
      ...eclInstruction(0x3b, [{ imm: 21 }, { mem: 0x4a04 }, { mem: 0x4a05 }]),
      ...eclInstruction(0x00),
    ]
    const block = buildEclBlock({ memStart: MEM, header: [at(0), at(0), at(0), at(0), at(0)], code: [{ at: at(0), bytes: code }], size: 0x900 })
    const memory = new EclMemory()
    memory.loadImage(block, MEM)
    const host: EclHost = {
      checkParty: (kind) => (kind === 'movement' ? [0, 9, 12, 6] : [0, 0, 0, 0]),
      spellHolder: (id) => (id === 21 ? { player: 1, index: 2 } : undefined),
    }
    await new EclVm(memory, host).run(at(0))
    expect([memory.read(0x4a00), memory.read(0x4a01), memory.read(0x4a02), memory.read(0x4a03)]).toEqual([0, 9, 12, 6])
    expect([memory.read(0x4a04), memory.read(0x4a05)]).toEqual([2, 1])
  })
})
