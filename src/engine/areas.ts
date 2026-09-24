/**
 * Where a spell lands on the combat grid: how far it reaches and which squares it
 * covers. Squares are ten feet; a diagonal counts as one, as the Gold Box counted.
 */

import type { Spell, SpellArea } from '../formats/spells.js'

export interface Square { x: number; y: number }

/** Squares apart, the way the game measured: the longer of the two legs. */
export function distance(a: Square, b: Square): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
}

/** How far a spell reaches at a caster level, in squares; nothing when the table gives no limit. */
export function spellRange(spell: Spell, level: number): number | undefined {
  const range = spell.range
  if (range === undefined) return undefined
  if (range === 'touch') return 1
  if (typeof range === 'number') return range
  return range.base + range.perLevel * level
}

/**
 * The squares a spell covers when aimed at `at` from `from`, inside a grid of
 * `width` by `height`. A circle is the classic fireball: two squares' radius fills
 * a five-square disc with the corners off. A block is centred on the target. A line
 * runs from the caster's next square toward the target and on past it.
 */
export function blastSquares(area: SpellArea, from: Square, at: Square, width: number, height: number): Square[] {
  const inside = (s: Square) => s.x >= 0 && s.y >= 0 && s.x < width && s.y < height
  const out: Square[] = []
  if (area.kind === 'circle') {
    const r = area.radius
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r + r) out.push({ x: at.x + dx, y: at.y + dy })
      }
    }
  } else if (area.kind === 'block') {
    const half = Math.floor(area.size / 2)
    for (let dy = -half; dy < area.size - half; dy++) {
      for (let dx = -half; dx < area.size - half; dx++) out.push({ x: at.x + dx, y: at.y + dy })
    }
  } else {
    // A line: Bresenham from the caster toward the target, so many squares long.
    let dx = at.x - from.x
    let dy = at.y - from.y
    if (dx === 0 && dy === 0) return []
    const steps = Math.max(Math.abs(dx), Math.abs(dy))
    // Extend the direction past the target so the line keeps its length.
    const sx = dx / steps
    const sy = dy / steps
    for (let k = 1; k <= area.length; k++) {
      const s = { x: Math.round(from.x + sx * k), y: Math.round(from.y + sy * k) }
      if (!inside(s)) break
      if (!out.some((o) => o.x === s.x && o.y === s.y)) out.push(s)
    }
    dx = dy = 0
  }
  return out.filter(inside)
}
