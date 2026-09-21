/**
 * The combat map, laid out the way the original laid it out.
 *
 * A port of the routines the game ran before a fight (`SetupGroundTiles` and what it
 * calls, in the coab disassembly of the engine): a 50×25 grid of ids into a table of
 * background tiles, each id naming an art cell and a cost to walk on it. Underground
 * the grid is filled from the thirteen-by-five dungeon squares around the party.
 * Each square is a patch six wide and five tall, and every dungeon row sits five
 * columns further right than the row above, which is what makes north–south walls
 * run as diagonals. The north wall of a square is two rows of pieces, the west wall
 * a three-wide diagonal band of three, the corners between are chosen by what the
 * neighbouring squares have, and a room flagged for it may get a table and chairs.
 * Outdoors the grid is open ground with a river, clearings and scenery rolled onto
 * it. Anything with a move cost of 255 cannot be stood on.
 */

import { cellAt, type Direction, type GeoMap } from '../formats/geo.js'

export const ARENA_WIDTH = 50
export const ARENA_HEIGHT = 25
/** The DUNGCOM piece that is bare floor, and the table's id. */
export const FLOOR = 22
const TABLE_ID = 0x1a
const CHAIR_ID = 0x1b
const CELL_W = 6
const CELL_H = 5
/** Where the random-decoration set's cells begin in the art. */
export const RANDOM_CELLS = 0x22

/**
 * The original's background tile table, by id (ids are one-based; 0 is nothing).
 * Each entry is the cost to walk onto it (255: never) and the art cell it draws.
 * Ids 1–25 are the dungeon set, 26–31 the random decorations, 32 on the wilderness.
 */
const COST = [
  0,
  0xff, 0xff, 0xff, 0xff, 1, 0xff, 0xff, 0xff, 1, 0xff, 1, 0xff, 1, 0xff, 1, 0xff, 1, 0xff, 0xff, 0xff, 0xff, 0xff, 1, 1, 0xff,
  2, 1, 1, 1, 1, 1,
  0xff, 0xff, 0xff, 0xff, 0xff, 1, 1, 1, 1, 1, 0xff, 0xff, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 2, 2, 4, 4, 4, 4, 1, 1,
]
const CELL = [
  0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
  0x22, 0x23, 0x24, 0x25, 0x26, 0x27,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
]

export type Random = (max: number) => number

/** Rolls `count` dice of `sides`, as the original's roll_dice. */
function dice(random: Random, sides: number, count: number): number {
  let total = 0
  for (let i = 0; i < count; i++) total += random(sides - 1) + 1
  return total
}

type SideFlag = 0 | 1 | 3

const DELTA: Record<Direction, { dr: number; dc: number }> = {
  north: { dr: -1, dc: 0 }, east: { dr: 0, dc: 1 }, south: { dr: 1, dc: 0 }, west: { dr: 0, dc: -1 },
}
const OPPOSITE: Record<Direction, Direction> = { north: 'south', east: 'west', south: 'north', west: 'east' }

export interface Arena {
  width: number
  height: number
  /** Background tile id per square; zero is nothing at all. */
  tiles: Uint8Array
  /** The art cell to draw at a square, or -1 for nothing. */
  tile(x: number, y: number): number
  walkable(x: number, y: number): boolean
  /** Top-left arena square of the dungeon square at (dx, dy) from the party. */
  patch(dx: number, dy: number): { x: number; y: number }
}

function wrap(tiles: Uint8Array): Arena {
  const id = (x: number, y: number): number => (x < 0 || y < 0 || x >= ARENA_WIDTH || y >= ARENA_HEIGHT ? 0 : tiles[y * ARENA_WIDTH + x]!)
  return {
    width: ARENA_WIDTH,
    height: ARENA_HEIGHT,
    tiles,
    tile(x, y) {
      const at = id(x, y)
      return at === 0 ? -1 : CELL[at] ?? -1
    },
    walkable(x, y) {
      const at = id(x, y)
      return at !== 0 && (COST[at] ?? 0xff) !== 0xff
    },
    patch(pdx, pdy) {
      return { x: pdx * CELL_W + pdy * CELL_H + 21, y: pdy * CELL_H + 10 }
    },
  }
}

/** Underground: the squares around the party, wall by wall. */
export function buildArena(map: GeoMap, at: { row: number; col: number }, random: Random = () => 0): Arena {
  const tiles = new Uint8Array(ARENA_WIDTH * ARENA_HEIGHT)
  const idAt = (x: number, y: number): number => (x < 0 || y < 0 || x >= ARENA_WIDTH || y >= ARENA_HEIGHT ? 0 : tiles[y * ARENA_WIDTH + x]!)

  const own = (direction: Direction, row: number, col: number): SideFlag => {
    const cell = cellAt(map, row, col)
    if (!cell) {
      // Off the map is rock, except sideways along the party's own row, which runs on.
      return row === at.row && (direction === 'east' || direction === 'west') ? 0 : 1
    }
    const wall = cell.walls[direction]
    const door = cell.doors[direction]
    if (wall !== 0 && door === 0) return 1
    return wall === 0 ? 0 : 3
  }
  /** Both sides of a boundary, OR'd, as the original did. */
  const flags = (direction: Direction, row: number, col: number): SideFlag => {
    const d = DELTA[direction]
    return (own(direction, row, col) | own(OPPOSITE[direction], row + d.dr, col + d.dc)) as SideFlag
  }

  let dx = 0
  let dy = 0
  const set = (tileId: number, y: number, x: number): void => {
    const tx = dx * CELL_W + dy * CELL_H + 21 + x
    const ty = dy * CELL_H + 10 + y
    if (tx >= 0 && tx < ARENA_WIDTH && ty >= 0 && ty < ARENA_HEIGHT) tiles[ty * ARENA_WIDTH + tx] = tileId + 1
  }

  for (dy = -2; dy <= 2; dy++) {
    for (dx = -6; dx <= 6; dx++) {
      const row = at.row + dy
      const col = at.col + dx
      const north = flags('north', row, col)
      const west = flags('west', row, col)
      const east = flags('east', row, col)
      const south = flags('south', row, col)

      // The floor, and the west wall as a diagonal band across it.
      for (let y = 2; y <= 4; y++) for (let x = 0; x <= 5; x++) set(FLOOR, y, x)
      if (west === 1) {
        for (let y = 2; y <= 4; y++) {
          set(4, y, y - 1)
          set(3, y, y)
          set(13, y, y + 1)
        }
      } else if (west === 3) {
        set(8, 2, 1)
        set(0, 4, 5)
      }

      // The north wall: two rows.
      if (north === 1) {
        set(5, 0, 3); set(5, 0, 4)
        set(10, 1, 3); set(10, 1, 4)
      } else {
        set(FLOOR, 0, 3); set(FLOOR, 0, 4)
        set(FLOOR, 1, 3); set(FLOOR, 1, 4)
      }

      // The north-west corner, by the walls of the squares above and to the west.
      {
        const openCorner = flags('west', row - 1, col) === 0 && flags('north', row, col - 1) === 0
        let a = FLOOR, b = FLOOR, c = FLOOR, d = FLOOR
        if (north === 0) {
          if (west === 0) a = FLOOR
          else if (west === 3) a = 0x0d
          else a = openCorner ? 0 : 0x0d
        } else if (west === 0) {
          a = openCorner ? 0x0f : 5
        } else {
          a = openCorner ? 0x12 : 2
        }
        b = north === 0 ? FLOOR : north === 3 ? 0x11 : 5
        if (west === 0) c = north === 0 ? FLOOR : openCorner ? 0x10 : 0x0a
        else if (west === 3) c = openCorner ? 0x14 : 7
        else c = openCorner ? 1 : 3
        if (west === 0 || west === 3) d = north === 0 ? FLOOR : north === 3 ? 0x17 : 0x0a
        else d = north === 0 ? 0x0d : north === 3 ? 0x15 : 6
        set(a, 0, 1); set(b, 0, 2); set(c, 1, 1); set(d, 1, 2)
      }

      // The north-east corner, by the walls of the squares above and to the east.
      {
        const aboveEast = flags('east', row - 1, col)
        const rightNorth = flags('north', row, col + 1)
        const openCorner = aboveEast === 0 && rightNorth === 0
        let a: number, b: number, c: number, d: number
        if (north === 0) a = aboveEast === 1 ? 4 : FLOOR
        else if (north === 3) a = 0x0f
        else a = 5
        if (north === 0) {
          if (aboveEast === 0) b = FLOOR
          else if (aboveEast === 3) b = east === 0 && rightNorth !== 0 ? 0x18 : 1
          else b = east === 0 ? (rightNorth !== 0 ? 0x0b : 7) : 3
        } else if (east !== 0) b = 9
        else if (rightNorth !== 0) b = 5
        else b = openCorner ? 0x11 : 0x13
        c = north === 0 ? FLOOR : north === 3 ? 0x10 : 0x0a
        if (north === 0) {
          if (aboveEast === 0) d = FLOOR
          else if (east !== 0) d = 4
          else d = rightNorth === 0 ? 8 : 0x0c
        } else if (east !== 0) d = 0x0e
        else d = rightNorth === 0 ? 0x17 : 0x0a
        set(a, 0, 5); set(b, 0, 6); set(c, 1, 5); set(d, 1, 6)
      }

      // Furniture: a room (not a corridor, no doors) flagged in its event byte may get
      // a table, with chairs on the floor around it.
      const cell = cellAt(map, row, col)
      const furnished = cell !== undefined && (cell.event & 0x40) !== 0
      const walls = [north, east, south, west]
      const anyWall = walls.some((w) => w === 1)
      const corridorNS = north === 1 && south === 1 && (east !== 1 || west !== 1)
      const corridorEW = east === 1 && west === 1 && (north !== 1 || south !== 1)
      const anyDoor = walls.some((w) => w === 3)
      const room = anyWall && !corridorNS && !corridorEW && !anyDoor
      if (furnished && room) {
        for (let x = 2; x <= 3; x++) {
          for (let y = 2; y <= 4; y++) {
            const px = dx * CELL_W + dy * CELL_H + 21 + x + y
            const py = dy * CELL_H + 10 + y
            if (idAt(px, py) !== FLOOR + 1 || dice(random, 10, 1) > 5) continue
            tiles[py * ARENA_WIDTH + px] = TABLE_ID
            for (const [ox, oy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
              const cx = px + ox
              const cy = py + oy
              if (idAt(cx, cy) === FLOOR + 1 && dice(random, 10, 1) <= 9) tiles[cy * ARENA_WIDTH + cx] = CHAIR_ID
            }
          }
        }
      }
    }
  }

  return wrap(tiles)
}

/**
 * Outdoors: open ground, and by the terrain's flags a river across it, clearings of
 * rough ground, and scenery scattered about. `terrain` is the original's per-region
 * byte: 0x20 forest, 0x10 river country, 0x40 hills, 0x02 and 0x04 sparser, 0x08
 * and 0x80 barren.
 */
export function buildWildArena(random: Random, terrain = 0x20): Arena {
  const tiles = new Uint8Array(ARENA_WIDTH * ARENA_HEIGHT).fill(23)
  const at = (x: number, y: number): number => tiles[y * ARENA_WIDTH + x]!
  const put = (x: number, y: number, id: number): void => {
    if (x >= 0 && y >= 0 && x < ARENA_WIDTH && y < ARENA_HEIGHT) tiles[y * ARENA_WIDTH + x] = id
  }

  // A river, slanting with the map.
  let riverChance = 0
  if (terrain & 0x20) riverChance = 0x23
  if (terrain & 0x10) riverChance = 0x4b
  if (dice(random, 100, 1) <= riverChance) {
    let x = 0x22 - dice(random, 4, 5)
    while ((x + 2) % 7 > 0) x--
    for (let y = 0; y <= 0x18; y++) {
      if (x > 0x31) break
      put(x, y, dice(random, 2, 1) + 0x3b)
      put(x + 1, y, dice(random, 2, 1) + 0x3d)
      if (dice(random, 20, 1) === 1) {
        put(x + 1, y, 0x40)
        put(x + 1, y + 1, 0x41)
      }
      x++
    }
  }

  // Clearings: patches of rough ground where two plain squares stand one above the other.
  if ((terrain & 0x80) === 0) {
    let needed = 10
    if (terrain & 2) needed -= 5
    if (terrain & 4) needed -= 2
    if (terrain & 0x40) needed += 5
    if (terrain & 8) needed += 10
    if (needed < 0) needed = 1
    for (let x = 0; x <= 0x31; x++) {
      for (let y = 1; y <= 0x18; y++) {
        if (CELL[at(x, y)] !== 22 || CELL[at(x, y - 1)] !== 22 || needed < dice(random, 100, 1)) continue
        if (needed >= dice(random, 100, 1)) put(x, y, dice(random, 2, 1) + 0x29)
        else {
          put(x, y - 1, dice(random, 5, 1) + 0x1f)
          put(x, y, dice(random, 5, 1) + 0x24)
        }
      }
    }
  }

  // Scenery, thicker where the land is wooded or hilly.
  let density = 50
  if (terrain & 0x10) density += 10
  if (terrain & 0x20) density += 30
  if (terrain & 0x40) density += 20
  if (terrain & 4) density -= 10
  if (terrain & 2) density -= 20
  if (terrain & 0x80) density -= 50
  const scatter = (x: number, y: number, e: number, d: number, c: number, b: number, a: number): void => {
    const roll = dice(random, 100, 1)
    if (roll <= a) put(x, y, dice(random, 2, 1) + 0x39)
    else if (roll <= a + b) put(x, y, dice(random, 2, 1) + 0x2f)
    else if (roll <= a + b + c) put(x, y, dice(random, 4, 1) + 0x2b)
    else if (roll <= a + b + c + d) put(x, y, dice(random, 3, 1) + 0x36)
    else if (roll <= a + b + c + d + e) put(x, y, dice(random, 4, 1) + 0x31)
  }
  for (let x = 0; x < ARENA_WIDTH; x++) {
    for (let y = 0; y < ARENA_HEIGHT; y++) {
      if (CELL[at(x, y)] !== 22) continue
      if (density <= 9) scatter(x, y, 15, 30, 0, 0, 0)
      else if (density <= 29) scatter(x, y, 10, 14, 5, 1, 0)
      else if (density <= 59) scatter(x, y, 5, 10, 5, 2, 0)
      else if (density <= 89) scatter(x, y, 1, 10, 10, 2, 10)
      else scatter(x, y, 1, 10, 15, 5, 15)
    }
  }

  return wrap(tiles)
}
