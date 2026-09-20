/**
 * The first-person view: camera, torch, and the step-and-turn feel of the originals.
 *
 * The party still stands on squares and still turns ninety degrees at a time — that
 * is the game, and smoothing it into free movement would be a different one. What is
 * new is that the steps and turns are interpolated, so the world swings past instead
 * of snapping, and the torch moves with you.
 */

import {
  ACESFilmicToneMapping,
  AmbientLight,
  Clock,
  Color,
  FogExp2,
  Group,
  PerspectiveCamera,
  PointLight,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three'

import type { Rgba } from '../formats/ega.js'
import type { GeoMap } from '../formats/geo.js'
import { startingCell, startingFacing } from '../engine/dungeon.js'
import {
  backward, forward, headingRadians, strafeLeft, strafeRight,
  turnAround, turnLeft, turnRight, type PartyState,
} from '../engine/party.js'
import { buildLevel, cellToWorld, CELL, WALL_HEIGHT, type BuiltLevel } from './dungeon-scene.js'

const EYE_HEIGHT = WALL_HEIGHT * 0.52
const STEP_SECONDS = 0.24
const TURN_SECONDS = 0.2
/** How hard a blocked step pushes into the wall before bouncing back. */
const BUMP_DISTANCE = 0.18

export interface ViewerEvents {
  onMove?(state: PartyState): void
  onBlocked?(state: PartyState): void
}

type Motion =
  | { kind: 'idle' }
  | { kind: 'step'; from: { x: number; z: number }; to: { x: number; z: number }; t: number }
  | { kind: 'bump'; from: { x: number; z: number }; toward: { x: number; z: number }; t: number }
  | { kind: 'turn'; from: number; to: number; t: number }

export class DungeonViewer {
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera: PerspectiveCamera
  private readonly torch: PointLight
  private readonly clock = new Clock()
  private readonly levelRoot = new Group()

  private level?: BuiltLevel
  private map?: GeoMap
  private party: PartyState = { row: 0, col: 0, facing: 'north' }
  private motion: Motion = { kind: 'idle' }
  private heading = 0
  private position = { x: 0, z: 0 }
  private running = false
  private queued: (() => void)[] = []

  constructor(private readonly canvas: HTMLCanvasElement, private readonly events: ViewerEvents = {}) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.toneMapping = ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.15

    this.camera = new PerspectiveCamera(72, 1, 0.05, 120)
    this.camera.position.set(0, EYE_HEIGHT, 0)

    this.scene.background = new Color(0x05060a)
    this.scene.fog = new FogExp2(0x05060a, 0.075)
    this.scene.add(this.levelRoot)

    // Just enough ambient that unlit stone is dark rather than absent.
    this.scene.add(new AmbientLight(0x46506a, 0.5))

    this.torch = new PointLight(0xffb066, 22, CELL * 7, 1.8)
    this.torch.position.set(0, EYE_HEIGHT + 0.3, 0)
    this.camera.add(this.torch)
    this.scene.add(this.camera)

    this.resize()
  }

  /** Swaps in a level and drops the party somewhere it can stand. */
  load(map: GeoMap, wallTextures: readonly Rgba[]): void {
    this.level?.dispose()
    this.levelRoot.clear()

    this.map = map
    this.level = buildLevel(map, { wallTextures })
    this.levelRoot.add(this.level.group)

    const cell = startingCell(map)
    this.party = { row: cell.row, col: cell.col, facing: startingFacing(map, cell) }
    this.motion = { kind: 'idle' }
    this.heading = headingRadians(this.party.facing)
    this.position = cellToWorld(this.party.row, this.party.col)
    this.applyCamera()
    this.events.onMove?.(this.party)
  }

  get state(): PartyState {
    return this.party
  }

  /** Puts the party somewhere with no animation: a script moved them. */
  setParty(state: PartyState): void {
    this.party = { ...state }
    this.motion = { kind: 'idle' }
    this.heading = headingRadians(state.facing)
    this.position = cellToWorld(state.row, state.col)
    this.applyCamera()
    this.events.onMove?.(this.party)
    this.drain()
  }

  get isMoving(): boolean {
    return this.motion.kind !== 'idle'
  }

  /** Queues a command so held keys feel like steady walking rather than dropped input. */
  command(name: 'forward' | 'back' | 'left' | 'right' | 'turnLeft' | 'turnRight' | 'turnAround'): void {
    if (this.queued.length > 1) return
    this.queued.push(() => this.begin(name))
    if (!this.isMoving) this.drain()
  }

  private drain(): void {
    const next = this.queued.shift()
    next?.()
  }

  private begin(name: Parameters<DungeonViewer['command']>[0]): void {
    const map = this.map
    if (!map) return

    if (name === 'turnLeft' || name === 'turnRight' || name === 'turnAround') {
      const turned = name === 'turnLeft' ? turnLeft(this.party) : name === 'turnRight' ? turnRight(this.party) : turnAround(this.party)
      const from = this.heading
      let to = headingRadians(turned.facing)
      // Turn the short way round, so west-to-north does not spin three quarters.
      while (to - from > Math.PI) to -= Math.PI * 2
      while (to - from < -Math.PI) to += Math.PI * 2

      this.party = turned
      this.motion = { kind: 'turn', from, to, t: 0 }
      this.events.onMove?.(this.party)
      return
    }

    const move =
      name === 'forward' ? forward(map, this.party)
        : name === 'back' ? backward(map, this.party)
          : name === 'left' ? strafeLeft(map, this.party)
            : strafeRight(map, this.party)

    if (move.moved) {
      const from = { ...this.position }
      const to = cellToWorld(move.state.row, move.state.col)
      this.party = move.state
      this.motion = { kind: 'step', from, to, t: 0 }
      this.events.onMove?.(this.party)
    } else {
      // Nudge into the wall and back: the party found the edge of the map.
      const heading = this.heading + (name === 'back' ? Math.PI : name === 'left' ? Math.PI / 2 : name === 'right' ? -Math.PI / 2 : 0)
      const toward = {
        x: this.position.x - Math.sin(heading) * BUMP_DISTANCE,
        z: this.position.z - Math.cos(heading) * BUMP_DISTANCE,
      }
      this.motion = { kind: 'bump', from: { ...this.position }, toward, t: 0 }
      this.events.onBlocked?.(this.party)
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.clock.start()
    this.renderer.setAnimationLoop(() => this.frame())
  }

  stop(): void {
    this.running = false
    this.renderer.setAnimationLoop(null)
  }

  resize(): void {
    const width = this.canvas.clientWidth || 1
    const height = this.canvas.clientHeight || 1
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  dispose(): void {
    this.stop()
    this.level?.dispose()
    this.renderer.dispose()
  }

  private frame(): void {
    const delta = Math.min(this.clock.getDelta(), 0.1)
    this.advance(delta)
    this.flicker()
    this.renderer.render(this.scene, this.camera)
  }

  private advance(delta: number): void {
    const motion = this.motion
    if (motion.kind === 'idle') return

    const duration = motion.kind === 'turn' ? TURN_SECONDS : motion.kind === 'bump' ? STEP_SECONDS * 0.55 : STEP_SECONDS
    const t = Math.min(1, motion.t + delta / duration)
    this.motion = { ...motion, t }

    if (motion.kind === 'turn') {
      this.heading = motion.from + (motion.to - motion.from) * easeInOut(t)
    } else if (motion.kind === 'step') {
      const e = easeInOut(t)
      this.position = {
        x: motion.from.x + (motion.to.x - motion.from.x) * e,
        z: motion.from.z + (motion.to.z - motion.from.z) * e,
      }
    } else {
      // Out and back within the one motion.
      const e = Math.sin(t * Math.PI)
      this.position = {
        x: motion.from.x + (motion.toward.x - motion.from.x) * e,
        z: motion.from.z + (motion.toward.z - motion.from.z) * e,
      }
    }

    this.applyCamera()

    if (t >= 1) {
      this.heading = headingRadians(this.party.facing)
      this.position = cellToWorld(this.party.row, this.party.col)
      this.applyCamera()
      this.motion = { kind: 'idle' }
      this.drain()
    }
  }

  private applyCamera(): void {
    this.camera.position.set(this.position.x, EYE_HEIGHT, this.position.z)
    this.camera.rotation.set(0, this.heading, 0)
  }

  /** A torch is never steady. Two out-of-phase waves keep it from reading as a pulse. */
  private flicker(): void {
    const t = this.clock.elapsedTime
    const wobble = Math.sin(t * 11.3) * 0.5 + Math.sin(t * 4.7) * 0.3 + Math.sin(t * 23.1) * 0.2
    this.torch.intensity = 22 + wobble * 2.4
  }
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
}
