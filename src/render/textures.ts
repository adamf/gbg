/**
 * Getting 1988 pixels onto 2026 surfaces.
 *
 * The art stays exactly as SSI drew it — nearest-neighbour magnification, no
 * smoothing, no repainting. What is new is everything around it: a normal map
 * derived from the art's own light and shade so a torch rakes across the stone,
 * mipmaps and anisotropy so distant walls stop shimmering, and procedural floors
 * for the surfaces the data never described.
 */

import {
  DataTexture,
  LinearMipmapLinearFilter,
  NearestFilter,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  type Texture,
} from 'three'

import type { Rgba } from '../formats/ega.js'

/** Wraps decoded pixels as a colour texture, crisp up close and stable far away. */
export function colorTexture(image: Rgba, anisotropy = 8): DataTexture {
  const texture = new DataTexture(
    Uint8Array.from(image.pixels),
    image.width,
    image.height,
    RGBAFormat,
    UnsignedByteType,
  )
  texture.colorSpace = SRGBColorSpace
  texture.magFilter = NearestFilter
  texture.minFilter = LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = anisotropy
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.needsUpdate = true
  return texture
}

function luminanceAt(image: Rgba, x: number, y: number): number {
  const cx = Math.min(image.width - 1, Math.max(0, x))
  const cy = Math.min(image.height - 1, Math.max(0, y))
  const at = (cy * image.width + cx) * 4
  const r = image.pixels[at] ?? 0
  const g = image.pixels[at + 1] ?? 0
  const b = image.pixels[at + 2] ?? 0
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/**
 * Builds a normal map by reading the painted highlights as height.
 *
 * Pixel artists drew their own lighting — bright edges on top of a stone, dark
 * under it — so treating luminance as height recovers roughly the relief the
 * artist had in mind, and a moving torch then agrees with the painting.
 */
export function normalTextureFrom(image: Rgba, strength = 2.0): DataTexture {
  const pixels = new Uint8Array(image.width * image.height * 4)

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      // Sobel over luminance.
      const tl = luminanceAt(image, x - 1, y - 1)
      const t = luminanceAt(image, x, y - 1)
      const tr = luminanceAt(image, x + 1, y - 1)
      const l = luminanceAt(image, x - 1, y)
      const r = luminanceAt(image, x + 1, y)
      const bl = luminanceAt(image, x - 1, y + 1)
      const b = luminanceAt(image, x, y + 1)
      const br = luminanceAt(image, x + 1, y + 1)

      const dx = tl + 2 * l + bl - (tr + 2 * r + br)
      const dy = tl + 2 * t + tr - (bl + 2 * b + br)

      const nx = dx * strength
      const ny = dy * strength
      const nz = 1
      const length = Math.hypot(nx, ny, nz) || 1

      const at = (y * image.width + x) * 4
      pixels[at] = Math.round(((nx / length) * 0.5 + 0.5) * 255)
      pixels[at + 1] = Math.round(((ny / length) * 0.5 + 0.5) * 255)
      pixels[at + 2] = Math.round(((nz / length) * 0.5 + 0.5) * 255)
      pixels[at + 3] = 255
    }
  }

  const texture = new DataTexture(pixels, image.width, image.height, RGBAFormat, UnsignedByteType)
  texture.magFilter = NearestFilter
  texture.minFilter = LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.needsUpdate = true
  return texture
}

/** Deterministic value noise, so a level looks the same every time it is opened. */
function noiseField(size: number, seed: number): Float32Array {
  const field = new Float32Array(size * size)
  let state = seed >>> 0
  for (let i = 0; i < field.length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0
    field[i] = state / 0xffffffff
  }
  return field
}

function smoothAt(field: Float32Array, size: number, x: number, y: number, scale: number): number {
  const sx = (x / scale) % size
  const sy = (y / scale) % size
  const x0 = Math.floor(sx)
  const y0 = Math.floor(sy)
  const fx = sx - x0
  const fy = sy - y0
  const at = (cx: number, cy: number) => field[(((cy % size) + size) % size) * size + (((cx % size) + size) % size)]!
  const ease = (t: number) => t * t * (3 - 2 * t)
  const ex = ease(fx)
  const ey = ease(fy)
  const top = at(x0, y0) * (1 - ex) + at(x0 + 1, y0) * ex
  const bottom = at(x0, y0 + 1) * (1 - ex) + at(x0 + 1, y0 + 1) * ex
  return top * (1 - ey) + bottom * ey
}

/**
 * A tileable stone surface for floors and ceilings, which the level data never
 * describes — the original drew a flat colour band and left the rest to imagination.
 * Tinted to sit under the art rather than compete with it.
 */
export function stoneTexture(size = 128, seed = 1337, tint: [number, number, number] = [86, 80, 72]): Rgba {
  const coarse = noiseField(size, seed)
  const fine = noiseField(size, seed ^ 0x9e3779b9)
  const pixels = new Uint8ClampedArray(size * size * 4)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const base = smoothAt(coarse, size, x, y, 16) * 0.6 + smoothAt(fine, size, x, y, 4) * 0.4
      // Mortar lines on a 32-pixel block grid, offset every other course.
      const course = Math.floor(y / 32)
      const offset = (course % 2) * 16
      const inMortar = y % 32 < 2 || (x + offset) % 32 < 2
      const shade = inMortar ? 0.55 : 0.8 + base * 0.45

      const at = (y * size + x) * 4
      pixels[at] = tint[0] * shade
      pixels[at + 1] = tint[1] * shade
      pixels[at + 2] = tint[2] * shade
      pixels[at + 3] = 255
    }
  }

  return { width: size, height: size, pixels }
}

export function disposeTextures(textures: readonly (Texture | undefined)[]): void {
  for (const texture of textures) texture?.dispose()
}
