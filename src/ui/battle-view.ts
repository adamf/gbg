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

// ---- effects ------------------------------------------------------------------

const EGA = ['#000000', '#0000aa', '#00aa00', '#00aaaa', '#aa0000', '#aa00aa', '#aa5500', '#aaaaaa',
  '#555555', '#5555ff', '#55ff55', '#55ffff', '#ff5555', '#ff55ff', '#ffff55', '#ffffff']

function centre(view: { x: number; y: number }, at: { x: number; y: number }): { x: number; y: number } {
  return { x: (at.x - view.x) * SQUARE + SQUARE / 2, y: (at.y - view.y) * SQUARE + SQUARE / 2 }
}

function frames(ms: number, draw: (t: number) => void): Promise<void> {
  return new Promise((resolve) => {
    const started = performance.now()
    const tick = (): void => {
      const t = Math.min(1, (performance.now() - started) / ms)
      draw(t)
      if (t < 1) requestAnimationFrame(tick)
      else resolve()
    }
    requestAnimationFrame(tick)
  })
}

/**
 * Plays what the engine recorded since the last call — a lunge, an arrow's flight,
 * a streak or burst or bolt of spell-light, sparkles on the charmed and the healed —
 * over the drawn board, one after another, and empties the list. The art is not
 * touched: these are lights drawn over it, in the palette's own colours.
 */
export async function playEffects(canvas: HTMLCanvasElement, battle: Battle, active: Fighter | undefined, art?: BattleArt): Promise<void> {
  const effects = battle.effects.splice(0)
  const g = canvas.getContext('2d')
  if (!g || effects.length === 0) return
  const view = viewport(battle, active)
  const base = (): void => drawBattle(canvas, battle, active, art)
  const flash = (squares: { x: number; y: number }[], colour: string, ms = 90): Promise<void> => frames(ms, (t) => {
    base()
    g.globalAlpha = 0.7 * (1 - t)
    g.fillStyle = colour
    for (const sq of squares) g.fillRect((sq.x - view.x) * SQUARE, (sq.y - view.y) * SQUARE, SQUARE, SQUARE)
    g.globalAlpha = 1
  })

  for (const e of effects) {
    const from = centre(view, e.from)
    const targets = e.to.map((t) => centre(view, t))
    const first = targets[0] ?? from
    const colour = EGA[e.colour ?? 15]!
    switch (e.shape) {
      case 'lunge': {
        const who = battle.at(e.from.x, e.from.y)
        const dx = Math.sign(first.x - from.x)
        const dy = Math.sign(first.y - from.y)
        await frames(160, (t) => {
          base()
          if (!who?.combatant.icon) return
          const reach = Math.sin(t * Math.PI) * SQUARE * 0.3
          g.drawImage(toCanvas(who.combatant.icon), from.x - SQUARE / 2 + dx * reach, from.y - SQUARE / 2 + dy * reach, SQUARE, SQUARE)
        })
        if (e.hit) await flash(e.to, EGA[12]!)
        break
      }
      case 'arrow': {
        await frames(220, (t) => {
          base()
          const x = from.x + (first.x - from.x) * t
          const y = from.y + (first.y - from.y) * t
          const len = 10
          const angle = Math.atan2(first.y - from.y, first.x - from.x)
          g.strokeStyle = EGA[6]!
          g.lineWidth = 2
          g.beginPath()
          g.moveTo(x - Math.cos(angle) * len, y - Math.sin(angle) * len)
          g.lineTo(x, y)
          g.stroke()
        })
        if (e.hit) await flash(e.to, EGA[12]!)
        break
      }
      case 'streak': {
        for (const target of targets) {
          await frames(240, (t) => {
            base()
            g.fillStyle = colour
            for (let i = 0; i < 4; i++) {
              const k = Math.max(0, t - i * 0.08)
              g.fillRect(from.x + (target.x - from.x) * k - 2, from.y + (target.y - from.y) * k - 2, 4, 4)
            }
          })
        }
        await flash(e.to, colour)
        break
      }
      case 'bolt': {
        const far = targets.reduce((best, t) => (Math.hypot(t.x - from.x, t.y - from.y) > Math.hypot(best.x - from.x, best.y - from.y) ? t : best), first)
        await frames(220, (t) => {
          base()
          g.strokeStyle = t % 0.3 < 0.15 ? colour : EGA[15]!
          g.lineWidth = 3
          g.beginPath()
          g.moveTo(from.x, from.y)
          const steps = 8
          for (let i = 1; i <= steps; i++) {
            const k = i / steps
            const jag = i === steps ? 0 : Math.sin(i * 7.3 + t * 20) * 8
            g.lineTo(from.x + (far.x - from.x) * k + jag, from.y + (far.y - from.y) * k - jag)
          }
          g.stroke()
        })
        await flash(e.to, colour)
        break
      }
      case 'burst': {
        await frames(320, (t) => {
          base()
          g.globalAlpha = 1 - t * 0.6
          g.fillStyle = t < 0.5 ? colour : EGA[12]!
          g.beginPath()
          g.arc(first.x, first.y, SQUARE * (0.3 + t * 1.4), 0, Math.PI * 2)
          g.fill()
          g.globalAlpha = 1
        })
        await flash(e.to, colour)
        break
      }
      case 'sparkle': {
        await frames(320, (t) => {
          base()
          g.fillStyle = colour
          for (const target of targets) {
            for (let i = 0; i < 8; i++) {
              const a = (i / 8) * Math.PI * 2 + t * 3
              const r = SQUARE * (0.15 + 0.3 * Math.sin(t * Math.PI))
              g.fillRect(target.x + Math.cos(a) * r - 2, target.y + Math.sin(a) * r - 2, 3, 3)
            }
          }
        })
        break
      }
      case 'glow': {
        await frames(260, (t) => {
          base()
          g.strokeStyle = colour
          g.globalAlpha = Math.sin(t * Math.PI)
          g.lineWidth = 3
          for (const target of targets) g.strokeRect(target.x - SQUARE / 2 + 2, target.y - SQUARE / 2 + 2, SQUARE - 4, SQUARE - 4)
          g.globalAlpha = 1
        })
        break
      }
    }
  }
  base()
}
