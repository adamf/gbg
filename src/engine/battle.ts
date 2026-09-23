/**
 * The tactical fight: a grid built from the dungeon around the party, turns in
 * initiative order with movement points, blows against neighbours, missiles down
 * the lines, and monsters that close in.
 *
 * The arena is the original's, built by `arena.ts` from the dungeon around the
 * party; only its floor tile can be stood on. The rules of a blow are `combat.ts`'s;
 * this decides who is where and whose turn it is.
 */

import type { Spell } from '../formats/spells.js'
import type { Character } from '../formats/character.js'
import type { Direction, GeoMap } from '../formats/geo.js'
import { buildArena, buildWildArena, type Arena } from './arena.js'
import { Combat, hits, monsterKind, rollDamage, saves, takeDamage, targetable, type Combatant, type Random } from './combat.js'
import { cast, casterLevel, forget, ready } from './casting.js'
import { turnOne, UNDEAD } from './undead.js'
import { SPRITE } from './sprites.js'
import { spendMissile } from './burden.js'
import { refit } from './burden.js'
import type { ItemType } from '../formats/items.js'

const WINDOW = 2

export type Tile = 'floor' | 'rock'

export interface Fighter {
  combatant: Combatant
  side: 'party' | 'monster'
  x: number
  y: number
  /** Which way the fighter faces: the way it last moved or struck. */
  facing: Step
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

/**
 * What just happened on the grid, for the screen to show before the words: a blow,
 * a shot, a spell. The engine records them; the view plays them and empties the list.
 */
export type EffectShape = 'lunge' | 'arrow' | 'streak' | 'burst' | 'bolt' | 'sparkle' | 'glow'
export interface BattleEffect {
  shape: EffectShape
  from: { x: number; y: number }
  to: { x: number; y: number }[]
  /** For blows and shots: whether anything landed. */
  hit?: boolean
  /** An EGA palette index for the spell's light. */
  colour?: number
  /** A COMSPR block to fly or flash, when the original had art for it. */
  sprite?: number
}

export class Battle {
  readonly effects: BattleEffect[] = []

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
    const spots = (origin: { x: number; y: number }, count: number, within?: Map<string, number>): { x: number; y: number }[] => {
      // Spread out from the origin through the floor, never across a wall, so the
      // party stands together in its own room.
      const found: { x: number; y: number }[] = []
      const seen = new Set<string>()
      const queue = [origin]
      seen.add(`${origin.x},${origin.y}`)
      while (queue.length > 0 && found.length < count) {
        const here = queue.shift()!
        if (this.free(here.x, here.y) && (!within || within.has(`${here.x},${here.y}`))) found.push(here)
        for (const step of EIGHT_STEPS) {
          const x = here.x + step.dx
          const y = here.y + step.dy
          const key = `${x},${y}`
          if (seen.has(key) || this.isSolid(x, y) || (within && !within.has(key))) continue
          seen.add(key)
          queue.push({ x, y })
        }
      }
      return found
    }
    // The nearest floor to a point: a square's middle can land on a wall piece, and
    // a search that starts inside a wall would leak through to the other side of it.
    const nearestFloor = (origin: { x: number; y: number }): { x: number; y: number } => {
      const seen = new Set<string>([`${origin.x},${origin.y}`])
      const queue = [origin]
      while (queue.length > 0) {
        const here = queue.shift()!
        if (!this.isSolid(here.x, here.y)) return here
        for (const step of EIGHT_STEPS) {
          const x = here.x + step.dx
          const y = here.y + step.dy
          if (x < 0 || y < 0 || x >= this.width || y >= this.height || seen.has(`${x},${y}`)) continue
          seen.add(`${x},${y}`)
          queue.push({ x, y })
        }
      }
      return origin
    }
    const middle = (pdx: number, pdy: number): { x: number; y: number } => {
      const p = this.arena.patch(pdx, pdy)
      return nearestFloor({ x: p.x + 3, y: p.y + 3 })
    }

    const partyOrigin = middle(0, 0)
    for (const [i, spot] of spots(partyOrigin, party.length).entries()) {
      this.fighters.push({ combatant: party[i]!, side: 'party', ...spot, facing: { ...ahead }, moves: 0, acted: false })
    }
    // Everything the party can walk to, with how far it is: the monsters must stand
    // somewhere in here, or the two sides would never meet.
    const region = new Map<string, number>()
    let farthest = partyOrigin
    {
      const queue = [partyOrigin]
      region.set(`${partyOrigin.x},${partyOrigin.y}`, 0)
      while (queue.length > 0) {
        const here = queue.shift()!
        const far = region.get(`${here.x},${here.y}`)!
        if (far > region.get(`${farthest.x},${farthest.y}`)!) farthest = here
        for (const step of EIGHT_STEPS) {
          const x = here.x + step.dx
          const y = here.y + step.dy
          if (region.has(`${x},${y}`) || this.isSolid(x, y)) continue
          region.set(`${x},${y}`, far + 1)
          queue.push({ x, y })
        }
      }
    }
    // The nearest floor to a point that the party can reach: a square's middle may
    // sit on a wall band whose nearest floor is on the far side of it.
    const nearestReachable = (origin: { x: number; y: number }): { x: number; y: number } | undefined => {
      const seen = new Set<string>([`${origin.x},${origin.y}`])
      const queue = [origin]
      let looked = 0
      while (queue.length > 0 && looked++ < 400) {
        const here = queue.shift()!
        if (region.has(`${here.x},${here.y}`) && this.free(here.x, here.y)) return here
        for (const step of EIGHT_STEPS) {
          const x = here.x + step.dx
          const y = here.y + step.dy
          if (x < 0 || y < 0 || x >= this.width || y >= this.height || seen.has(`${x},${y}`)) continue
          seen.add(`${x},${y}`)
          queue.push({ x, y })
        }
      }
      return undefined
    }
    // The monsters stand in the square as far ahead as they were seen; nearer if that
    // is rock or walled off. If nothing ahead connects, they come from the far end.
    let monsterOrigin = farthest
    for (let d = Math.min(WINDOW, Math.max(1, distance)); d >= 1; d--) {
      const p = this.arena.patch(ahead.dx * d, ahead.dy * d)
      const candidate = nearestReachable({ x: p.x + 3, y: p.y + 3 })
      if (candidate && Math.abs(candidate.x - (p.x + 3)) + Math.abs(candidate.y - (p.y + 3)) <= 8) { monsterOrigin = candidate; break }
    }
    for (const [i, spot] of spots(monsterOrigin, monsters.length, region).entries()) {
      this.fighters.push({ combatant: monsters[i]!, side: 'monster', ...spot, facing: { dx: -ahead.dx, dy: -ahead.dy }, moves: 0, acted: false })
    }
  }

  // ---- turns ----------------------------------------------------------------

  /** Rounds in a row in which nobody on either side struck, moved or cast. */
  idleRounds = 0
  private readonly moraleChecked = new Set<Character>()
  private actedThisRound = false

  /** Three empty rounds: the two sides cannot get at each other. */
  get stalled(): boolean {
    return this.idleRounds >= 3
  }

  private startRound(): void {
    this.round++
    this.combat.round = this.round
    this.combat.stir()
    if (this.round > 1) this.idleRounds = this.actedThisRound ? 0 : this.idleRounds + 1
    this.actedThisRound = false
    this.roundLines = this.round > 1 ? this.passOfTime() : []
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

  /** What the turn of a round did on its own: the bleeding, the trolls. Read once. */
  roundLines: string[] = []

  /**
   * The dying lose a point a round and die at minus ten. A downed troll mends
   * three points a round and gets up whole, unless it was burnt or somebody is
   * standing on it; a troll on its feet mends the same.
   */
  private passOfTime(): string[] {
    const lines: string[] = []
    for (const f of this.fighters) {
      const c = f.combatant.member.character
      if (c.status === 'dying') {
        c.hpCurrent--
        if (c.hpCurrent <= -10) { c.status = 'dead'; c.statusByte = 6; c.hpCurrent = 0; lines.push(`${f.combatant.label} HAS DIED.`) }
        continue
      }
      // Morale: a monster badly hurt, or in a group half down, may break and run.
      if (c.race === 0 && c.status === 'okay' && !this.moraleChecked.has(c)) {
        const group = this.fighters.filter((o) => o.side === 'monster')
        const down = group.filter((o) => !standing(o.combatant.member.character)).length
        if (c.hpCurrent * 2 < c.hpMax || down * 2 >= group.length) {
          this.moraleChecked.add(c)
          const hold = c.control > 0 ? c.control : 12
          if (this.random(19) + 1 > hold) { c.status = 'running'; c.statusByte = 3; lines.push(`${f.combatant.label} FLEES!`); continue }
        }
      }
      if (c.race === 0 && monsterKind(c) === 'troll' && !c.burnt) {
        if (c.status === 'okay' && c.hpCurrent < c.hpMax) c.hpCurrent = Math.min(c.hpMax, c.hpCurrent + 3)
        else if (c.status === 'unconscious') {
          const pinned = this.fighters.some((o) => o !== f && o.x === f.x && o.y === f.y && standing(o.combatant.member.character))
          if (pinned) continue
          c.hpCurrent = Math.min(c.hpMax, c.hpCurrent + 3)
          if (c.hpCurrent >= c.hpMax) { c.status = 'okay'; c.statusByte = 0; lines.push(`${f.combatant.label} RISES AGAIN!`) }
        }
      }
    }
    return lines
  }

  get current(): Fighter | undefined {
    while (this.turn < this.order.length && !able(this.order[this.turn]!.combatant.member.character)) this.turn++
    return this.order[this.turn]
  }

  get over(): boolean {
    return this.combat.over
  }

  endTurn(): void {
    // Whatever the screen did not play is stale by now.
    this.effects.length = 0
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
    f.facing = { dx: step.dx, dy: step.dy }
    f.moves--
    this.actedThisRound = true
    // The field's edge is the way out: a party member who reaches it has run.
    if (f.side === 'party' && (f.x === 0 || f.y === 0 || f.x === this.width - 1 || f.y === this.height - 1)) {
      f.combatant.member.character.status = 'running'
      f.combatant.member.character.statusByte = 3
      f.moves = 0
      f.acted = true
    }
    return true
  }

  neighbours(f: Fighter): Fighter[] {
    const foes = this.fighters.filter((o) => o.side !== f.side && targetable(o.combatant))
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
    this.actedThisRound = true
    const melee = this.neighbours(f).includes(target)
    const effect: BattleEffect = { shape: melee ? 'lunge' : 'arrow', from: { x: f.x, y: f.y }, to: [{ x: target.x, y: target.y }], hit: false, sprite: melee ? undefined : f.combatant.member.character.attacks.missile ?? SPRITE.arrowUp }
    this.effects.push(effect)
    const attacker = f.combatant.member.character
    const defender = target.combatant.member.character
    const helpless = defender.status === 'asleep' || defender.status === 'held'
    const attacks = this.combat.attacksOf(attacker)
    const ours = f.side === 'party'
    f.facing = { dx: Math.sign(target.x - f.x), dy: Math.sign(target.y - f.y) }
    // From behind: the target's rear armour class, a bonus to hit, and a thief's backstab.
    const behind = (f.x - target.x) * target.facing.dx + (f.y - target.y) * target.facing.dy < 0
    const backstab = behind && melee && (attacker.levels[6] ?? 0) > 0
    if (behind) lines.push(`${f.combatant.label} STRIKES FROM BEHIND${backstab ? ' — A BACKSTAB' : ''}!`)
    if (!melee && this.combat.has(defender, 'missileProof')) {
      f.acted = true
      f.moves = 0
      return [`THE MISSILE GLANCES OFF ${target.combatant.label}.`]
    }
    for (let i = 0; i < attacks && targetable(target.combatant); i++) {
      const roll = this.random(19) + 1 + this.combat.hitBonusOf(attacker) + (behind ? 2 : 0) + (backstab ? 2 : 0)
      const ac = behind ? this.combat.acOf(defender) + (defender.acBehind - defender.ac) : this.combat.acOf(defender)
      if (!helpless && !hits(attacker, { ...defender, ac }, roll)) {
        lines.push(`${f.combatant.label} MISSES ${target.combatant.label}.`)
        continue
      }
      const damage = Math.max(1, rollDamage(attacker, this.random) + this.combat.damageBonusOf(attacker)) * (helpless ? 2 : 1) * (backstab && i === 0 ? 2 : 1)
      effect.hit = true
      const fire = attacker.attacks.missile === SPRITE.flask
      const result = takeDamage(defender, damage, fire)
      lines.push(`${f.combatant.label} HITS ${target.combatant.label} FOR ${damage}.${result === 'hurt' ? '' : ` ${target.combatant.label} IS ${result.toUpperCase()}!`}`)
      if (result === 'hurt' && !ours) lines.push(...this.specialAttack(attacker, target))
    }
    // A fighter sweeps: one blow at every other small creature within reach.
    if (melee && defender.hitDice < 1 && fighterLevel(attacker) > 0) {
      for (const other of this.neighbours(f)) {
        if (other === target || other.combatant.member.character.hitDice >= 1) continue
        const roll = this.random(19) + 1 + this.combat.hitBonusOf(attacker)
        const c = other.combatant.member.character
        if (!hits(attacker, { ...c, ac: this.combat.acOf(c) }, roll)) { lines.push(`${f.combatant.label} SWEEPS AT ${other.combatant.label} AND MISSES.`); continue }
        const damage = rollDamage(attacker, this.random)
        const result = takeDamage(c, damage)
        lines.push(`${f.combatant.label} SWEEPS ${other.combatant.label} FOR ${damage}.${result === 'hurt' ? '' : ` ${other.combatant.label} IS ${result.toUpperCase()}!`}`)
      }
    }
    if (!melee && this.types) {
      const out = spendMissile(f.combatant.member.items, this.types)
      if (out) { lines.push(out); refit(attacker, f.combatant.member.items, this.types) }
    }
    f.acted = true
    f.moves = 0
    return lines
  }

  /** The item type table, when the session hands it over, for spending ammunition. */
  types: readonly ItemType[] | undefined

  /**
   * What a monster's touch does beyond the wound, by its kind: a ghoul's paralysis,
   * a spider's poison, a wight's drain. Each allows the save the manual names; the
   * kinds are read off the monster's name, since the records do not say.
   */
  private specialAttack(attacker: Character, target: Fighter): string[] {
    const victim = target.combatant.member.character
    if (victim.race === 0) return []
    switch (monsterKind(attacker)) {
      case 'ghoul':
        if (saves(victim, 0, this.random)) return []
        victim.status = 'held'
        victim.statusByte = 0
        return [`${target.combatant.label} IS PARALYZED!`]
      case 'poisoner':
        if (saves(victim, 0, this.random)) return []
        victim.status = 'dead'
        victim.statusByte = 6
        victim.hpCurrent = 0
        victim.poisoned = true
        return [`${target.combatant.label} IS POISONED AND DIES!`]
      case 'petrifier':
        // The gaze: a save against petrification or the victim is stone until a temple sees to it.
        if (saves(victim, 1, this.random)) return []
        victim.status = 'stoned'
        victim.statusByte = 7
        victim.hpCurrent = 0
        return [`${target.combatant.label} IS TURNED TO STONE!`]
      case 'drainer': {
        const index = victim.levels.findIndex((l) => l > 0)
        if (index < 0) return []
        const level = victim.levels[index]!
        if (level <= 1) { victim.status = 'dead'; victim.statusByte = 6; victim.hpCurrent = 0; return [`${target.combatant.label} IS DRAINED OF LIFE!`] }
        victim.levels[index] = level - 1
        victim.drained = (victim.drained ?? 0) + 1
        const lost = Math.max(1, Math.floor(victim.hpMax / level))
        victim.hpMax -= lost
        victim.hpCurrent = Math.min(victim.hpCurrent, victim.hpMax)
        victim.experience = Math.floor(victim.experience / 2)
        return [`${target.combatant.label} LOSES A LEVEL!`]
      }
      default:
        return []
    }
  }

  /** A round spent stopping an ally's bleeding: dying becomes unconscious. */
  bandage(f: Fighter, target: Fighter): string[] {
    const c = target.combatant.member.character
    if (c.status !== 'dying') return []
    c.status = 'unconscious'
    c.statusByte = 4
    c.hpCurrent = 0
    f.acted = true
    f.moves = 0
    this.actedThisRound = true
    return [`${f.combatant.label} BANDAGES ${target.combatant.label}.`]
  }

  /** Allies next to this fighter who are bleeding. */
  dyingNeighbours(f: Fighter): Fighter[] {
    return this.fighters.filter((o) => o !== f && o.side === f.side && o.combatant.member.character.status === 'dying'
      && Math.abs(o.x - f.x) <= 1 && Math.abs(o.y - f.y) <= 1)
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
    return this.autoTurn(f)
  }

  /** The same for either side — what a party member does when the computer plays them. */
  autoTurn(f: Fighter): string[] {
    const lines: string[] = []
    const me = f.combatant.member.character
    const target = (): Fighter | undefined => {
      const foes = this.fighters.filter((o) => o.side !== f.side && standing(o.combatant.member.character))
      return foes.sort((a, b) => (Math.abs(a.x - f.x) + Math.abs(a.y - f.y)) - (Math.abs(b.x - f.x) + Math.abs(b.y - f.y)))[0]
    }

    // A cleric facing undead presents the holy symbol before anything else: the
    // computer plays its clerics the way a player would in a graveyard.
    if ((me.levels[0] ?? 0) > 0 && this.undead().length > 0 && !f.acted) {
      this.actedThisRound = true
      return this.turnUndead(f)
    }
    // A spell that nothing here would feel is not cast: no sleep over eighth-level
    // guards, no hold over foes already held.
    const foesUp = this.fighters.filter((o) => o.side !== f.side && standing(o.combatant.member.character))
    const worthCasting = (s: Spell): boolean => {
      const e = s.effect
      if (e.kind === 'sleep') return foesUp.some((o) => o.combatant.member.character.status === 'okay' && o.combatant.member.character.hitDice <= (e.maxHitDice ?? 4))
      if (e.kind === 'hold') return foesUp.some((o) => o.combatant.member.character.status === 'okay')
      return true
    }
    const spells = this.combat.has(me, 'silence') ? [] : ready(me).filter((s) => (s.target === 'foe' || s.target === 'foes') && worthCasting(s))
    if (spells.length > 0) {
      // The spell worth most against what stands here: a fireball over a crowd before a
      // magic missile at one of them, a hold before a curse.
      const level = Math.max(casterLevel(me, 'cleric'), casterLevel(me, 'magic-user'), 1)
      const worth = (sp: Spell): number => {
        const e = sp.effect
        const n = sp.target === 'foes' ? Math.min(e.count ?? 99, foesUp.length) : 1
        const avg = (dice: number, sides: number) => (dice * (sides + 1)) / 2
        if (e.kind === 'damage' || e.kind === 'harm') return (avg(e.dice ?? 0, e.sides ?? 1) + (e.bonus ?? 0) + avg((e.perLevel ?? 0) * level, e.sides ?? 1)) * n * (sp.target === 'foes' ? 0.75 : 1)
        if (e.kind === 'hold') return 6 * n
        if (e.kind === 'sleep') return 5 * Math.min(5, foesUp.length)
        return 2
      }
      const best = Math.max(...spells.map(worth))
      const top = spells.filter((sp) => worth(sp) >= best - 0.01)
      const spell = top[this.random(top.length - 1)]!
      const foes = this.fighters.filter((o) => o.side !== f.side && able(o.combatant.member.character))
      const chosen = spell.target === 'foe' ? [target()].filter((t): t is Fighter => t !== undefined) : foes.slice(0, spell.effect.count ?? 99)
      if (chosen.length > 0) {
        forget(me, spell.id)
        this.recordSpell(spell, f, chosen)
        lines.push(...cast(spell, me, chosen.map((t) => t.combatant.member.character), this.random, this.combat).lines)
        this.actedThisRound = true
        f.acted = true
        f.moves = 0
        return lines
      }
    }

    // The helpless first: a held or sleeping foe is hit without fail for double, and
    // wakes to fight again if left.
    const pick = (among: Fighter[]): Fighter => {
      const helpless = among.filter((o) => o.combatant.member.character.status === 'asleep' || o.combatant.member.character.status === 'held')
      const pool = helpless.length > 0 ? helpless : among
      return pool[this.random(pool.length - 1)]!
    }
    const far = this.inRange(f)
    if (far.length > 0) {
      lines.push(...this.attack(f, pick(far)))
      return lines
    }

    for (let step = 0; step < 20; step++) {
      const near = this.neighbours(f)
      if (near.length > 0) {
        lines.push(...this.attack(f, pick(near)))
        break
      }
      if (f.moves === 0) break
      // Toward the nearest foe that can still be reached; failing that, any step that
      // closes the distance, so a crowd in a corridor keeps shuffling forward.
      const foes = this.fighters
        .filter((o) => o.side !== f.side && standing(o.combatant.member.character))
        .sort((a, b) => (Math.abs(a.x - f.x) + Math.abs(a.y - f.y)) - (Math.abs(b.x - f.x) + Math.abs(b.y - f.y)))
      let next: Step | undefined
      for (const goal of foes.slice(0, 6)) {
        next = this.stepToward(f, goal)
        if (next) break
      }
      if (!next && foes[0]) {
        const goal = foes[0]
        const before = Math.max(Math.abs(goal.x - f.x), Math.abs(goal.y - f.y))
        next = EIGHT_STEPS.filter((s) => this.canMove(f, s))
          .find((s) => Math.max(Math.abs(goal.x - f.x - s.dx), Math.abs(goal.y - f.y - s.dy)) < before)
      }
      if (!next || !this.move(f, next)) break
    }
    return lines
  }

  /** The fighter standing for a character, if they are in this fight. */
  fighterOf(character: Character): Fighter | undefined {
    return this.fighters.find((f) => f.combatant.member.character === character)
  }

  /** Notes a spell for the screen: its shape and colour by what it does. */
  recordSpell(spell: Spell, caster: Fighter, targets: readonly Fighter[]): void {
    const kind = spell.effect.kind
    const name = spell.name.toLowerCase()
    let shape: EffectShape = 'glow'
    let colour = 15
    let sprite: number | undefined
    if (kind === 'damage' || kind === 'harm') {
      if (name.includes('lightning')) { shape = 'bolt'; colour = 11; sprite = SPRITE.lightning }
      else if (spell.target === 'foes') { shape = 'burst'; colour = name.includes('fire') || name.includes('burning') ? 14 : 13; sprite = SPRITE.burst }
      else { shape = 'streak'; colour = name.includes('missile') ? 11 : 12; sprite = name.includes('missile') ? SPRITE.sparkles : undefined }
    } else if (kind === 'sleep' || kind === 'hold') { shape = 'sparkle'; colour = 13; sprite = SPRITE.sparkles }
    else if (kind === 'heal') { shape = 'sparkle'; colour = 10; sprite = SPRITE.sparkles }
    else if (kind === 'curse') { shape = 'glow'; colour = 12 }
    else if (kind === 'bless' || kind === 'shield') { shape = 'glow'; colour = 14 }
    this.effects.push({ shape, colour, sprite, from: { x: caster.x, y: caster.y }, to: targets.map((t) => ({ x: t.x, y: t.y })) })
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

function fighterLevel(c: Character): number {
  return Math.max(c.levels[2] ?? 0, c.levels[3] ?? 0, c.levels[4] ?? 0)
}

export { STEPS as BATTLE_STEPS }
