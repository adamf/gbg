/**
 * The wilderness from above, the way the original drew it: the SQRPACI tiles
 * around the party, magnified whole pixels, the riders' icon on their square.
 */

import type { Rgba } from '../formats/ega.js'
import { tileAt, type OverlandMap } from '../formats/overland.js'

/** Squares shown either side of the party. */
const REACH_X = 6
const REACH_Y = 4
const TILE = 24

let scratch: HTMLCanvasElement | undefined
let scratchTiles: readonly Rgba[] | undefined
let scratchImages: (ImageData | undefined)[] = []

function imageOf(tiles: readonly Rgba[], index: number): ImageData | undefined {
  if (scratchTiles !== tiles) { scratchTiles = tiles; scratchImages = [] }
  const have = scratchImages[index]
  if (have) return have
  const tile = tiles[index]
  if (!tile) return undefined
  const image = new ImageData(new Uint8ClampedArray(tile.pixels), tile.width, tile.height)
  scratchImages[index] = image
  return image
}

export function drawOverland(
  canvas: HTMLCanvasElement,
  map: OverlandMap,
  tiles: readonly Rgba[],
  rider: Rgba | undefined,
  worldX: number,
  worldY: number,
): void {
  const context = canvas.getContext('2d')
  if (!context) return
  const cols = REACH_X * 2 + 1
  const rows = REACH_Y * 2 + 1
  // Paint at tile size into a scratch canvas, then magnify whole pixels onto the page.
  scratch ??= document.createElement('canvas')
  scratch.width = cols * TILE
  scratch.height = rows * TILE
  const small = scratch.getContext('2d')!
  small.fillStyle = '#0b0d12'
  small.fillRect(0, 0, scratch.width, scratch.height)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tile = tileAt(map, worldX - REACH_X + c, worldY - REACH_Y + r)
      if (tile === undefined) continue
      const image = imageOf(tiles, tile)
      if (image) small.putImageData(image, c * TILE, r * TILE)
    }
  }
  if (rider) {
    const image = new ImageData(new Uint8ClampedArray(rider.pixels), rider.width, rider.height)
    // putImageData ignores alpha; draw through a second canvas so the icon's transparent corners show the ground.
    const overlay = document.createElement('canvas')
    overlay.width = rider.width
    overlay.height = rider.height
    overlay.getContext('2d')!.putImageData(image, 0, 0)
    small.drawImage(overlay, REACH_X * TILE, REACH_Y * TILE)
  }

  const dpr = Math.min(window.devicePixelRatio, 2)
  const width = canvas.clientWidth || 600
  const height = Math.round((width * rows) / cols)
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr
    canvas.height = height * dpr
  }
  canvas.style.height = `${height}px`
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  context.imageSmoothingEnabled = false
  context.clearRect(0, 0, width, height)
  context.drawImage(scratch, 0, 0, width, height)
}
