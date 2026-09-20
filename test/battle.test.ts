import { describe, expect, it } from 'vitest'

import { CHARACTER_RECORD_SIZE, readCharacter } from '../src/formats/character.js'
import { readGeoMap } from '../src/formats/geo.js'
import { buildGeoBlock } from './fixtures.js'
import { Battle, BATTLE_STEPS, screenOf } from '../src/engine/battle.js'
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
    const centre = screenOf(3, 3)
    expect(battle.tile(centre.x, centre.y)).toBe('floor')
    expect(battle.tile(centre.x - 1, centre.y)).toBe('wall-along') // the corridor's west wall
    expect(battle.tile(screenOf(3, 2).x, centre.y)).toBe('rock')
    expect(battle.blocked(centre.x, centre.y, -1, 0)).toBe(true)
    // The shear: straight up on screen drifts east in the dungeon, into the corridor's wall.
    expect(battle.blocked(centre.x, centre.y, 0, -1)).toBe(true)
    expect(battle.blocked(centre.x, centre.y, -1, -1)).toBe(false)
    const above = screenOf(2, 3, 1, 2)
    expect(battle.tile(above.x, above.y)).toBe('floor') // the corridor continues north
    const hero = battle.fighters.find((f) => f.side === 'party')!
    expect([hero.x, hero.y]).toEqual([centre.x, centre.y])
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
    expect(battle.move(hero, { dx: -1, dy: -1 })).toBe(true) // north along the sheared corridor
    expect(battle.move(hero, { dx: -1, dy: -1 })).toBe(true)
    expect(battle.reachable(hero).size).toBeGreaterThan(0)
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

describe('monsters that shoot and cast', () => {
  it('shoots from range and casts a ready spell instead of walking in', async () => {
    const { autoPrepare } = await import('../src/engine/casting.js')
    const party = [{ member: { character: fighter('HERO', 20, 7, 12), items: [] }, label: 'HERO' }]
    const archer = fighter('ARCHER', 6, 0, 6)
    archer.attacks.range = 12
    const shaman = fighter('SHAMAN', 6, 0, 6)
    shaman.levels[5] = 1
    shaman.spellbook = [15]
    shaman.spellSlots = [0, 0, 0, 1, 0, 0]
    autoPrepare(shaman)
    const monsters = labelMonsters([
      { member: { character: archer, items: [] }, count: 1 },
      { member: { character: shaman, items: [] }, count: 1 },
    ])
    const battle = new Battle(corridor(), party, monsters, { row: 8, col: 8, facing: 'north' }, 2, (max) => max)
    const hero = battle.fighters.find((f) => f.side === 'party')!
    const a = battle.fighters.find((f) => f.combatant.label === 'ARCHER')!
    const s = battle.fighters.find((f) => f.combatant.label === 'SHAMAN')!
    const before = { ax: a.x, ay: a.y, sx: s.x, sy: s.y }
    const shot = battle.monsterTurn(a)
    expect(shot[0]).toMatch(/^ARCHER HITS HERO/)
    expect([a.x, a.y]).toEqual([before.ax, before.ay])
    const spell = battle.monsterTurn(s)
    expect(spell[0]).toBe('SHAMAN CASTS MAGIC MISSILE.')
    expect([s.x, s.y]).toEqual([before.sx, before.sy])
    expect(hero.combatant.member.character.hpCurrent).toBeLessThan(20)
    expect(s.combatant.member.character.memorised).toEqual([])
  })
})
