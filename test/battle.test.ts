import { describe, expect, it } from 'vitest'

import { CHARACTER_RECORD_SIZE, readCharacter } from '../src/formats/character.js'
import { readGeoMap } from '../src/formats/geo.js'
import { buildGeoBlock } from './fixtures.js'
import { Battle, BATTLE_STEPS, EIGHT_STEPS } from '../src/engine/battle.js'
import { buildArena, FLOOR } from '../src/engine/arena.js'
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

describe('the arena', () => {
  it('lays the corridor out as the original did: floor rows, a diagonal west band, a two-row north wall', () => {
    const arena = buildArena(corridor(), { row: 8, col: 8 })
    const p = arena.patch(0, 0)
    // The floor rows of the party's square, with the west wall's band across them.
    expect(arena.tile(p.x + 0, p.y + 2)).toBe(FLOOR)
    expect([arena.tile(p.x + 1, p.y + 2), arena.tile(p.x + 2, p.y + 2), arena.tile(p.x + 3, p.y + 2)]).toEqual([4, 3, 13])
    expect([arena.tile(p.x + 2, p.y + 3), arena.tile(p.x + 3, p.y + 3), arena.tile(p.x + 4, p.y + 3)]).toEqual([4, 3, 13])
    // No north wall in a corridor: those rows are floor.
    expect(arena.tile(p.x + 3, p.y + 0)).toBe(FLOOR)
    // The rock square to the east has a north wall two rows tall.
    const east = arena.patch(1, 0)
    expect(arena.tile(east.x + 3, east.y + 0)).toBe(5)
    expect(arena.tile(east.x + 3, east.y + 1)).toBe(10)
    expect(arena.walkable(p.x + 5, p.y + 2)).toBe(true)
    expect(arena.walkable(p.x + 3, p.y + 3)).toBe(false)
  })
})

describe('a fight on the arena', () => {
  it('stands everyone on floor and keeps them off the walls', () => {
    const party = [{ member: { character: fighter('HERO', 20), items: [] }, label: 'HERO' }]
    const monsters = labelMonsters([{ member: { character: fighter('ORC', 6, 0), items: [] }, count: 2 }])
    const battle = new Battle(corridor(), party, monsters, { row: 8, col: 8, facing: 'north' }, 1, () => 0)
    for (const f of battle.fighters) expect(battle.tile(f.x, f.y)).toBe('floor')
    const hero = battle.fighters.find((f) => f.side === 'party')!
    const blockedSteps = EIGHT_STEPS.filter((s) => !battle.canMove(hero, s))
    expect(blockedSteps.length).toBeGreaterThan(0)
    expect(battle.fighters.filter((f) => f.side === 'monster').every((o) => o.y < hero.y)).toBe(true)
  })

  it('never stands the monsters where the party cannot reach them', () => {
    // The corridor, cut in two by a wall right in front of the party.
    const cut = readGeoMap(1, buildGeoBlock((row, col) => {
      if (col !== 8 || row < 2 || row > 12) return { n: 1, e: 1, s: 1, w: 1 }
      return { n: row === 8 ? 1 : 0, e: 1, s: row === 7 ? 1 : 0, w: 1 }
    }))
    const party = ['HERO', 'SECOND', 'THIRD', 'FOURTH'].map((name) => ({ member: { character: fighter(name, 20), items: [] }, label: name }))
    const monsters = labelMonsters([{ member: { character: fighter('ORC', 6, 0), items: [] }, count: 2 }])
    const battle = new Battle(cut, party, monsters, { row: 8, col: 8, facing: 'north' }, 1, () => 0)
    const hero = battle.fighters.find((f) => f.side === 'party')!
    const seen = new Set([`${hero.x},${hero.y}`])
    const queue = [{ x: hero.x, y: hero.y }]
    while (queue.length > 0) {
      const here = queue.shift()!
      for (const step of EIGHT_STEPS) {
        const x = here.x + step.dx
        const y = here.y + step.dy
        if (seen.has(`${x},${y}`) || battle.isSolid(x, y)) continue
        seen.add(`${x},${y}`)
        queue.push({ x, y })
      }
    }
    for (const orc of battle.fighters.filter((f) => f.side === 'monster')) expect(seen.has(`${orc.x},${orc.y}`)).toBe(true)
    // And the party is not split across a wall either.
    for (const friend of battle.fighters.filter((f) => f.side === 'party')) expect(seen.has(`${friend.x},${friend.y}`)).toBe(true)
  })

  it('moves with the points it has, strikes neighbours, and marches monsters in', () => {
    const party = [{ member: { character: fighter('HERO', 20, 7, 12), items: [] }, label: 'HERO' }]
    const monsters = labelMonsters([{ member: { character: fighter('ORC', 6, 0, 6), items: [] }, count: 1 }])
    const battle = new Battle(corridor(), party, monsters, { row: 8, col: 8, facing: 'north' }, 1, (max) => max)
    const hero = battle.fighters.find((f) => f.side === 'party')!
    const orc = battle.fighters.find((f) => f.side === 'monster')!
    expect(battle.current).toBe(hero)
    expect(hero.moves).toBe(6)
    const open = EIGHT_STEPS.find((s) => battle.canMove(hero, s))!
    expect(battle.move(hero, open)).toBe(true)
    expect(hero.moves).toBe(5)
    expect(battle.reachable(hero).size).toBeGreaterThan(0)
    battle.endTurn()
    expect(battle.current).toBe(orc)
    for (let i = 0; i < 6 && battle.neighbours(orc).length === 0; i++) {
      battle.monsterTurn(orc)
      battle.endTurn()
      if (battle.current === hero) battle.endTurn()
    }
    expect(battle.neighbours(hero)).toContain(orc)
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
    archer.attacks.range = 20
    const shaman = fighter('SHAMAN', 6, 0, 6)
    shaman.levels[5] = 1
    shaman.spellbook = [15]
    shaman.spellSlots = [0, 0, 0, 1, 0, 0]
    autoPrepare(shaman)
    const monsters = labelMonsters([
      { member: { character: archer, items: [] }, count: 1 },
      { member: { character: shaman, items: [] }, count: 1 },
    ])
    const battle = new Battle(corridor(), party, monsters, { row: 8, col: 8, facing: 'north' }, 1, (max) => max)
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
    void BATTLE_STEPS
  })
})

describe('furniture and the wilderness', () => {
  it('drops a table and chairs into a flagged room, and never into a corridor', async () => {
    const { buildArena } = await import('../src/engine/arena.js')
    const { buildGeoBlock } = await import('./fixtures.js')
    const { readGeoMap } = await import('../src/formats/geo.js')
    // A single walled room at (8,8) with the furniture bit set, rock all round.
    const room = readGeoMap(1, buildGeoBlock(
      (row, col) => (row === 8 && col === 8 ? { n: 1, e: 1, s: 1, w: 1 } : { n: 1, e: 1, s: 1, w: 1 }),
      () => 0,
      (row, col) => (row === 8 && col === 8 ? 0x40 : 0),
    ))
    const furnished = buildArena(room, { row: 8, col: 8 }, () => 0)
    const ids = [...furnished.tiles]
    expect(ids.filter((id) => id === 0x1a).length).toBeGreaterThan(0)
    expect(ids.filter((id) => id === 0x1b).length).toBeGreaterThan(0)
    const p = furnished.patch(0, 0)
    expect(furnished.tile(p.x + 2 + 2, p.y + 2)).toBe(0x22) // the table draws the first decoration
    expect(furnished.walkable(p.x + 2 + 2, p.y + 2)).toBe(true) // and can be climbed over, at a cost
    const bare = buildArena(corridor(), { row: 8, col: 8 }, () => 0)
    expect([...bare.tiles].some((id) => id === 0x1a || id === 0x1b)).toBe(false)
  })

  it('rolls open ground with scenery outdoors, on the same grid', async () => {
    const { buildWildArena } = await import('../src/engine/arena.js')
    let seed = 7
    const random = (max: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % (max + 1) }
    const wild = buildWildArena(random, 0x20)
    const ids = [...wild.tiles]
    expect(ids.every((id) => id >= 23)).toBe(true)
    expect(ids.filter((id) => id === 23).length).toBeGreaterThan(300)
    expect(ids.some((id) => id !== 23)).toBe(true)
    expect(wild.walkable(25, 12) || wild.walkable(26, 12)).toBe(true)
    const trees = ids.filter((id) => id >= 0x20 && id <= 0x24).length
    expect(trees).toBeGreaterThan(0)
    expect(wild.tile(0, 0)).toBe(22)
  })
})

describe('the rules of the round', () => {
  function named(name: string, hp: number, race = 7, extra: (data: Uint8Array) => void = () => {}) {
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
    data[0x11c] = 12
    for (let i = 0; i < 5; i++) data[0x6d + i] = 17
    extra(data)
    return readCharacter(data)
  }

  it('bleeds the dying a point a round and regrows a downed troll unless it is pinned', () => {
    const party = [{ member: { character: named('HERO', 20), items: [] }, label: 'HERO' }, { member: { character: named('SECOND', 20), items: [] }, label: 'SECOND' }]
    const monsters = labelMonsters([{ member: { character: named('TROLL', 12, 0), items: [] }, count: 1 }])
    const battle = new Battle(corridor(), party, monsters, { row: 8, col: 8, facing: 'north' }, 1, () => 0)
    const hero = battle.fighters.find((f) => f.side === 'party')!
    const troll = battle.fighters.find((f) => f.side === 'monster')!
    hero.combatant.member.character.status = 'dying'
    hero.combatant.member.character.hpCurrent = -8
    troll.combatant.member.character.status = 'unconscious'
    troll.combatant.member.character.hpCurrent = 6
    // Two rounds pass.
    const rounds = battle as unknown as { startRound(): void }
    rounds.startRound()
    rounds.startRound()
    expect(hero.combatant.member.character.status).toBe('dead')
    expect(troll.combatant.member.character.status).toBe('okay')
    expect(battle.roundLines.some((l) => l.includes('RISES'))).toBe(true)
  })

  it('a ghoul paralyses on a failed save, a fighter sweeps the small fry, and the edge is the way out', () => {
    const party = [{ member: { character: named('HERO', 20, 7, (d) => { d[0x98] = 3 }), items: [] }, label: 'HERO' }]
    const monsters = labelMonsters([{ member: { character: named('KOBOLD', 3, 0, (d) => { d[0x73] = 0 }), items: [] }, count: 3 }])
    const battle = new Battle(corridor(), party, monsters, { row: 8, col: 8, facing: 'north' }, 1, () => 18)
    const hero = battle.fighters.find((f) => f.side === 'party')!
    const kobolds = battle.fighters.filter((f) => f.side === 'monster')
    for (const [i, k] of kobolds.entries()) { k.x = hero.x + (i - 1); k.y = hero.y - 1 }
    const lines = battle.attack(hero, kobolds[1]!)
    expect(lines.filter((l) => l.includes('SWEEPS')).length).toBe(2)

    const ghoul = named('GHOUL', 10, 0)
    const victim = named('VICTIM', 20)
    const b2 = new Battle(corridor(), [{ member: { character: victim, items: [] }, label: 'VICTIM' }], labelMonsters([{ member: { character: ghoul, items: [] }, count: 1 }]), { row: 8, col: 8, facing: 'north' }, 1, () => 14)
    const g = b2.fighters.find((f) => f.side === 'monster')!
    const v = b2.fighters.find((f) => f.side === 'party')!
    g.x = v.x; g.y = v.y - 1
    const hit = b2.attack(g, v)
    expect(hit.some((l) => l.includes('PARALYZED'))).toBe(true)
    expect(victim.status).toBe('held')

    // Any open square on the edge, and a step onto it from inside.
    const runner = battle.fighters.find((f) => f.side === 'party')!
    runner.moves = 99
    let placed = false
    for (let x = 1; x < battle.width - 1 && !placed; x++) {
      if (battle.isSolid(x, 0) || battle.isSolid(x, 1)) continue
      runner.x = x; runner.y = 1
      placed = battle.move(runner, { dx: 0, dy: -1 })
    }
    expect(placed).toBe(true)
    expect(runner.combatant.member.character.status).toBe('running')
  })
})
