/**
 * Turns a GEO level into something a 3D scene can be built from: the wall faces,
 * the floor cells, and where the party can stand.
 */

import {
  cellAt,
  DIRECTIONS,
  DoorState,
  MAP_SIZE,
  canWalk,
  type Direction,
  type GeoCell,
  type GeoMap,
} from '../formats/geo.js'

export interface WallFace {
  row: number
  col: number
  /** Which edge of the cell, and which way the face looks — into the cell. */
  direction: Direction
  /** Wall graphic index, 1..15. */
  wallType: number
  door: DoorState
}

/**
 * A cell walled in on all four sides is solid rock, not a room: the original
 * renderer never showed its inside and neither should we.
 */
export function isSolid(cell: GeoCell): boolean {
  return DIRECTIONS.every((d) => cell.walls[d] !== 0)
}

export function openCells(map: GeoMap): GeoCell[] {
  return map.cells.filter((cell) => !isSolid(cell))
}

/**
 * One face per walled edge of every open cell, looking inward.
 *
 * Both sides of a shared wall are emitted when both cells declare one, because the
 * two faces can carry different graphics — that is how the games put a finished wall
 * on the room side and bare rock on the corridor side.
 */
export function wallFaces(map: GeoMap): WallFace[] {
  const faces: WallFace[] = []

  for (const cell of map.cells) {
    if (isSolid(cell)) continue
    for (const direction of DIRECTIONS) {
      const wallType = cell.walls[direction]
      if (wallType === 0) continue
      faces.push({ row: cell.row, col: cell.col, direction, wallType, door: cell.doors[direction] })
    }
  }

  return faces
}

/** Cells carrying an event trigger, for the map overlay. */
export function eventCells(map: GeoMap): GeoCell[] {
  return map.cells.filter((cell) => cell.event !== 0 && !isSolid(cell))
}

/**
 * Somewhere sensible to start: the open cell with the most ways out, preferring
 * the middle of the level over an edge.
 */
export function startingCell(map: GeoMap): GeoCell {
  const open = openCells(map)
  if (open.length === 0) return map.cells[0]!

  const centre = (MAP_SIZE - 1) / 2
  let best = open[0]!
  let bestScore = -Infinity

  for (const cell of open) {
    const exits = DIRECTIONS.filter((d) => canWalk(map, cell.row, cell.col, d)).length
    const fromCentre = Math.abs(cell.row - centre) + Math.abs(cell.col - centre)
    const score = exits * 4 - fromCentre
    if (score > bestScore) {
      bestScore = score
      best = cell
    }
  }

  return best
}

/** A facing the party can actually move in from `cell`, for the initial camera. */
export function startingFacing(map: GeoMap, cell: GeoCell): Direction {
  return DIRECTIONS.find((d) => canWalk(map, cell.row, cell.col, d)) ?? 'north'
}

/** True when the cell has a floor to stand on. */
export function isWalkable(map: GeoMap, row: number, col: number): boolean {
  const cell = cellAt(map, row, col)
  return cell !== undefined && !isSolid(cell)
}
