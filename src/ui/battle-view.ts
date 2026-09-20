/**
 * Draws a battle the way the original's combat screen did: a flat floor with no
 * grid, walls as bands of the game's own cobble art — a strip above a horizontal
 * edge, a strip slanting down-right for a vertical one, a pale cap along the top —
 * and outdoors, trees and rocks from the wilderness set along the boundaries. The
 * icons stand on the floor and the fighter whose turn it is wears a white box.
 */

import type { Battle, Fighter } from '../engine/battle.js'
import type { Rgba } from '../formats/ega.js'

export const SQUARE = 36
const BAND = 0.55
const CAP = 3

export interface BattleArt {
  tiles: Rgba[]
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

/** A deterministic pick from the scenery, so the same square always shows the same tree. */
function scenery(tiles: Rgba[], x: number, y: number): Rgba | undefined {
  const choices = [0, 1, 2, 3, 5, 6, 7]
  const index = choices[(x * 7 + y * 13) % choices.length]!
  return tiles[index]
}

export function drawBattle(canvas: HTMLCanvasElement, battle: Battle, active: Fighter | undefined, art?: BattleArt): void {
  canvas.width = battle.width * SQUARE
  canvas.height = battle.height * SQUARE
  const g = canvas.getContext('2d')
  if (!g) return
  g.imageSmoothingEnabled = false

  const outdoors = art?.outdoors ?? false
  const scale = SQUARE / 24
  g.fillStyle = outdoors ? '#2d5a27' : '#5c5c5c'
  g.fillRect(0, 0, canvas.width, canvas.height)

  // The cobble fill: the set's plain tile, repeated at the square's scale.
  const cobble = !outdoors && art?.tiles[1] ? g.createPattern(toCanvas(art.tiles[1]), 'repeat') : null
  if (cobble) cobble.setTransform(new DOMMatrix().scale(scale))
  const fill = (): void => {
    g.fillStyle = cobble ?? '#8a8a8a'
  }
  const cap = (x1: number, y1: number, x2: number, y2: number): void => {
    g.strokeStyle = '#d8d8d8'
    g.lineWidth = CAP
    g.beginPath()
    g.moveTo(x1, y1)
    g.lineTo(x2, y2)
    g.stroke()
  }

  // Rock and, outdoors, the wild beyond the edge.
  for (let y = 0; y < battle.height; y++) {
    for (let x = 0; x < battle.width; x++) {
      if (!battle.isSolid(x, y)) continue
      const px = x * SQUARE
      const py = y * SQUARE
      if (outdoors) {
        const tree = art && scenery(art.tiles, x, y)
        if (tree) g.drawImage(toCanvas(tree), px, py, SQUARE, SQUARE)
      } else {
        fill()
        g.fillRect(px, py, SQUARE, SQUARE)
      }
    }
  }

  // Walls, each boundary once: the slanted band for a vertical edge, the strip
  // above a horizontal one, both capped in pale stone.
  const band = SQUARE * BAND
  for (let y = 0; y < battle.height; y++) {
    for (let x = 0; x < battle.width; x++) {
      if (battle.isSolid(x, y)) continue
      const px = x * SQUARE
      const py = y * SQUARE
      const edges: { dx: number; dy: number }[] = []
      if (battle.hasWall(x, y, 0, -1)) edges.push({ dx: 0, dy: -1 })
      if (battle.hasWall(x, y, 0, 1) && (y + 1 >= battle.height || battle.isSolid(x, y + 1) || !battle.hasWall(x, y + 1, 0, -1))) edges.push({ dx: 0, dy: 1 })
      if (battle.hasWall(x, y, 1, 0)) edges.push({ dx: 1, dy: 0 })
      if (battle.hasWall(x, y, -1, 0) && (x === 0 || battle.isSolid(x - 1, y) || !battle.hasWall(x - 1, y, 1, 0))) edges.push({ dx: -1, dy: 0 })

      for (const edge of edges) {
        if (outdoors) {
          const tree = art && scenery(art.tiles, x + edge.dx * 3, y + edge.dy * 5)
          if (!tree) continue
          const tx = px + edge.dx * SQUARE * 0.5
          const ty = py + edge.dy * SQUARE * 0.5
          g.drawImage(toCanvas(tree), tx, ty, SQUARE, SQUARE)
          continue
        }
        fill()
        if (edge.dy !== 0) {
          const lineY = edge.dy < 0 ? py : py + SQUARE
          g.fillRect(px, lineY - band, SQUARE, band)
          cap(px, lineY - band, px + SQUARE, lineY - band)
        } else {
          const lineX = edge.dx < 0 ? px : px + SQUARE
          g.beginPath()
          g.moveTo(lineX, py)
          g.lineTo(lineX + band, py)
          g.lineTo(lineX + band + SQUARE, py + SQUARE)
          g.lineTo(lineX + SQUARE, py + SQUARE)
          g.closePath()
          g.fill()
          cap(lineX, py, lineX + SQUARE, py + SQUARE)
        }
      }
    }
  }

  for (const f of battle.fighters) {
    const c = f.combatant.member.character
    if (c.hpCurrent <= 0 && c.status !== 'okay' && c.status !== 'asleep' && c.status !== 'held') continue
    const px = f.x * SQUARE
    const py = f.y * SQUARE
    const helpless = c.status === 'asleep' || c.status === 'held'
    if (f === active) {
      g.fillStyle = '#e8e8e8'
      g.fillRect(px, py, SQUARE, SQUARE)
      g.fillStyle = outdoors ? '#2d5a27' : '#5c5c5c'
      g.fillRect(px + 2, py + 2, SQUARE - 4, SQUARE - 4)
    }
    if (f.combatant.icon) {
      g.globalAlpha = helpless ? 0.45 : 1
      g.drawImage(toCanvas(f.combatant.icon), px + 2, py + 2, SQUARE - 4, SQUARE - 4)
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
