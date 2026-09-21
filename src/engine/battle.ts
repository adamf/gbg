/**
 * The tactical fight: a grid built from the dungeon around the party, turns in
 * initiative order with movement points, blows against neighbours, missiles down
 * the lines, and monsters that close in.
 *
 * The arena is the original's, built by `arena.ts` from the dungeon around the
 * party; only its floor tile can be stood on. The rules of a blow are `combat.ts`'s;
 * this decides who is where and whose turn it is.
 */

import type { Character } from '../formats/character.js'
import type { Direction, GeoMap } from '../formats/geo.js'
import { buildArena, buildWildArena, type Arena } from './arena.js'
import { Combat, hits, rollDamage, type Combatant, type Random } from './combat.js'
import { cast, forget, ready } from './casting.js'
import { turnOne, UNDEAD } from './undead.js'

const WINDOW = 2

export type Tile = 'floor' | 'rock'

export interface Fighter {
  combatant: Combatant
  side: 'party' | 'monster'
  x: number
  y: number
  /** Squares left to move this turn. */
  moves: number
  /** True once the fighter has struck, shot or cast this turn. */
  acted: boolean
}

export interface Step { dx: number; dy: number }

const STEPS: Record<Direction, Step> = { north: { dx: 0, dy: -1 }, east: { dx: 1, dy: 0 }, south: { dx: 0, dy: 1 }, west: { dx: -1, dy: 0 } }
/** The eight ways a fighter can step, as the original allowed. */
export const EIGHT_STEPS: readonly Step[] = [
  { dx: 0, dy: -1 }, { dx: 1, dy: -1 }, { dx: 1, dy: 0 }, { dx: 1, dy: 1 },
  { dx: 0, dy: 1 }, { dx: -1, dy: 1 }, { dx: -1, dy: 0 }, { dx: -1, dy: -1 },
]

function standing(c: Character): boolean {
  return (c.status === 'okay' || c.status === 'asleep' || c.status === 'held') && c.hpCurrent > 0
}

function able(c: Character): boolean {
  return c.status === 'okay' && c.hpCurrent > 0
}

export class Battle {
  readonly arena: Arena
  readonly width: number
  readonly height: number
  readonly fighters: Fighter[] = []
  readonly combat: Combat
  round = 0
  private order: Fighter[] = []
  private turn = 0

  constructor(
    map: GeoMap,
    party: Combatant[],
    monsters: Combatant[],
    at: { row: number; col: number; facing: Direction },
    distance: number,
    private readonly random: Random,
    outdoors = false,
  ) {
    this.combat = new Combat(party, monsters, random)
    this.arena = outdoors ? buildWildArena(random) : buildArena(map, at, random)
    this.width = this.arena.width
    this.height = this.arena.height
    this.place(party, monsters, at, distance)
    this.startRound()
  }

  // ---- the map --------------------------------------------------------------

  /** What is at a square: the floor, or something nobody stands on. */
  tile(x: number, y: number): Tile {
    return this.arena.walkable(x, y) ? 'floor' : 'rock'
  }

  /** The DUNGCOM piece at a square, or -1 for nothing. */
  tileIndex(x: number, y: number): number {
    return this.arena.tile(x, y)
  }

  isSolid(x: number, y: number): boolean {
    return !this.arena.walkable(x, y)
  }

  blocked(x: number, y: number, dx: number, dy: number): boolean {
    return this.isSolid(x + dx, y + dy)
  }

  at(x: number, y: number): Fighter | undefined {
    return this.fighters.find((f) => f.x === x && f.y === y && standing(f.combatant.member.character))
  }

  private free(x: number, y: number): boolean {
    return !this.isSolid(x, y) && !this.at(x, y)
  }

  /** Puts the party on its square and the monsters ahead, as far off as they were seen. */
  private place(party: Combatant[], monsters: Combatant[], at: { facing: Direction }, distance: number): void {
    const ahead = STEPS[at.facing]
    const spots = (origin: { x: number; y: number }, count: number): { x: number; y: number }[] => {
      // Spread out from the origin through the floor, never across a wall, so the
      // party stands together in its own room.
      const found: { x: number; y: number }[] = []
      const seen = new Set<string>()
      const queue = [origin]
      seen.add(`${origin.x},${origin.y}`)
      while (queue.length > 0 && found.length < count) {
        const here = queue.shift()!
        if (this.free(here.x, here.y)) found.push(here)
        for (const step of EIGHT_STEPS) {
          const x = here.x + step.dx
          const y = here.y + step.dy
          const key = `${x},${y}`
          if (seen.has(key) || this.isSolid(x, y)) continue
          seen.add(key)
          queue.push({ x, y })
        }
      }
      return found
    }
    const middle = (pdx: number, pdy: number): { x: number; y: number } => {
      const p = this.arena.patch(pdx, pdy)
      return { x: p.x + 3, y: p.y + 3 }
    }

    const partyOrigin = middle(0, 0)
    for (const [i, spot] of spots(partyOrigin, party.length).entries()) {
      this.fighters.push({ combatant: party[i]!, side: 'party', ...spot, moves: 0, acted: false })
    }
    // The monsters stand in the square as far ahead as they were seen; nearer if that is rock.
    let monsterOrigin = partyOrigin
    for (let d = Math.min(WINDOW, distance + 1); d >= 1; d--) {
      const candidate = middle(ahead.dx * d, ahead.dy * d)
      if (spots(candidate, 1).length > 0) { monsterOrigin = candidate; break }
    }
    for (const [i, spot] of spots(monsterOrigin, monsters.length).entries()) {
      this.fighters.push({ combatant: monsters[i]!, side: 'monster', ...spot, moves: 0, acted: false })
    }
  }

  // ---- turns ----------------------------------------------------------------

  private startRound(): void {
    this.round++
    this.combat.round = this.round
    this.order = this.fighters
      .filter((f) => able(f.combatant.member.character))
      .map((f) => ({ f, initiative: this.random(9) + Math.floor(f.combatant.member.character.movement / 3) }))
      .sort((a, b) => b.initiative - a.initiative)
      .map((x) => x.f)
    for (const f of this.order) {
      f.moves = Math.max(1, Math.floor(f.combatant.member.character.movement / 2))
      f.acted = false
    }
    this.turn = 0
    this.combat.acted.clear()
  }

  get current(): Fighter | undefined {
    while (this.turn < this.order.length && !able(this.order[this.turn]!.combatant.member.character)) this.turn++
    return this.order[this.turn]
  }

  get over(): boolean {
    return this.combat.over
  }

  endTurn(): void {
    this.turn++
    if (this.turn >= this.order.length && !this.over) this.startRound()
  }

  // ---- actions ----------------------------------------------------------------

  canMove(f: Fighter, step: Step): boolean {
    if (Math.abs(step.dx) > 1 || Math.abs(step.dy) > 1 || (step.dx === 0 && step.dy === 0)) return false
    return f.moves > 0 && !this.blocked(f.x, f.y, step.dx, step.dy) && !this.at(f.x + step.dx, f.y + step.dy)
  }

  /**
   * The squares a fighter could reach this turn, with the first step toward each,
   * for walking to a clicked square.
   */
  reachable(f: Fighter): Map<string, Step[]> {
    const paths = new Map<string, Step[]>()
    const queue: { x: number; y: number; path: Step[] }[] = [{ x: f.x, y: f.y, path: [] }]
    paths.set(`${f.x},${f.y}`, [])
    while (queue.length > 0) {
      const here = queue.shift()!
      if (here.path.length >= f.moves) continue
      for (const step of EIGHT_STEPS) {
        const nx = here.x + step.dx
        const ny = here.y + step.dy
        const key = `${nx},${ny}`
        if (paths.has(key) || this.isSolid(nx, ny) || this.at(nx, ny)) continue
        const path = [...here.path, step]
        paths.set(key, path)
        queue.push({ x: nx, y: ny, path })
      }
    }
    paths.delete(`${f.x},${f.y}`)
    return paths
  }

  /** Walks a whole path, stopping if something now stands in the way. */
  walk(f: Fighter, path: readonly Step[]): number {
    let taken = 0
    for (const step of path) {
      if (!this.move(f, step)) break
      taken++
    }
    return taken
  }

  move(f: Fighter, step: Step): boolean {
    if (!this.canMove(f, step)) return false
    f.x += step.dx
    f.y += step.dy
    f.moves--
    return true
  }

  neighbours(f: Fighter): Fighter[] {
    const foes = this.fighters.filter((o) => o.side !== f.side && standing(o.combatant.member.character))
    return foes.filter((o) => Math.abs(o.x - f.x) <= 1 && Math.abs(o.y - f.y) <= 1)
  }

  /** Foes a missile can reach: within the weapon's range, and not hemmed in by a neighbour. */
  inRange(f: Fighter): Fighter[] {
    const range = f.combatant.member.character.attacks.range ?? 0
    if (range === 0 || this.neighbours(f).length > 0) return []
    return this.fighters.filter((o) => o.side !== f.side && standing(o.combatant.member.character)
      && Math.max(Math.abs(o.x - f.x), Math.abs(o.y - f.y)) <= range)
  }

  /** One blow, or a volley for the fighters with several: the rules of combat.ts. */
  attack(f: Fighter, target: Fighter): string[] {
    const lines: string[] = []
    const attacker = f.combatant.member.character
    const defender = target.combatant.member.character
    const helpless = defender.status === 'asleep' || defender.status === 'held'
    const attacks = Math.max(1, Math.round(attacker.attacks.count / 2))
    const ours = f.side === 'party'
    for (let i = 0; i < attacks && standing(defender); i++) {
      const roll = this.random(19) + 1 + this.combat.hitModifier(ours)
      if (!helpless && !hits(attacker, { ...defender, ac: this.combat.acOf(defender) }, roll)) {
        lines.push(`${f.combatant.label} MISSES ${target.combatant.label}.`)
        continue
      }
      const damage = rollDamage(attacker, this.random) * (helpless ? 2 : 1)
      const left = defender.hpCurrent - damage
      if (left > 0) {
        defender.hpCurrent = left
        if (defender.status === 'asleep') defender.status = 'okay'
        lines.push(`${f.combatant.label} HITS ${target.combatant.label} FOR ${damage}.`)
      } else {
        defender.hpCurrent = 0
        const dead = -left >= 10 || defender.race === 0 || helpless
        defender.status = dead ? 'dead' : 'unconscious'
        defender.statusByte = dead ? 6 : 4
        lines.push(`${f.combatant.label} HITS ${target.combatant.label} FOR ${damage}. ${target.combatant.label} IS ${defender.status.toUpperCase()}!`)
      }
    }
    f.acted = true
    f.moves = 0
    return lines
  }

  /** The animated dead still on their feet. */
  undead(): Fighter[] {
    return this.fighters.filter((o) => o.side === 'monster' && standing(o.combatant.member.character) && o.combatant.member.character.monsterType === UNDEAD)
  }

  /** A cleric turns: up to two dice of undead, nearest first, flee or crumble. */
  turnUndead(f: Fighter): string[] {
    const cleric = f.combatant.member.character
    const lines = [`${f.combatant.label} PRESENTS THE HOLY SYMBOL.`]
    let budget = this.random(5) + 1 + this.random(5) + 1
    const targets = this.undead().sort((a, b) => (Math.abs(a.x - f.x) + Math.abs(a.y - f.y)) - (Math.abs(b.x - f.x) + Math.abs(b.y - f.y)))
    for (const t of targets) {
      if (budget <= 0) break
      const c = t.combatant.member.character
      const result = turnOne(cleric, c, this.random)
      if (result === 'unmoved') { lines.push(`${t.combatant.label} IS UNMOVED.`); break }
      budget -= Math.max(1, c.hitDice)
      if (result === 'destroyed') {
        c.hpCurrent = 0
        c.status = 'dead'
        c.statusByte = 6
        lines.push(`${t.combatant.label} CRUMBLES TO DUST!`)
      } else {
        c.status = 'running'
        lines.push(`${t.combatant.label} FLEES!`)
      }
    }
    if (targets.length === 0) lines.push('NOTHING HERE FEARS IT.')
    f.acted = true
    f.moves = 0
    return lines
  }

  /**
   * A monster's turn: a spell if it has one worth casting, a shot if it carries a
   * bow and nobody is on it, otherwise close on the nearest of the party and strike.
   */
  monsterTurn(f: Fighter): string[] {
    const lines: string[] = []
    const me = f.combatant.member.character
    const target = (): Fighter | undefined => {
      const foes = this.fighters.filter((o) => o.side === 'party' && standing(o.combatant.member.character))
      return foes.sort((a, b) => (Math.abs(a.x - f.x) + Math.abs(a.y - f.y)) - (Math.abs(b.x - f.x) + Math.abs(b.y - f.y)))[0]
    }

    const spells = ready(me).filter((s) => s.target === 'foe' || s.target === 'foes')
    if (spells.length > 0) {
      const spell = spells[this.random(spells.length - 1)]!
      const foes = this.fighters.filter((o) => o.side === 'party' && able(o.combatant.member.character))
      const chosen = spell.target === 'foe' ? [target()].filter((t): t is Fighter => t !== undefined) : foes.slice(0, spell.effect.count ?? 99)
      if (chosen.length > 0) {
        forget(me, spell.id)
        lines.push(...cast(spell, me, chosen.map((t) => t.combatant.member.character), this.random, this.combat).lines)
        f.acted = true
        f.moves = 0
        return lines
      }
    }

    const far = this.inRange(f)
    if (far.length > 0) {
      lines.push(...this.attack(f, far[this.random(far.length - 1)]!))
      return lines
    }

    for (let step = 0; step < 20; step++) {
      const near = this.neighbours(f)
      if (near.length > 0) {
        lines.push(...this.attack(f, near[this.random(near.length - 1)]!))
        break
      }
      const goal = target()
      if (!goal || f.moves === 0) break
      const next = this.stepToward(f, goal)
      if (!next || !this.move(f, next)) break
    }
    return lines
  }

  /** First step of a shortest path to a square next to the goal, or nothing. */
  private stepToward(f: Fighter, goal: Fighter): Step | undefined {
    const key = (x: number, y: number) => `${x},${y}`
    const from = new Map<string, Step | null>()
    const queue: { x: number; y: number }[] = [{ x: f.x, y: f.y }]
    from.set(key(f.x, f.y), null)
    const steps = EIGHT_STEPS
    while (queue.length > 0) {
      const here = queue.shift()!
      if (Math.abs(here.x - goal.x) <= 1 && Math.abs(here.y - goal.y) <= 1 && (here.x !== f.x || here.y !== f.y)) {
        let cursor = here
        let first: Step | undefined
        for (;;) {
          const prev = from.get(key(cursor.x, cursor.y))
          if (!prev) break
          first = prev
          cursor = { x: cursor.x - prev.dx, y: cursor.y - prev.dy }
        }
        return first
      }
      for (const step of steps) {
        const nx = here.x + step.dx
        const ny = here.y + step.dy
        if (from.has(key(nx, ny)) || this.blocked(here.x, here.y, step.dx, step.dy) || this.at(nx, ny)) continue
        from.set(key(nx, ny), step)
        queue.push({ x: nx, y: ny })
      }
    }
    return undefined
  }
}

export { STEPS as BATTLE_STEPS }
