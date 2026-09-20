import { describe, expect, it } from 'vitest'

import { CHARACTER_RECORD_SIZE, readCharacter } from '../src/formats/character.js'
import { readGeoMap } from '../src/formats/geo.js'
import { buildGeoBlock } from './fixtures.js'
import { Battle, BATTLE_STEPS, CELL_SPAN } from '../src/engine/battle.js'
import { labelMonsters } from '../src/engine/combat.js'

function fighter(name: string, hp: number, race = 7, movement = 12) {
  const data = new Uint8Array(CHARACTER_RECORD_SIZE)
  data[0] = name.length
  for (let i = 0; i < name.length; i++) data[1 + i] = name.charCodeAt(i)
  data[0x2e] = race
  data[0x32] = hp
  data[0x11b] = hp
  data[0x111] = 60 - 10
  data[0x2d] = 60 - 20
  data[0xa1] = 2
  data[0x115] = 1
  data[0x117] = 8
  data[0x119] = 4
  data[0x11c] = movement
  return readCharacter(data)
}

/** A corridor running north from (8,8): walls east and west of every square on column 8. */
function corridor() {
  return readGeoMap(1, buildGeoBlock((row, col) => (col === 8 && row >= 2 && row <= 12 ? { n: 0, e: 1, s: 0, w: 1 } : { n: 1, e: 1, s: 1, w: 1 })))
}

describe('the battle map', () => {
  it('keeps the corridor walls and fills the rock around it', () => {
    const party = [{ member: { character: fighter('HERO', 20), items: [] }, label: 'HERO' }]
    const monsters = labelMonsters([{ member: { character: fighter('ORC', 6, 0), items: [] }, count: 2 }])
    const battle = new Battle(corridor(), party, monsters, { row: 8, col: 8, facing: 'north' }, 1, () => 0)
    const centre = 3 * CELL_SPAN
    expect(battle.isSolid(centre, centre)).toBe(false)
    expect(battle.isSolid(centre - CELL_SPAN, centre)).toBe(true)
    expect(battle.blocked(centre, centre, -1, 0)).toBe(true)
    expect(battle.blocked(centre, centre, 0, -1)).toBe(false)
    const hero = battle.fighters.find((f) => f.side === 'party')!
    expect([hero.x, hero.y]).toEqual([centre, centre])
    const orcs = battle.fighters.filter((f) => f.side === 'monster')
    expect(orcs.every((o) => o.y < hero.y)).toBe(true)
  })

  it('moves with the points it has, strikes neighbours, and marches monsters in', () => {
    const party = [{ member: { character: fighter('HERO', 20, 7, 12), items: [] }, label: 'HERO' }]
    const monsters = labelMonsters([{ member: { character: fighter('ORC', 6, 0, 6), items: [] }, count: 1 }])
    // Every roll top: the hero always wins initiative and always hits.
    const battle = new Battle(corridor(), party, monsters, { row: 8, col: 8, facing: 'north' }, 1, (max) => max)
    const hero = battle.fighters.find((f) => f.side === 'party')!
    const orc = battle.fighters.find((f) => f.side === 'monster')!
    expect(battle.current).toBe(hero)
    expect(hero.moves).toBe(6)
    expect(battle.move(hero, BATTLE_STEPS.west)).toBe(false) // corridor wall
    expect(battle.move(hero, BATTLE_STEPS.north)).toBe(true)
    expect(battle.neighbours(hero)).toEqual([])
    battle.endTurn()
    expect(battle.current).toBe(orc)
    const lines = battle.monsterTurn(orc)
    expect(Math.abs(orc.y - hero.y) <= 1 && Math.abs(orc.x - hero.x) <= 1).toBe(true)
    expect(lines[0]).toMatch(/^ORC (HITS|MISSES) HERO/)
    battle.endTurn()
    expect(battle.round).toBe(2)
    expect(battle.current).toBe(hero)
    const blow = battle.attack(hero, orc)
    expect(blow[0]).toMatch(/^HERO HITS ORC FOR 12\. ORC IS DEAD!$/)
    expect(battle.over).toBe(true)
  })
})
