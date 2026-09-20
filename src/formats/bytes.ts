/**
 * Little-endian readers. Every Gold Box structure is little-endian 8086 data,
 * so these are the only accessors the format code uses.
 */

export function u8(data: Uint8Array, offset: number): number {
  const b = data[offset]
  if (b === undefined) throw new RangeError(`u8 read past end at ${offset} (length ${data.length})`)
  return b
}

export function u16(data: Uint8Array, offset: number): number {
  return u8(data, offset) | (u8(data, offset + 1) << 8)
}

export function u32(data: Uint8Array, offset: number): number {
  return (u16(data, offset) | (u16(data, offset + 2) << 16)) >>> 0
}

/** Signed 32-bit, as used by the DAX header's block offset field. */
export function i32(data: Uint8Array, offset: number): number {
  return u32(data, offset) | 0
}

/** Signed 8-bit, as used by the DAX run-length opcode. */
export function i8(data: Uint8Array, offset: number): number {
  return (u8(data, offset) << 24) >> 24
}

/** True when `data` has at least `count` bytes from `offset`. */
export function has(data: Uint8Array, offset: number, count: number): boolean {
  return offset >= 0 && count >= 0 && offset + count <= data.length
}
