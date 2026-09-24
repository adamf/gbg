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
  /** COMSPR by block id: the two frames of each missile and spell-light. */
  sprites?: ReadonlyMap<number, readonly Rgba[]>
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

/** Squares to tint over the field: the blast being aimed, the fighters picked. */
export interface Overlay { squares: readonly { x: number; y: number }[]; fill: string; edge?: string }

export function drawBattle(canvas: HTMLCanvasElement, battle: Battle, active: Fighter | undefined, art?: BattleArt, overlays: readonly Overlay[] = []): void {
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

  for (const overlay of overlays) {
    for (const s of overlay.squares) {
      const vx = s.x - view.x
      const vy = s.y - view.y
      if (vx < 0 || vy < 0 || vx >= VIEW_COLS || vy >= VIEW_ROWS) continue
      g.fillStyle = overlay.fill
      g.fillRect(vx * SQUARE, vy * SQUARE, SQUARE, SQUARE)
      if (overlay.edge) {
        g.strokeStyle = overlay.edge
        g.lineWidth = 3
        g.strokeRect(vx * SQUARE + 1.5, vy * SQUARE + 1.5, SQUARE - 3, SQUARE - 3)
      }
    }
  }
}

// ---- effects ------------------------------------------------------------------

const EGA = ['#000000', '#0000aa', '#00aa00', '#00aaaa', '#aa0000', '#aa00aa', '#aa5500', '#aaaaaa',
  '#555555', '#5555ff', '#55ff55', '#55ffff', '#ff5555', '#ff55ff', '#ffff55', '#ffffff']

function centre(view: { x: number; y: number }, at: { x: number; y: number }): { x: number; y: number } {
  return { x: (at.x - view.x) * SQUARE + SQUARE / 2, y: (at.y - view.y) * SQUARE + SQUARE / 2 }
}

function frameSet(art: BattleArt | undefined, id: number | undefined): readonly Rgba[] | undefined {
  if (id === undefined) return undefined
  const set = art?.sprites?.get(id)
  return set && set.length > 0 ? set : undefined
}

/**
 * A missile in flight. Arrows come in three orientations — upright (block 0),
 * diagonal (1) and across (2), each with its second frame pointing the other way,
 * and the other diagonal is the mirror; thrown things tumble between their frames.
 */
function drawMissile(g: CanvasRenderingContext2D, sprite: readonly Rgba[], id: number, x: number, y: number, dx: number, dy: number, t: number): void {
  let frame = sprite[0]!
  let mirror = false
  if (id <= 2) {
    // An arrow: pick the orientation and the frame that points the way it flies.
    const set = sprite
    if (dx === 0) frame = set[dy > 0 ? 1 : 0] ?? frame
    else if (dy === 0) { frame = set[dx < 0 ? 1 : 0] ?? frame }
    else { frame = set[(dx > 0) !== (dy > 0) ? 0 : 1] ?? frame; mirror = (dx < 0 && dy < 0) || (dx > 0 && dy > 0) }
  } else {
    frame = sprite[Math.floor(t * 6) % sprite.length]!
  }
  const c = toCanvas(frame)
  if (mirror) {
    g.save()
    g.translate(x, y)
    g.scale(-1, 1)
    g.drawImage(c, -SQUARE / 2, -SQUARE / 2, SQUARE, SQUARE)
    g.restore()
  } else g.drawImage(c, x - SQUARE / 2, y - SQUARE / 2, SQUARE, SQUARE)
}

function frames(ms: number, draw: (t: number) => void): Promise<void> {
  return new Promise((resolve) => {
    const started = performance.now()
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      draw(1)
      resolve()
    }
    const tick = (): void => {
      if (done) return
      const t = Math.min(1, (performance.now() - started) / ms)
      draw(t)
      if (t < 1) requestAnimationFrame(tick)
      else finish()
    }
    requestAnimationFrame(tick)
    // A tab in the background gets no animation frames; the fight must not wait on one.
    setTimeout(finish, ms + 50)
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
        // The original swapped the icon for its action pose; a small step sells it.
        const who = battle.at(e.from.x, e.from.y)
        const dx = Math.sign(first.x - from.x)
        const dy = Math.sign(first.y - from.y)
        await frames(200, (t) => {
          base()
          const icon = who?.combatant.actionIcon ?? who?.combatant.icon
          if (!icon) return
          const reach = Math.sin(t * Math.PI) * SQUARE * 0.15
          g.fillStyle = art?.outdoors ? '#2d5a27' : '#5c5c5c'
          g.fillRect(from.x - SQUARE / 2, from.y - SQUARE / 2, SQUARE, SQUARE)
          g.drawImage(toCanvas(icon), from.x - SQUARE / 2 + dx * reach, from.y - SQUARE / 2 + dy * reach, SQUARE, SQUARE)
        })
        if (e.hit) await flash(e.to, EGA[12]!)
        break
      }
      case 'arrow': {
        const sprite = frameSet(art, e.sprite)
        const dx = Math.sign(first.x - from.x)
        const dy = Math.sign(first.y - from.y)
        await frames(260, (t) => {
          base()
          const x = from.x + (first.x - from.x) * t
          const y = from.y + (first.y - from.y) * t
          if (sprite) drawMissile(g, sprite, e.sprite ?? 0, x, y, dx, dy, t)
          else {
            const len = 10
            const angle = Math.atan2(first.y - from.y, first.x - from.x)
            g.strokeStyle = EGA[6]!
            g.lineWidth = 2
            g.beginPath()
            g.moveTo(x - Math.cos(angle) * len, y - Math.sin(angle) * len)
            g.lineTo(x, y)
            g.stroke()
          }
        })
        if (e.hit) await flash(e.to, EGA[12]!)
        break
      }
      case 'streak': {
        const sprite = frameSet(art, e.sprite)
        for (const target of targets) {
          await frames(260, (t) => {
            base()
            if (sprite) {
              const frame = sprite[Math.floor(t * 8) % sprite.length]!
              g.drawImage(toCanvas(frame), from.x + (target.x - from.x) * t - SQUARE / 2, from.y + (target.y - from.y) * t - SQUARE / 2, SQUARE, SQUARE)
              return
            }
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
        const sprite = frameSet(art, e.sprite)
        const far = targets.reduce((best, t) => (Math.hypot(t.x - from.x, t.y - from.y) > Math.hypot(best.x - from.x, best.y - from.y) ? t : best), first)
        await frames(300, (t) => {
          base()
          if (sprite) {
            // The bolt's art stamped along its path, flickering between its two frames.
            const steps = Math.max(1, Math.round(Math.hypot(far.x - from.x, far.y - from.y) / SQUARE))
            const frame = sprite[Math.floor(t * 10) % sprite.length]!
            for (let i = 1; i <= steps; i++) {
              const k = i / steps
              g.drawImage(toCanvas(frame), from.x + (far.x - from.x) * k - SQUARE / 2, from.y + (far.y - from.y) * k - SQUARE / 2, SQUARE, SQUARE)
            }
            return
          }
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
        const sprite = frameSet(art, e.sprite)
        await frames(360, (t) => {
          base()
          if (sprite) {
            // The small burst, then the large one, on every square the spell reached.
            const frame = sprite[t < 0.4 ? 0 : sprite.length - 1]!
            for (const target of targets) g.drawImage(toCanvas(frame), target.x - SQUARE / 2, target.y - SQUARE / 2, SQUARE, SQUARE)
            return
          }
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
        const sprite = frameSet(art, e.sprite)
        await frames(360, (t) => {
          base()
          if (sprite) {
            const frame = sprite[Math.floor(t * 8) % sprite.length]!
            for (const target of targets) g.drawImage(toCanvas(frame), target.x - SQUARE / 2, target.y - SQUARE / 2, SQUARE, SQUARE)
            return
          }
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
