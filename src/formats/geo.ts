/**
 * GEO*.DAX — the dungeon maps. One block is one 16x16 level.
 *
 * Each block is four parallel 256-byte planes over the same cell order
 * (cell = row * 16 + col), after a two-byte prefix:
 *
 *   +2    north/east wall types   high nibble north, low nibble east
 *   +258  south/west wall types   high nibble south, low nibble west
 *   +514  event number            low 7 bits; the high bit is a flag
 *   +770  door state              two bits per direction, N E S W from bit 0 up
 *
 * A wall nibble of 0 is open floor; 1..15 select a wall graphic from the
 * wall sets the level's ECL script loaded.
 */

import { u8 } from './bytes.js'

export const MAP_SIZE = 16
export const GEO_BLOCK_SIZE = 1026

const NE_PLANE = 2
const SW_PLANE = 258
const EVENT_PLANE = 514
const DOOR_PLANE = 770

/** Compass directions, in the bit order the door plane uses. */
export const DIRECTIONS = ['north', 'east', 'south', 'west'] as const
export type Direction = (typeof DIRECTIONS)[number]

export enum DoorState {
  None = 0,
  Door = 1,
  Locked = 2,
  WizardLocked = 3,
}

export interface GeoCell {
  row: number
  col: number
  /** Wall graphic index per direction; 0 means open. */
  walls: Record<Direction, number>
  doors: Record<Direction, DoorState>
  /** Event number, 0 for none. */
  event: number
  /** High bit of the event byte. Meaning is not yet pinned down. */
  eventFlag: boolean
}

export interface GeoMap {
  /** DAX block id — the map number the ECL scripts refer to. */
  id: number
  cells: GeoCell[]
  /** Leading two bytes, kept for diagnostics; purpose unconfirmed. */
  prefix: [number, number]
}

export function isGeoBlock(data: Uint8Array): boolean {
  return data.length >= GEO_BLOCK_SIZE
}

export function readGeoMap(id: number, data: Uint8Array): GeoMap {
  if (!isGeoBlock(data)) throw new RangeError(`GEO block ${id} is ${data.length} bytes, need ${GEO_BLOCK_SIZE}`)

  const cells: GeoCell[] = []
  for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) {
    const ne = u8(data, NE_PLANE + i)
    const sw = u8(data, SW_PLANE + i)
    const eventByte = u8(data, EVENT_PLANE + i)
    const doorByte = u8(data, DOOR_PLANE + i)

    cells.push({
      row: i >> 4,
      col: i & 0x0f,
      walls: {
        north: (ne >> 4) & 0x0f,
        east: ne & 0x0f,
        south: (sw >> 4) & 0x0f,
        west: sw & 0x0f,
      },
      doors: {
        north: (doorByte >> 0) & 0x03,
        east: (doorByte >> 2) & 0x03,
        south: (doorByte >> 4) & 0x03,
        west: (doorByte >> 6) & 0x03,
      },
      event: eventByte & 0x7f,
      eventFlag: (eventByte & 0x80) !== 0,
    })
  }

  return { id, cells, prefix: [u8(data, 0), u8(data, 1)] }
}

export function cellAt(map: GeoMap, row: number, col: number): GeoCell | undefined {
  if (row < 0 || row >= MAP_SIZE || col < 0 || col >= MAP_SIZE) return undefined
  return map.cells[row * MAP_SIZE + col]
}

/**
 * Row/column delta for a direction.
 *
 * North is decreasing row and east is increasing column. That reading matches the
 * cell order and the door bit order; it is worth a sanity check against a map you
 * recognise the first time you load real data.
 */
export function step(direction: Direction): { dRow: number; dCol: number } {
  switch (direction) {
    case 'north': return { dRow: -1, dCol: 0 }
    case 'east': return { dRow: 0, dCol: 1 }
    case 'south': return { dRow: 1, dCol: 0 }
    case 'west': return { dRow: 0, dCol: -1 }
  }
}

export function opposite(direction: Direction): Direction {
  switch (direction) {
    case 'north': return 'south'
    case 'east': return 'west'
    case 'south': return 'north'
    case 'west': return 'east'
  }
}

/**
 * Whether the party can leave `cell` heading `direction`.
 *
 * A wall blocks unless a door is set on it. The neighbour's facing edge is checked
 * too: the games store both sides of a wall, and the two do not always agree.
 */
export function canWalk(map: GeoMap, row: number, col: number, direction: Direction): boolean {
  const here = cellAt(map, row, col)
  if (!here) return false
  const { dRow, dCol } = step(direction)
  const there = cellAt(map, row + dRow, col + dCol)
  if (!there) return false

  const blockedHere = here.walls[direction] !== 0 && here.doors[direction] === DoorState.None
  const blockedThere =
    there.walls[opposite(direction)] !== 0 && there.doors[opposite(direction)] === DoorState.None
  return !blockedHere && !blockedThere
}

/** First cell with no walls at all, a reasonable place to drop the camera. */
export function findOpenCell(map: GeoMap): GeoCell | undefined {
  return (
    map.cells.find((c) => DIRECTIONS.every((d) => c.walls[d] === 0)) ??
    map.cells.find((c) => DIRECTIONS.some((d) => c.walls[d] === 0))
  )
}
