/**
 * Draws a battle the way the original's combat screen did: a window onto the arena
 * around the fighter whose turn it is, a flat floor, and walls as whole tiles of the
 * game's own cobble art — an east–west wall a row of them capped in pale stone, a
 * north–south one a diagonal of them with the pale stripe running through — with the
 * icons standing a tile each, twice their size. Outdoors the wilderness set's trees
 * and rocks stand where the walls would.
 */

import type { Battle, Fighter } from '../engine/battle.js'
import { RANDOM_CELLS } from '../engine/arena.js'
import type { Rgba } from '../formats/ega.js'

export const SQUARE = 48
export const VIEW_COLS = 13
export const VIEW_ROWS = 9

export interface BattleArt {
  /** DUNGCOM underground, WILDCOM outdoors. */
  tiles: Rgba[]
  /** RANDCOM: the cells from 0x22 on. */
  decorations: Rgba[]
  outdoors: boolean
}

const canvasCache = new WeakMap<object, HTMLCanvasElement>()

function toCanvas(image: Rgba): HTMLCanvasElement {
  let canvas = canvasCache.get(image)
  if (canvas) return canvas
  canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height), 0, 0)
  canvasCache.set(image, canvas)
  return canvas
}

/** Where the window sits: centred on the fighter, kept inside the arena. */
export function viewport(battle: Battle, focus: { x: number; y: number } | undefined): { x: number; y: number } {
  const cx = focus?.x ?? Math.floor(battle.width / 2)
  const cy = focus?.y ?? Math.floor(battle.height / 2)
  return {
    x: Math.max(0, Math.min(battle.width - VIEW_COLS, cx - Math.floor(VIEW_COLS / 2))),
    y: Math.max(0, Math.min(battle.height - VIEW_ROWS, cy - Math.floor(VIEW_ROWS / 2))),
  }
}

export function drawBattle(canvas: HTMLCanvasElement, battle: Battle, active: Fighter | undefined, art?: BattleArt): void {
  canvas.width = VIEW_COLS * SQUARE
  canvas.height = VIEW_ROWS * SQUARE
  const g = canvas.getContext('2d')
  if (!g) return
  g.imageSmoothingEnabled = false

  const outdoors = art?.outdoors ?? false
  const floor = outdoors ? '#2d5a27' : '#5c5c5c'
  g.fillStyle = floor
  g.fillRect(0, 0, canvas.width, canvas.height)

  const view = viewport(battle, active)

  // The arena names an art cell for every square; the art does the rest. Cells
  // from 0x22 on are the random decorations.
  for (let vy = 0; vy < VIEW_ROWS; vy++) {
    for (let vx = 0; vx < VIEW_COLS; vx++) {
      const x = view.x + vx
      const y = view.y + vy
      const index = battle.tileIndex(x, y)
      const px = vx * SQUARE
      const py = vy * SQUARE
      if (index < 0) {
        g.fillStyle = '#3a3a3a'
        g.fillRect(px, py, SQUARE, SQUARE)
        continue
      }
      if (!outdoors && index === 22) continue
      const image = index >= RANDOM_CELLS ? art?.decorations[index - RANDOM_CELLS] : art?.tiles[index]
      if (image) g.drawImage(toCanvas(image), px, py, SQUARE, SQUARE)
      else if (!outdoors) { g.fillStyle = '#8a8a8a'; g.fillRect(px, py, SQUARE, SQUARE) }
    }
  }

  for (const f of battle.fighters) {
    const c = f.combatant.member.character
    if (c.hpCurrent <= 0 && c.status !== 'okay' && c.status !== 'asleep' && c.status !== 'held') continue
    const vx = f.x - view.x
    const vy = f.y - view.y
    if (vx < 0 || vy < 0 || vx >= VIEW_COLS || vy >= VIEW_ROWS) continue
    const px = vx * SQUARE
    const py = vy * SQUARE
    const helpless = c.status === 'asleep' || c.status === 'held'
    if (f === active) {
      g.fillStyle = '#e8e8e8'
      g.fillRect(px, py, SQUARE, SQUARE)
      g.fillStyle = floor
      g.fillRect(px + 3, py + 3, SQUARE - 6, SQUARE - 6)
    }
    if (f.combatant.icon) {
      g.globalAlpha = helpless ? 0.45 : 1
      g.drawImage(toCanvas(f.combatant.icon), px, py, SQUARE, SQUARE)
      g.globalAlpha = 1
      continue
    }
    g.beginPath()
    g.arc(px + SQUARE / 2, py + SQUARE / 2, SQUARE * 0.36, 0, Math.PI * 2)
    g.fillStyle = f.side === 'party' ? '#c9a227' : '#c0392b'
    g.fill()
    g.fillStyle = '#111'
    g.font = `bold ${Math.round(SQUARE * 0.5)}px ui-sans-serif, system-ui, sans-serif`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(c.name.charAt(0) + (f.combatant.label.match(/\d+$/)?.[0] ?? ''), px + SQUARE / 2, py + SQUARE / 2 + 1)
  }
}
