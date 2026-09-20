/**
 * WALLDEF*.DAX — how a wall is drawn, as grids of 8x8 tile indices.
 *
 * A block is N walls of 156 bytes. Each wall holds ten views: the same wall seen
 * at the distances and offsets the original renderer needed to fake perspective.
 * The ten views tile the 156 bytes exactly:
 *
 *   view  offset  rows x cols   pixels
 *     0      0      2 x 1        8 x 16
 *     1      2      4 x 1        8 x 32
 *     2      6      4 x 1        8 x 32
 *     3     10      4 x 3       24 x 32
 *     4     22      8 x 2       16 x 64
 *     5     38      8 x 2       16 x 64
 *     6     54      8 x 7       56 x 64
 *     7    110     11 x 2       16 x 88
 *     8    132     11 x 2       16 x 88
 *     9    154      2 x 1        8 x 16
 *
 * Offsets and shapes are from the Curse of the Azure Bonds overlay tables
 * (seg600:0ADA/0AE4/0AEE), by way of Gold Box Explorer.
 *
 * The 3D renderer does not want fake perspective, so it takes one view as a flat
 * texture. View 6 is the widest and reads as the face of a wall straight ahead;
 * views 7 and 8 are the tall narrow ones, the wall alongside you.
 */

import { blankRgba, blit, type Rgba } from './ega.js'

export const WALL_SLICE_SIZE = 156
export const VIEWS_PER_WALL = 10

const VIEW_OFFSET = [0, 2, 6, 10, 22, 38, 54, 110, 132, 154] as const
const VIEW_COLS = [1, 1, 1, 3, 2, 2, 7, 2, 2, 1] as const
const VIEW_ROWS = [2, 4, 4, 4, 8, 8, 8, 11, 11, 2] as const

/** The view used as the flat wall texture in 3D. */
export const FACING_VIEW = 6
/** The views that read as a wall seen edge-on, left and right. */
export const SIDE_VIEWS = [7, 8] as const

export interface WallView {
  index: number
  rows: number
  cols: number
  /** Tile indices, row-major, into the wall set's 8x8 tile list. */
  tiles: number[]
}

export interface WallDef {
  /** Position of this wall within its block; wall type nibble N maps to index N - 1. */
  index: number
  views: WallView[]
}

/** Splits a WALLDEF block into its walls and their ten views. */
export function readWallDefBlock(data: Uint8Array): WallDef[] {
  const wallCount = Math.floor(data.length / WALL_SLICE_SIZE)
  const walls: WallDef[] = []

  for (let wall = 0; wall < wallCount; wall++) {
    const base = wall * WALL_SLICE_SIZE
    const views: WallView[] = []

    for (let view = 0; view < VIEWS_PER_WALL; view++) {
      const rows = VIEW_ROWS[view]!
      const cols = VIEW_COLS[view]!
      const tiles: number[] = []
      let at = base + VIEW_OFFSET[view]!
      for (let i = 0; i < rows * cols; i++, at++) tiles.push(at < data.length ? data[at]! : 0)
      views.push({ index: view, rows, cols, tiles })
    }

    walls.push({ index: wall, views })
  }

  return walls
}

/**
 * Paints one view by stamping its 8x8 tiles.
 *
 * Tile index 0 means "nothing here" — the original left those pixels showing
 * whatever was already on screen — so it is rendered transparent.
 */
export function renderWallView(view: WallView, tiles: readonly Rgba[]): Rgba {
  const image = blankRgba(view.cols * 8, view.rows * 8)

  for (let r = 0; r < view.rows; r++) {
    for (let c = 0; c < view.cols; c++) {
      const index = view.tiles[r * view.cols + c] ?? 0
      if (index === 0) continue
      const tile = tiles[index]
      if (!tile) continue
      blit(image, tile, c * 8, r * 8)
    }
  }

  return image
}

/**
 * Fills the gaps in a painted view so it can be used as a wall texture.
 *
 * A view is a drawing, not a texture: the tiles outside the wall's shape are left
 * blank because the original renderer had already drawn whatever was behind them.
 * Stretched onto real geometry those blanks become holes you can see the void
 * through, so they are filled with the wall's own average colour, darkened a little
 * so the join reads as shadow rather than as a patch.
 */
export function solidify(image: Rgba): Rgba {
  let r = 0
  let g = 0
  let b = 0
  let opaque = 0

  for (let i = 0; i < image.pixels.length; i += 4) {
    if (image.pixels[i + 3] === 0) continue
    r += image.pixels[i]!
    g += image.pixels[i + 1]!
    b += image.pixels[i + 2]!
    opaque++
  }

  if (opaque === 0 || opaque === image.pixels.length / 4) return image

  const fill = [Math.round((r / opaque) * 0.62), Math.round((g / opaque) * 0.62), Math.round((b / opaque) * 0.62)]
  const filled = new Uint8ClampedArray(image.pixels)
  for (let i = 0; i < filled.length; i += 4) {
    if (filled[i + 3] !== 0) continue
    filled[i] = fill[0]!
    filled[i + 1] = fill[1]!
    filled[i + 2] = fill[2]!
    filled[i + 3] = 255
  }

  return { width: image.width, height: image.height, pixels: filled }
}

/** The flat texture for a wall: its facing view, painted and made solid. */
export function renderWallTexture(wall: WallDef, tiles: readonly Rgba[], view = FACING_VIEW): Rgba {
  const chosen = wall.views[view] ?? wall.views[FACING_VIEW] ?? wall.views[0]
  if (!chosen) return blankRgba(8, 8)
  return solidify(renderWallView(chosen, tiles))
}
