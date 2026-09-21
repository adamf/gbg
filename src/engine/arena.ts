/**
 * The combat map, laid out the way the original laid it out.
 *
 * This is a port of the routine the game ran before a fight (sub_378CD0 in the
 * overlay, `SetupDungeonFloor` in the coab disassembly): a 50×25 grid of tile
 * indexes into DUNGCOM, filled from the thirteen-by-five dungeon squares around the
 * party. Each square is a patch six wide and five tall, and every dungeon row sits
 * five columns further right than the row above, which is what makes north–south
 * walls run as diagonals. The north wall of a square is two rows of pieces, the west
 * wall a three-wide diagonal band of three, and the corners between are chosen by
 * what the neighbouring squares have. Only the floor tile can be stood on.
 */

import { cellAt, type Direction, type GeoMap } from '../formats/geo.js'

export const ARENA_WIDTH = 50
export const ARENA_HEIGHT = 25
/** The DUNGCOM piece that is bare floor. */
export const FLOOR = 22
const CELL_W = 6
const CELL_H = 5

/** How a side of a square reads to the map builder: open, a wall, or a door in a wall. */
type SideFlag = 0 | 1 | 3

const DIRS: Direction[] = ['north', 'east', 'south', 'west']
const DELTA: Record<Direction, { dr: number; dc: number }> = {
  north: { dr: -1, dc: 0 }, east: { dr: 0, dc: 1 }, south: { dr: 1, dc: 0 }, west: { dr: 0, dc: -1 },
}
const OPPOSITE: Record<Direction, Direction> = { north: 'south', east: 'west', south: 'north', west: 'east' }

export interface Arena {
  width: number
  height: number
  /** Tile index plus one per square; zero is nothing at all. */
  tiles: Uint8Array
  tile(x: number, y: number): number
  walkable(x: number, y: number): boolean
  /** Top-left arena square of the dungeon square at (dx, dy) from the party. */
  patch(dx: number, dy: number): { x: number; y: number }
}

export function buildArena(map: GeoMap, at: { row: number; col: number }): Arena {
  const tiles = new Uint8Array(ARENA_WIDTH * ARENA_HEIGHT)

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
    }
  }

  return {
    width: ARENA_WIDTH,
    height: ARENA_HEIGHT,
    tiles,
    tile(x, y) {
      if (x < 0 || y < 0 || x >= ARENA_WIDTH || y >= ARENA_HEIGHT) return -1
      return tiles[y * ARENA_WIDTH + x]! - 1
    },
    walkable(x, y) {
      return this.tile(x, y) === FLOOR
    },
    patch(pdx, pdy) {
      return { x: pdx * CELL_W + pdy * CELL_H + 21, y: pdy * CELL_H + 10 }
    },
  }
}

export { DIRS as ARENA_DIRS }
