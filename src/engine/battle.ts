/**
 * The tactical fight: a grid built from the dungeon around the party, turns in
 * initiative order with movement points, blows against neighbours, missiles down
 * the lines, and monsters that close in.
 *
 * Every dungeon square becomes a 2×2 patch of the battle map and its walls become
 * edges nobody crosses, so a fight in a corridor is fought in that corridor. The
 * rules of a blow are `combat.ts`'s; this decides who is where and whose turn it is.
 */

import type { Character } from '../formats/character.js'
import { canWalk, cellAt, DIRECTIONS, type Direction, type GeoMap } from '../formats/geo.js'
import { Combat, hits, rollDamage, type Combatant, type Random } from './combat.js'
import { isSolid } from './dungeon.js'

export const CELL_SPAN = 2
const WINDOW = 3

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

function standing(c: Character): boolean {
  return (c.status === 'okay' || c.status === 'asleep' || c.status === 'held') && c.hpCurrent > 0
}

function able(c: Character): boolean {
  return c.status === 'okay' && c.hpCurrent > 0
}

export class Battle {
  readonly width = (WINDOW * 2 + 1) * CELL_SPAN
  readonly height = (WINDOW * 2 + 1) * CELL_SPAN
  /** Edges that cannot be crossed, as "x,y,dir" from the square being left. */
  private readonly walls = new Set<string>()
  /** Squares outside the level, or inside rock. */
  private readonly solid = new Set<string>()
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
  ) {
    this.combat = new Combat(party, monsters, random)
    this.build(map, at)
    this.place(party, monsters, at, distance)
    this.startRound()
  }

  // ---- the map --------------------------------------------------------------

  private originRow = 0
  private originCol = 0

  private build(map: GeoMap, at: { row: number; col: number }): void {
    this.originRow = at.row - WINDOW
    this.originCol = at.col - WINDOW
    for (let r = 0; r <= WINDOW * 2; r++) {
      for (let c = 0; c <= WINDOW * 2; c++) {
        const row = this.originRow + r
        const col = this.originCol + c
        const cell = cellAt(map, row, col)
        const rock = !cell || isSolid(cell)
        for (let j = 0; j < CELL_SPAN; j++) {
          for (let i = 0; i < CELL_SPAN; i++) {
            const x = c * CELL_SPAN + i
            const y = r * CELL_SPAN + j
            if (rock) { this.solid.add(`${x},${y}`); continue }
            // The edges of the patch that face another dungeon square.
            for (const direction of DIRECTIONS) {
              const step = STEPS[direction]
              const edge = (direction === 'north' && j === 0) || (direction === 'south' && j === CELL_SPAN - 1)
                || (direction === 'west' && i === 0) || (direction === 'east' && i === CELL_SPAN - 1)
              if (edge && !canWalk(map, row, col, direction)) this.walls.add(`${x},${y},${step.dx},${step.dy}`)
            }
          }
        }
      }
    }
  }

  blocked(x: number, y: number, dx: number, dy: number): boolean {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || ny < 0 || nx >= this.width || ny >= this.height) return true
    if (this.solid.has(`${nx},${ny}`)) return true
    if (this.walls.has(`${x},${y},${dx},${dy}`)) return true
    // The far side's own wall, when the two disagree.
    if (this.walls.has(`${nx},${ny},${-dx},${-dy}`)) return true
    return false
  }

  isSolid(x: number, y: number): boolean {
    return this.solid.has(`${x},${y}`)
  }

  hasWall(x: number, y: number, dx: number, dy: number): boolean {
    return this.walls.has(`${x},${y},${dx},${dy}`)
  }

  at(x: number, y: number): Fighter | undefined {
    return this.fighters.find((f) => f.x === x && f.y === y && standing(f.combatant.member.character))
  }

  private free(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height && !this.solid.has(`${x},${y}`) && !this.at(x, y)
  }

  /** Puts the party on its square and the monsters ahead, as far off as they were seen. */
  private place(party: Combatant[], monsters: Combatant[], at: { facing: Direction }, distance: number): void {
    const centre = WINDOW * CELL_SPAN
    const ahead = STEPS[at.facing]
    const side = { dx: -ahead.dy, dy: ahead.dx }
    const spots = (origin: { x: number; y: number }, count: number): { x: number; y: number }[] => {
      // Ring outward from the origin until everyone has a square.
      const found: { x: number; y: number }[] = []
      for (let radius = 0; radius < this.width && found.length < count; radius++) {
        for (let dy = -radius; dy <= radius && found.length < count; dy++) {
          for (let dx = -radius; dx <= radius && found.length < count; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
            const x = origin.x + dx
            const y = origin.y + dy
            if (this.free(x, y) && !found.some((s) => s.x === x && s.y === y)) found.push({ x, y })
          }
        }
      }
      return found
    }

    const partyOrigin = { x: centre, y: centre }
    for (const [i, spot] of spots(partyOrigin, party.length).entries()) {
      this.fighters.push({ combatant: party[i]!, side: 'party', ...spot, moves: 0, acted: false })
    }
    const away = (distance + 1) * CELL_SPAN
    let monsterOrigin = { x: centre + ahead.dx * away + side.dx, y: centre + ahead.dy * away + side.dy }
    if (this.solid.has(`${monsterOrigin.x},${monsterOrigin.y}`)) monsterOrigin = { x: centre + ahead.dx * CELL_SPAN, y: centre + ahead.dy * CELL_SPAN }
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
    return f.moves > 0 && !this.blocked(f.x, f.y, step.dx, step.dy) && !this.at(f.x + step.dx, f.y + step.dy)
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
    return foes.filter((o) => Math.abs(o.x - f.x) <= 1 && Math.abs(o.y - f.y) <= 1 && !this.blocked(f.x, f.y, Math.sign(o.x - f.x), Math.sign(o.y - f.y)))
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

  /** A monster's turn: close on the nearest of the party and strike if it can. */
  monsterTurn(f: Fighter): string[] {
    const lines: string[] = []
    const target = (): Fighter | undefined => {
      const foes = this.fighters.filter((o) => o.side === 'party' && standing(o.combatant.member.character))
      return foes.sort((a, b) => (Math.abs(a.x - f.x) + Math.abs(a.y - f.y)) - (Math.abs(b.x - f.x) + Math.abs(b.y - f.y)))[0]
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
    const steps = Object.values(STEPS)
    while (queue.length > 0) {
      const here = queue.shift()!
      if (Math.abs(here.x - goal.x) <= 1 && Math.abs(here.y - goal.y) <= 1 && (here.x !== f.x || here.y !== f.y)) {
        // Walk back to the first step.
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
