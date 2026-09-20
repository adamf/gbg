/**
 * A minimal PNG writer, so the extractor has no image dependency.
 * Truecolour with alpha, one filter mode, deflated by Node's own zlib.
 */

import { deflateSync } from 'node:zlib'

import type { Rgba } from '../formats/ega.js'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(body)])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([head, Buffer.from(body), tail])
}

/** Encodes an image as a PNG. Scale magnifies by whole pixels, keeping the art crisp. */
export function encodePng(image: Rgba, scale = 1): Buffer {
  const width = image.width * scale
  const height = image.height * scale

  const raw = Buffer.alloc(height * (width * 4 + 1))
  let at = 0
  for (let y = 0; y < height; y++) {
    raw[at++] = 0 // filter: none
    const sy = Math.floor(y / scale)
    for (let x = 0; x < width; x++) {
      const sx = Math.floor(x / scale)
      const from = (sy * image.width + sx) * 4
      raw[at++] = image.pixels[from] ?? 0
      raw[at++] = image.pixels[from + 1] ?? 0
      raw[at++] = image.pixels[from + 2] ?? 0
      raw[at++] = image.pixels[from + 3] ?? 0
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour with alpha
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ])
}
