/**
 * The overhead map, drawn from the same GEO data the walls are built from.
 *
 * The originals sold a paper map in the box and expected graph paper for the rest.
 * This is the one piece of help the design did not have and clearly wanted.
 */

import { DIRECTIONS, DoorState, MAP_SIZE, type GeoMap } from '../formats/geo.js'
import { isSolid } from '../engine/dungeon.js'
import type { PartyState } from '../engine/party.js'

const COLORS = {
  solid: '#0b0d12',
  floor: '#232a36',
  wall: '#8d99ae',
  door: '#c9a227',
  locked: '#e07a5f',
  wizard: '#7aa2f7',
  event: '#5fb87a',
  party: '#ffd166',
}

export function drawMinimap(canvas: HTMLCanvasElement, map: GeoMap, party: PartyState): void {
  const context = canvas.getContext('2d')
  if (!context) return

  const dpr = Math.min(window.devicePixelRatio, 2)
  const size = canvas.clientWidth || 220
  if (canvas.width !== size * dpr) {
    canvas.width = size * dpr
    canvas.height = size * dpr
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  context.clearRect(0, 0, size, size)

  const cellSize = size / MAP_SIZE

  for (const cell of map.cells) {
    const x = cell.col * cellSize
    const y = cell.row * cellSize
    context.fillStyle = isSolid(cell) ? COLORS.solid : COLORS.floor
    context.fillRect(x, y, cellSize, cellSize)

    if (!isSolid(cell) && cell.event !== 0) {
      context.fillStyle = COLORS.event
      context.globalAlpha = 0.55
      context.fillRect(x + cellSize * 0.35, y + cellSize * 0.35, cellSize * 0.3, cellSize * 0.3)
      context.globalAlpha = 1
    }
  }

  context.lineWidth = Math.max(1, cellSize * 0.14)
  context.lineCap = 'square'

  for (const cell of map.cells) {
    if (isSolid(cell)) continue
    const x = cell.col * cellSize
    const y = cell.row * cellSize

    for (const direction of DIRECTIONS) {
      if (cell.walls[direction] === 0 && cell.doors[direction] === DoorState.None) continue

      context.strokeStyle =
        cell.doors[direction] === DoorState.WizardLocked ? COLORS.wizard
          : cell.doors[direction] === DoorState.Locked ? COLORS.locked
            : cell.doors[direction] === DoorState.Door ? COLORS.door
              : COLORS.wall

      context.beginPath()
      switch (direction) {
        case 'north': context.moveTo(x, y); context.lineTo(x + cellSize, y); break
        case 'south': context.moveTo(x, y + cellSize); context.lineTo(x + cellSize, y + cellSize); break
        case 'west': context.moveTo(x, y); context.lineTo(x, y + cellSize); break
        case 'east': context.moveTo(x + cellSize, y); context.lineTo(x + cellSize, y + cellSize); break
      }
      context.stroke()
    }
  }

  // The party, as an arrow pointing the way it faces.
  const cx = (party.col + 0.5) * cellSize
  const cy = (party.row + 0.5) * cellSize
  const radius = cellSize * 0.36
  const angle = { north: -Math.PI / 2, east: 0, south: Math.PI / 2, west: Math.PI }[party.facing]

  context.fillStyle = COLORS.party
  context.beginPath()
  context.moveTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius)
  context.lineTo(cx + Math.cos(angle + 2.5) * radius, cy + Math.sin(angle + 2.5) * radius)
  context.lineTo(cx + Math.cos(angle - 2.5) * radius, cy + Math.sin(angle - 2.5) * radius)
  context.closePath()
  context.fill()
}
