/**
 * Where the party is standing and which way it is looking.
 *
 * Movement is on the grid and turns are by ninety degrees, the way the originals
 * played. The renderer smooths between states; the state itself never lands
 * between squares.
 */

import { canWalk, DIRECTIONS, type Direction, type GeoMap } from '../formats/geo.js'
import { isWalkable } from './dungeon.js'

export interface PartyState {
  row: number
  col: number
  facing: Direction
}

export type MoveResult = { moved: true; state: PartyState } | { moved: false; blocked: Direction }

function turnBy(facing: Direction, quarters: number): Direction {
  const index = DIRECTIONS.indexOf(facing)
  return DIRECTIONS[(index + quarters + DIRECTIONS.length * 4) % DIRECTIONS.length]!
}

export function turnLeft(state: PartyState): PartyState {
  return { ...state, facing: turnBy(state.facing, -1) }
}

export function turnRight(state: PartyState): PartyState {
  return { ...state, facing: turnBy(state.facing, 1) }
}

export function turnAround(state: PartyState): PartyState {
  return { ...state, facing: turnBy(state.facing, 2) }
}

/** Steps one square in `direction`, or reports what blocked it. */
export function walk(map: GeoMap, state: PartyState, direction: Direction): MoveResult {
  if (!canWalk(map, state.row, state.col, direction)) return { moved: false, blocked: direction }

  const next = { ...state, ...offsetFor(direction, state) }
  if (!isWalkable(map, next.row, next.col)) return { moved: false, blocked: direction }
  return { moved: true, state: next }
}

export function forward(map: GeoMap, state: PartyState): MoveResult {
  return walk(map, state, state.facing)
}

export function backward(map: GeoMap, state: PartyState): MoveResult {
  return walk(map, state, turnBy(state.facing, 2))
}

export function strafeLeft(map: GeoMap, state: PartyState): MoveResult {
  return walk(map, state, turnBy(state.facing, -1))
}

export function strafeRight(map: GeoMap, state: PartyState): MoveResult {
  return walk(map, state, turnBy(state.facing, 1))
}

function offsetFor(direction: Direction, state: PartyState): { row: number; col: number } {
  switch (direction) {
    case 'north': return { row: state.row - 1, col: state.col }
    case 'east': return { row: state.row, col: state.col + 1 }
    case 'south': return { row: state.row + 1, col: state.col }
    case 'west': return { row: state.row, col: state.col - 1 }
  }
}

/** Compass heading in radians for the renderer, measured the way three.js turns. */
export function headingRadians(facing: Direction): number {
  switch (facing) {
    case 'north': return 0
    case 'east': return -Math.PI / 2
    case 'south': return Math.PI
    case 'west': return Math.PI / 2
  }
}
