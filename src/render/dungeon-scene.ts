/**
 * Builds the level as real geometry.
 *
 * The original faked depth by picking one of ten pre-drawn views per wall. Here the
 * walls are actually where the data says they are and the perspective is the camera's,
 * so you can stand in a doorway, look down a corridor at an angle, and see the corner
 * the 1988 renderer could only imply.
 *
 * Quads are merged per wall graphic, which keeps a whole level to a handful of draw
 * calls instead of one per face.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  type Material,
} from 'three'

import type { Rgba } from '../formats/ega.js'
import { DoorState, type Direction, type GeoMap } from '../formats/geo.js'
import { isSolid, wallFaces } from '../engine/dungeon.js'
import { colorTexture, normalTextureFrom, stoneTexture } from './textures.js'

/** World units per map square, and how tall a wall stands. */
export const CELL = 3
export const WALL_HEIGHT = 3.2

type Vec3 = readonly [number, number, number]

/** Inward normal and the tangent that keeps a wall's texture the right way round. */
const FACE_BASIS: Record<Direction, { normal: Vec3; tangent: Vec3; offset: Vec3 }> = {
  north: { normal: [0, 0, 1], tangent: [1, 0, 0], offset: [0, 0, -CELL / 2] },
  south: { normal: [0, 0, -1], tangent: [-1, 0, 0], offset: [0, 0, CELL / 2] },
  east: { normal: [-1, 0, 0], tangent: [0, 0, 1], offset: [CELL / 2, 0, 0] },
  west: { normal: [1, 0, 0], tangent: [0, 0, -1], offset: [-CELL / 2, 0, 0] },
}

/** World position of a map square's centre. North is -z, east is +x. */
export function cellToWorld(row: number, col: number): { x: number; z: number } {
  return { x: col * CELL, z: row * CELL }
}

class QuadBuilder {
  private readonly positions: number[] = []
  private readonly normals: number[] = []
  private readonly uvs: number[] = []

  /** Adds a quad from its bottom-left corner, across `right`, up `up`. */
  add(origin: Vec3, right: Vec3, up: Vec3, normal: Vec3, uvScale: readonly [number, number] = [1, 1]): void {
    const bl = origin
    const br: Vec3 = [origin[0] + right[0], origin[1] + right[1], origin[2] + right[2]]
    const tl: Vec3 = [origin[0] + up[0], origin[1] + up[1], origin[2] + up[2]]
    const tr: Vec3 = [br[0] + up[0], br[1] + up[1], br[2] + up[2]]

    const [us, vs] = uvScale
    this.triangle(bl, br, tr, normal, [0, 0], [us, 0], [us, vs])
    this.triangle(bl, tr, tl, normal, [0, 0], [us, vs], [0, vs])
  }

  private triangle(
    a: Vec3, b: Vec3, c: Vec3,
    normal: Vec3,
    uvA: readonly [number, number], uvB: readonly [number, number], uvC: readonly [number, number],
  ): void {
    for (const v of [a, b, c]) this.positions.push(v[0], v[1], v[2])
    for (let i = 0; i < 3; i++) this.normals.push(normal[0], normal[1], normal[2])
    this.uvs.push(uvA[0], uvA[1], uvB[0], uvB[1], uvC[0], uvC[1])
  }

  get isEmpty(): boolean {
    return this.positions.length === 0
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(Float32Array.from(this.positions), 3))
    geometry.setAttribute('normal', new BufferAttribute(Float32Array.from(this.normals), 3))
    geometry.setAttribute('uv', new BufferAttribute(Float32Array.from(this.uvs), 2))
    geometry.computeBoundingSphere()
    return geometry
  }
}

export interface BuiltLevel {
  group: Group
  dispose(): void
}

export interface BuildOptions {
  /** Wall textures indexed from 0, where wall type 1 is textures[0]. */
  wallTextures: readonly Rgba[]
  /** Seed for the procedural floor, so a level looks the same each visit. */
  seed?: number
}

/** Assembles a whole level: floor, ceiling, walls and doors. */
export function buildLevel(map: GeoMap, options: BuildOptions): BuiltLevel {
  const group = new Group()
  const materials: Material[] = []
  const disposables: { dispose(): void }[] = []

  const track = <T extends { dispose(): void }>(thing: T): T => {
    disposables.push(thing)
    return thing
  }

  // ---- floor and ceiling -------------------------------------------------
  const floorQuads = new QuadBuilder()
  const ceilingQuads = new QuadBuilder()

  for (const cell of map.cells) {
    if (isSolid(cell)) continue
    const { x, z } = cellToWorld(cell.row, cell.col)
    const half = CELL / 2

    floorQuads.add([x - half, 0, z + half], [CELL, 0, 0], [0, 0, -CELL], [0, 1, 0])
    // Wound the other way so the ceiling faces down.
    ceilingQuads.add([x - half, WALL_HEIGHT, z - half], [CELL, 0, 0], [0, 0, CELL], [0, -1, 0])
  }

  const floorImage = stoneTexture(128, options.seed ?? map.id, [88, 82, 74])
  const ceilingImage = stoneTexture(128, (options.seed ?? map.id) ^ 0x5bf0, [74, 70, 78])

  if (!floorQuads.isEmpty) {
    const material = track(new MeshStandardMaterial({
      map: track(tiled(colorTexture(floorImage))),
      normalMap: track(tiled(normalTextureFrom(floorImage, 1.2))),
      roughness: 0.95,
      metalness: 0.0,
    }))
    materials.push(material)
    group.add(new Mesh(track(floorQuads.build()), material))
  }

  if (!ceilingQuads.isEmpty) {
    const material = track(new MeshStandardMaterial({
      map: track(tiled(colorTexture(ceilingImage))),
      normalMap: track(tiled(normalTextureFrom(ceilingImage, 1.0))),
      roughness: 1.0,
      metalness: 0.0,
    }))
    materials.push(material)
    group.add(new Mesh(track(ceilingQuads.build()), material))
  }

  // ---- walls, merged per graphic ----------------------------------------
  const byWallType = new Map<number, QuadBuilder>()

  for (const face of wallFaces(map)) {
    let builder = byWallType.get(face.wallType)
    if (!builder) {
      builder = new QuadBuilder()
      byWallType.set(face.wallType, builder)
    }

    const basis = FACE_BASIS[face.direction]
    const { x, z } = cellToWorld(face.row, face.col)
    const half = CELL / 2
    const origin: Vec3 = [
      x + basis.offset[0] - basis.tangent[0] * half,
      0,
      z + basis.offset[2] - basis.tangent[2] * half,
    ]
    const right: Vec3 = [basis.tangent[0] * CELL, 0, basis.tangent[2] * CELL]
    builder.add(origin, right, [0, WALL_HEIGHT, 0], basis.normal)
  }

  for (const [wallType, builder] of byWallType) {
    const image = options.wallTextures[wallType - 1]
    const material = track(image
      ? new MeshStandardMaterial({
          map: track(colorTexture(image)),
          normalMap: track(normalTextureFrom(image, 2.2)),
          roughness: 0.9,
          metalness: 0.05,
        })
      // A wall the data references but no loaded wall set provides. Showing plain
      // stone beats showing nothing and walking through a hole in the level.
      : new MeshStandardMaterial({ color: 0x6b6257, roughness: 1.0 }))
    materials.push(material)
    group.add(new Mesh(track(builder.build()), material))
  }

  // ---- doors -------------------------------------------------------------
  const doorQuads = new Map<DoorState, QuadBuilder>()

  for (const face of wallFaces(map)) {
    if (face.door === DoorState.None) continue
    let builder = doorQuads.get(face.door)
    if (!builder) {
      builder = new QuadBuilder()
      doorQuads.set(face.door, builder)
    }

    const basis = FACE_BASIS[face.direction]
    const { x, z } = cellToWorld(face.row, face.col)
    const doorWidth = CELL * 0.62
    const doorHeight = WALL_HEIGHT * 0.78
    // Stand the panel just clear of the wall so it reads as a door in a frame.
    const lift = 0.06
    const origin: Vec3 = [
      x + basis.offset[0] + basis.normal[0] * lift - basis.tangent[0] * (doorWidth / 2),
      0,
      z + basis.offset[2] + basis.normal[2] * lift - basis.tangent[2] * (doorWidth / 2),
    ]
    builder.add(origin, [basis.tangent[0] * doorWidth, 0, basis.tangent[2] * doorWidth], [0, doorHeight, 0], basis.normal)
  }

  for (const [state, builder] of doorQuads) {
    const material = track(doorMaterial(state))
    materials.push(material)
    group.add(new Mesh(track(builder.build()), material))
  }

  return {
    group,
    dispose() {
      for (const thing of disposables) thing.dispose()
      group.clear()
    },
  }
}

function tiled<T extends { wrapS: number; wrapT: number; repeat: { set(x: number, y: number): void } }>(texture: T): T {
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.repeat.set(1, 1)
  return texture
}

/** Doors read at a glance: plain wood, banded iron when locked, lit when wizard-locked. */
function doorMaterial(state: DoorState): MeshStandardMaterial {
  switch (state) {
    case DoorState.Locked:
      return new MeshStandardMaterial({ color: 0x4a3b2a, roughness: 0.55, metalness: 0.6, side: DoubleSide })
    case DoorState.WizardLocked:
      return new MeshStandardMaterial({
        color: 0x2a2f52, roughness: 0.4, metalness: 0.3,
        emissive: 0x3355cc, emissiveIntensity: 0.55, side: DoubleSide,
      })
    default:
      return new MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.85, metalness: 0.05, side: DoubleSide })
  }
}
