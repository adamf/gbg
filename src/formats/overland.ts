/**
 * The wilderness — Pool of Radiance's one overland map.
 *
 * The three wilderness scripts (25, 26 and 27) count squares on a single map of
 * the Moonsea's north shore, forty-four columns by thirty-six rows, one byte a
 * square naming a tile in SQRPACI.DAX (256 tiles, 24×24, sixteen a row). It is
 * not in any DAX archive: it is a static table in START.EXE's data segment, stored
 * the way the linker packs initialised data — plain bytes, with a seven-byte token
 * for a run of one value:
 *
 *   n(16 LE)  B2  tile  count(16 LE)  B0
 *
 * where `n` is how many plain bytes came before the token (the decoder does not
 * need it, but checks it) and the run repeats `tile` `count` times. Only the
 * scoured lands along the bottom rows are packed; everything else is plain.
 *
 * Each script sees a sixteen-column window: script 25 the west (columns 0–15),
 * 26 the middle (13–28) and 27 the east (26–41). A script's x runs 2–15 inside
 * its window; walking off the east edge hands the party to the next script at
 * x = 3, off the west edge at x = 14, so the windows overlap by three columns.
 * The game prints world coordinates (x + the window's first column).
 *
 * Verified against the DOS game's memory with the map loaded; the row-0 shape
 * used to find the table is thirteen pairs of the two plain grass tiles and one more.
 */

export const WORLD_WIDTH = 44
export const WORLD_HEIGHT = 36
/** Columns a script's window covers. */
export const WINDOW_WIDTH = 16
/** The first wilderness script; its window starts at column 0. */
export const FIRST_WILDERNESS_SCRIPT = 25
export const LAST_WILDERNESS_SCRIPT = 27
/** How far each successive window is shifted. */
const WINDOW_STEP = 13

export interface OverlandMap {
  width: number
  height: number
  /** Row-major tile indices, `height` rows of `width`. */
  tiles: Uint8Array
  /** Where in the file the table began, for diagnostics. */
  offset: number
}

export function isWildernessScript(id: number): boolean {
  return id >= FIRST_WILDERNESS_SCRIPT && id <= LAST_WILDERNESS_SCRIPT
}

/** The world column of a script's x = 0. */
export function windowColumn(script: number): number {
  return isWildernessScript(script) ? (script - FIRST_WILDERNESS_SCRIPT) * WINDOW_STEP : 0
}

export function tileAt(map: OverlandMap, x: number, y: number): number | undefined {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return undefined
  return map.tiles[y * map.width + x]
}

/** The eight compass steps in the scripts' order: N, NE, E, SE, S, SW, W, NW. */
export const OVERLAND_STEPS: readonly { dx: number; dy: number }[] = [
  { dx: 0, dy: -1 }, { dx: 1, dy: -1 }, { dx: 1, dy: 0 }, { dx: 1, dy: 1 },
  { dx: 0, dy: 1 }, { dx: -1, dy: 1 }, { dx: -1, dy: 0 }, { dx: -1, dy: -1 },
]

const RUN_OPEN = 0xb2
const RUN_CLOSE = 0xb0
const TOKEN_SIZE = 7

/**
 * Unpacks `length` bytes of linker-packed data starting at `at`. Returns nothing
 * when the tokens do not chain (a run's leading count must equal the plain bytes
 * since the previous run, except the first, whose count reaches back before `at`).
 */
export function unpackData(data: Uint8Array, at: number, length: number): Uint8Array | undefined {
  const out = new Uint8Array(length)
  let filled = 0
  let plain = 0
  let first = true
  let i = at
  while (filled < length) {
    if (i + TOKEN_SIZE <= data.length && data[i + 2] === RUN_OPEN && data[i + 6] === RUN_CLOSE) {
      const before = data[i]! | (data[i + 1]! << 8)
      const count = data[i + 4]! | (data[i + 5]! << 8)
      // The first run's count reaches back before `at`, so it can only be checked loosely.
      if (count > 1 && (first ? before >= plain : before === plain)) {
        const tile = data[i + 3]!
        for (let k = 0; k < count && filled < length; k++) out[filled++] = tile
        i += TOKEN_SIZE
        plain = 0
        first = false
        continue
      }
    }
    if (i >= data.length) return undefined
    out[filled++] = data[i++]!
    plain++
  }
  return out
}

/** The plain grass tiles the map's first row opens with: thirteen pairs and one more. */
const OPENING_PAIRS = 13

/**
 * Finds and unpacks the overland map in START.EXE. Looks for the first row's
 * opening (thirteen alternating pairs of the grass tiles 1 and 2, then a 1) and takes
 * the candidate whose unpacked table ends in a full row of one tile — the
 * scoured lands — and whose run tokens chain.
 */
export function readOverland(startExe: Uint8Array): OverlandMap | undefined {
  const size = WORLD_WIDTH * WORLD_HEIGHT
  // The packed table is shorter than the map it unpacks to, so only the opening bounds the scan.
  outer: for (let i = 0; i + OPENING_PAIRS * 2 + 1 < startExe.length; i++) {
    for (let k = 0; k <= OPENING_PAIRS * 2; k++) {
      if (startExe[i + k] !== (k % 2 === 0 ? 1 : 2)) continue outer
    }
    const next = startExe[i + OPENING_PAIRS * 2 + 1]
    if (next === 1 || next === 2) continue
    const tiles = unpackData(startExe, i, size)
    if (!tiles) continue
    const last = tiles[size - 1]!
    let uniform = true
    for (let k = size - WORLD_WIDTH; k < size; k++) if (tiles[k] !== last) { uniform = false; break }
    if (!uniform) continue
    return { width: WORLD_WIDTH, height: WORLD_HEIGHT, tiles, offset: i }
  }
  return undefined
}
