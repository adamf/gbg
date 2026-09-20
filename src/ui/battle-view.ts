/**
 * Draws a battle top-down: the squares, the walls the dungeon put there, and who
 * stands where. The party is gold, monsters red, the fighter whose turn it is ringed.
 */

import type { Battle, Fighter } from '../engine/battle.js'

const SQUARE = 30

export function drawBattle(canvas: HTMLCanvasElement, battle: Battle, active: Fighter | undefined, reachable?: Set<string>): void {
  canvas.width = battle.width * SQUARE + 1
  canvas.height = battle.height * SQUARE + 1
  const g = canvas.getContext('2d')
  if (!g) return
  g.fillStyle = '#0b0d12'
  g.fillRect(0, 0, canvas.width, canvas.height)

  for (let y = 0; y < battle.height; y++) {
    for (let x = 0; x < battle.width; x++) {
      const px = x * SQUARE
      const py = y * SQUARE
      if (battle.isSolid(x, y)) {
        g.fillStyle = '#1a1d26'
        g.fillRect(px, py, SQUARE, SQUARE)
        continue
      }
      g.fillStyle = reachable?.has(`${x},${y}`) ? '#2a2a1a' : (x + y) % 2 === 0 ? '#181b24' : '#141720'
      g.fillRect(px, py, SQUARE, SQUARE)
      g.strokeStyle = '#c9a227'
      g.lineWidth = 3
      g.beginPath()
      if (battle.hasWall(x, y, 0, -1)) { g.moveTo(px, py); g.lineTo(px + SQUARE, py) }
      if (battle.hasWall(x, y, 0, 1)) { g.moveTo(px, py + SQUARE); g.lineTo(px + SQUARE, py + SQUARE) }
      if (battle.hasWall(x, y, -1, 0)) { g.moveTo(px, py); g.lineTo(px, py + SQUARE) }
      if (battle.hasWall(x, y, 1, 0)) { g.moveTo(px + SQUARE, py); g.lineTo(px + SQUARE, py + SQUARE) }
      g.stroke()
    }
  }

  for (const f of battle.fighters) {
    const c = f.combatant.member.character
    if (c.hpCurrent <= 0 && c.status !== 'okay' && c.status !== 'asleep' && c.status !== 'held') continue
    const cx = f.x * SQUARE + SQUARE / 2
    const cy = f.y * SQUARE + SQUARE / 2
    const helpless = c.status === 'asleep' || c.status === 'held'
    g.beginPath()
    g.arc(cx, cy, SQUARE * 0.38, 0, Math.PI * 2)
    g.fillStyle = f.side === 'party' ? (helpless ? '#6b5a2a' : '#c9a227') : (helpless ? '#5a2a2a' : '#c0392b')
    g.fill()
    if (f === active) {
      g.strokeStyle = '#ffffff'
      g.lineWidth = 2
      g.stroke()
    }
    g.fillStyle = f.side === 'party' ? '#1a1408' : '#fff0f0'
    g.font = `bold ${Math.round(SQUARE * 0.5)}px ui-sans-serif, system-ui, sans-serif`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    const suffix = f.combatant.label.match(/\d+$/)?.[0] ?? ''
    g.fillText(c.name.charAt(0) + suffix, cx, cy + 1)
  }
}
