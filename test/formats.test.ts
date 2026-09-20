import { describe, expect, it } from 'vitest'

import { blocksById, decompressRle, readDax } from '../src/formats/dax.js'
import { detectGame } from '../src/formats/detect.js'
import { decode4bpp, EGA_PALETTE, paletteEntry } from '../src/formats/ega.js'
import { canWalk, cellAt, DoorState, readGeoMap, step } from '../src/formats/geo.js'
import { classifyBlock, decodeImageBlock, isImageBlock, isSpriteBlock } from '../src/formats/image.js'
import { GameLibrary, memorySource } from '../src/formats/library.js'
import { readWallDefBlock, renderWallView, solidify, WALL_SLICE_SIZE } from '../src/formats/walldef.js'
import {
  buildDax, buildEclBlock, buildGeoBlock, buildImageBlock, buildWallDefBlock,
  ECL_CODE_START, eclInstruction, encodeRle,
} from './fixtures.js'

describe('DAX run-length coding', () => {
  it('round-trips a buffer with runs and literals', () => {
    const raw = Uint8Array.from([1, 2, 3, 9, 9, 9, 9, 9, 4, 5, 7, 7, 7])
    expect([...decompressRle(encodeRle(raw), raw.length)]).toEqual([...raw])
  })

  it('expands a pure run', () => {
    const encoded = Uint8Array.from([256 - 5, 0xab])
    expect([...decompressRle(encoded, 5)]).toEqual([0xab, 0xab, 0xab, 0xab, 0xab])
  })

  it('expands a pure literal', () => {
    const encoded = Uint8Array.from([2, 0x10, 0x20, 0x30])
    expect([...decompressRle(encoded, 3)]).toEqual([0x10, 0x20, 0x30])
  })

  it('stops at the declared size when a block over-runs', () => {
    const encoded = Uint8Array.from([256 - 100, 0x7f])
    expect(decompressRle(encoded, 4)).toEqual(Uint8Array.from([0x7f, 0x7f, 0x7f, 0x7f]))
  })

  it('stops cleanly when input is truncated mid-literal', () => {
    const encoded = Uint8Array.from([10, 1, 2, 3])
    expect([...decompressRle(encoded, 11).slice(0, 3)]).toEqual([1, 2, 3])
  })
})

describe('DAX archives', () => {
  const alpha = Uint8Array.from([1, 1, 1, 1, 2, 3, 4])
  const beta = Uint8Array.from(Array.from({ length: 40 }, (_, i) => i % 7))

  it('reads compressed and stored blocks back', () => {
    const archive = readDax('TEST.DAX', buildDax([
      { id: 5, data: alpha },
      { id: 9, data: beta, stored: true },
    ]))

    expect(archive.problems).toEqual([])
    expect(archive.blocks).toHaveLength(2)
    expect([...archive.blocks[0]!.data]).toEqual([...alpha])
    expect(archive.blocks[0]!.stored).toBe(false)
    expect([...archive.blocks[1]!.data]).toEqual([...beta])
    expect(archive.blocks[1]!.stored).toBe(true)
  })

  it('upper-cases the archive name and finds blocks by id', () => {
    const archive = readDax('geo1.dax', buildDax([{ id: 7, data: alpha }]))
    expect(archive.name).toBe('GEO1.DAX')
    expect(blocksById(archive, 7)).toHaveLength(1)
    expect(blocksById(archive, 8)).toHaveLength(0)
  })

  it('reports rather than throws on a truncated file', () => {
    const good = buildDax([{ id: 1, data: alpha }])
    const archive = readDax('BAD.DAX', good.subarray(0, good.length - 4))
    expect(archive.problems.length).toBeGreaterThan(0)
  })

  it('reports an implausible header without throwing', () => {
    const archive = readDax('BAD.DAX', Uint8Array.from([0xff, 0xff, 0x00]))
    expect(archive.blocks).toHaveLength(0)
    expect(archive.problems.length).toBeGreaterThan(0)
  })
})

describe('EGA decoding', () => {
  it('unpacks two pixels per byte, high nibble first', () => {
    const data = Uint8Array.from([0x1f, 0x20])
    const image = decode4bpp(data, 0, 1, 1)
    expect(image.width).toBe(8)
    expect(image.height).toBe(1)
    expect([...image.pixels.slice(0, 4)]).toEqual([...EGA_PALETTE[1]!, 255])
    expect([...image.pixels.slice(4, 8)]).toEqual([...EGA_PALETTE[15]!, 255])
    expect([...image.pixels.slice(8, 12)]).toEqual([...EGA_PALETTE[2]!, 255])
  })

  it('swaps black and transparent for combat art', () => {
    expect(paletteEntry(0, { combat: true, transparentIndex: 0 })[3]).toBe(0)
    expect(paletteEntry(8, { combat: true })).toEqual([0, 0, 0, 255])
  })
})

describe('image blocks', () => {
  it('accepts a well-formed block and reads every frame', () => {
    const block = buildImageBlock(2, 4, 3, (frame) => (frame << 4) | frame)
    expect(isImageBlock(block)).toBe(true)

    const decoded = decodeImageBlock(block, 'PIC1.DAX')
    expect(decoded.frames).toHaveLength(3)
    expect(decoded.frames[0]!.width).toBe(16)
    expect(decoded.frames[0]!.height).toBe(4)
    expect([...decoded.frames[2]!.pixels.slice(0, 4)]).toEqual([...EGA_PALETTE[2]!, 255])
  })

  it('tolerates the Death Knights block with one undeclared extra frame', () => {
    const declared = buildImageBlock(1, 2, 2, () => 0x11)
    const extra = new Uint8Array(declared.length + 2 * 1 * 4)
    extra.set(declared, 0)
    expect(isImageBlock(extra)).toBe(true)
    expect(decodeImageBlock(extra).frames).toHaveLength(3)
  })

  it('rejects a block whose size does not fit the header', () => {
    const block = buildImageBlock(2, 4, 3, () => 0)
    expect(isImageBlock(block.subarray(0, block.length - 3))).toBe(false)
  })

  it('does not mistake a GEO block for a picture', () => {
    const geo = buildGeoBlock(() => ({ n: 1, e: 0, s: 0, w: 2 }))
    expect(isImageBlock(geo)).toBe(false)
    expect(isSpriteBlock(geo)).toBe(false)
    expect(classifyBlock(geo, 'GEO1.DAX')).toBe('geo')
  })
})

describe('GEO levels', () => {
  const block = buildGeoBlock(
    (row, col) => ({ n: row === 0 ? 3 : 0, e: col === 15 ? 4 : 0, s: 0, w: 0 }),
    (row, col) => (row === 5 && col === 5 ? DoorState.Locked << 0 : 0),
    (row, col) => (row === 2 && col === 3 ? 0x80 | 12 : 0),
  )

  it('splits the four planes into cells', () => {
    const map = readGeoMap(4, block)
    expect(map.cells).toHaveLength(256)

    const topLeft = cellAt(map, 0, 0)!
    expect(topLeft.walls.north).toBe(3)
    expect(topLeft.walls.east).toBe(0)

    const topRight = cellAt(map, 0, 15)!
    expect(topRight.walls.north).toBe(3)
    expect(topRight.walls.east).toBe(4)
  })

  it('reads doors two bits at a time', () => {
    const map = readGeoMap(1, block)
    expect(cellAt(map, 5, 5)!.doors.north).toBe(DoorState.Locked)
    expect(cellAt(map, 5, 5)!.doors.east).toBe(DoorState.None)
  })

  it('separates the event number from its flag bit', () => {
    const map = readGeoMap(1, block)
    const cell = cellAt(map, 2, 3)!
    expect(cell.event).toBe(12)
    expect(cell.eventFlag).toBe(true)
  })

  it('walks north as decreasing row', () => {
    expect(step('north')).toEqual({ dRow: -1, dCol: 0 })
    expect(step('east')).toEqual({ dRow: 0, dCol: 1 })
  })

  it('blocks movement through a wall and allows it through a door', () => {
    const walled = buildGeoBlock((row, col) => (row === 4 && col === 4 ? { n: 2, e: 0, s: 0, w: 0 } : { n: 0, e: 0, s: 0, w: 0 }))
    const map = readGeoMap(1, walled)
    expect(canWalk(map, 4, 4, 'north')).toBe(false)
    expect(canWalk(map, 4, 4, 'south')).toBe(true)

    const withDoor = buildGeoBlock(
      (row, col) => (row === 4 && col === 4 ? { n: 2, e: 0, s: 0, w: 0 } : { n: 0, e: 0, s: 0, w: 0 }),
      (row, col) => (row === 4 && col === 4 ? DoorState.Door : 0),
    )
    expect(canWalk(readGeoMap(1, withDoor), 4, 4, 'north')).toBe(true)
  })

  it('respects a wall recorded only on the far side', () => {
    const map = readGeoMap(1, buildGeoBlock((row, col) => (row === 3 && col === 4 ? { n: 0, e: 0, s: 5, w: 0 } : { n: 0, e: 0, s: 0, w: 0 })))
    expect(canWalk(map, 4, 4, 'north')).toBe(false)
  })

  it('will not walk off the edge of the level', () => {
    const map = readGeoMap(1, buildGeoBlock(() => ({ n: 0, e: 0, s: 0, w: 0 })))
    expect(canWalk(map, 0, 0, 'north')).toBe(false)
    expect(canWalk(map, 15, 15, 'south')).toBe(false)
  })
})

describe('wall definitions', () => {
  it('cuts a wall into ten views that tile the 156-byte slice', () => {
    const walls = readWallDefBlock(buildWallDefBlock(2, (_, byte) => byte))
    expect(walls).toHaveLength(2)

    const views = walls[0]!.views
    expect(views).toHaveLength(10)
    expect(views.reduce((n, v) => n + v.rows * v.cols, 0)).toBe(WALL_SLICE_SIZE)

    // Each view's tile bytes are the slice bytes at its own offset, in order.
    expect(views[0]!.tiles).toEqual([0, 1])
    expect(views[1]!.tiles).toEqual([2, 3, 4, 5])
    expect(views[6]!.rows).toBe(8)
    expect(views[6]!.cols).toBe(7)
    expect(views[9]!.tiles).toEqual([154, 155])
  })

  it('reads a second wall from its own slice', () => {
    const walls = readWallDefBlock(buildWallDefBlock(2, (wall, byte) => (wall === 1 ? 200 + (byte % 5) : byte)))
    expect(walls[1]!.views[0]!.tiles).toEqual([200, 201])
  })

  it('fills a view\'s blank tiles so a wall has no holes in it', () => {
    const image = {
      width: 2, height: 1,
      pixels: new Uint8ClampedArray([200, 100, 50, 255, 0, 0, 0, 0]),
    }
    const solid = solidify(image)
    expect(solid.pixels[7]).toBe(255)
    // The fill is the opaque average, darkened.
    expect(solid.pixels[4]).toBe(Math.round(200 * 0.62))
    expect(solid.pixels[5]).toBe(Math.round(100 * 0.62))
  })

  it('leaves a fully opaque view alone', () => {
    const image = { width: 1, height: 1, pixels: new Uint8ClampedArray([9, 9, 9, 255]) }
    expect(solidify(image)).toBe(image)
  })

  it('leaves a fully blank view alone rather than inventing a colour', () => {
    const image = { width: 1, height: 1, pixels: new Uint8ClampedArray([0, 0, 0, 0]) }
    expect(solidify(image)).toBe(image)
  })

  it('stamps tiles into the view and leaves index 0 transparent', () => {
    const red = { width: 8, height: 8, pixels: new Uint8ClampedArray(8 * 8 * 4).fill(255) }
    const view = { index: 0, rows: 2, cols: 1, tiles: [0, 1] }
    const image = renderWallView(view, [red, red])

    expect(image.width).toBe(8)
    expect(image.height).toBe(16)
    expect(image.pixels[3]).toBe(0) // tile 0 left transparent
    expect(image.pixels[8 * 8 * 4 + 3]).toBe(255) // tile 1 painted
  })
})

describe('game detection', () => {
  it('recognises Pool of Radiance by its config file', () => {
    expect(detectGame(['POOL.CFG', 'GEO1.DAX']).id).toBe('pool-of-radiance')
  })

  it('tells the two GAME.CFG games apart', () => {
    expect(detectGame(['GAME.CFG', '8X8D6.DAX']).id).toBe('gateway-to-the-savage-frontier')
    expect(detectGame(['GAME.CFG', 'CPIC.DAX']).id).toBe('neverwinter-nights')
  })

  it('is case insensitive and ignores directories', () => {
    expect(detectGame(['/games/por/pool.cfg']).id).toBe('pool-of-radiance')
  })

  it('says so when it does not know', () => {
    expect(detectGame(['README.TXT']).id).toBe('unknown')
  })
})

describe('GameLibrary', () => {
  const MEM = 0x9900
  const codeAt = (offset: number) => MEM + ECL_CODE_START + offset

  /**
   * A script for map 21: it loads the map, loads wall sets 30/31/32, then dispatches
   * six events, one of which speaks.
   */
  function eclArchive() {
    const handlers = Array.from({ length: 6 }, (_, i) => codeAt(200 + i * 24))
    return buildDax([{
      id: 1,
      data: buildEclBlock({
        memStart: MEM,
        header: [codeAt(0), codeAt(0), codeAt(0), codeAt(0), codeAt(0)],
        size: 0x900,
        code: [
          {
            at: codeAt(0),
            bytes: [
              ...eclInstruction(0x21, [{ imm: 21 }, { imm: 0 }, { imm: 0 }]),
              ...eclInstruction(0x37, [{ imm: 30 }, { imm: 31 }, { imm: 32 }]),
              ...eclInstruction(0x25, [
                { mem: 0x9a00 }, { imm: 6 },
                ...handlers.map((h) => ({ word: h })),
              ]),
              ...eclInstruction(0x00),
            ],
          },
          ...handlers.map((h, i) => ({
            at: h,
            bytes: [
              ...eclInstruction(0x11, [{ str: `YOU SEE ROOM ${i}` }]),
              ...eclInstruction(0x13),
            ],
          })),
        ],
      }),
    }])
  }

  function library() {
    const geo = buildDax([{ id: 21, data: buildGeoBlock(() => ({ n: 1, e: 0, s: 0, w: 0 })) }])
    const wallDef = buildDax([{ id: 21, data: buildWallDefBlock(5, () => 1) }])
    // One 8x8 tile block: 2 solid tiles at block 203, plus tiles for the wall set.
    const tiles = buildDax([
      { id: 203, data: buildImageBlock(1, 8, 2, () => 0x77) },
      { id: 21, data: buildImageBlock(1, 8, 4, () => 0x44) },
    ])

    return new GameLibrary(memorySource(new Map([
      ['POOL.CFG', Uint8Array.from([0])],
      ['GEO1.DAX', geo],
      ['WALLDEF1.DAX', wallDef],
      ['8X8D1.DAX', tiles],
      ['ECL1.DAX', eclArchive()],
    ])))
  }

  /** The same folder without its scripts, to check the fallbacks. */
  function libraryWithoutEcl() {
    const geo = buildDax([{ id: 21, data: buildGeoBlock(() => ({ n: 1, e: 0, s: 0, w: 0 })) }])
    const wallDef = buildDax([{ id: 21, data: buildWallDefBlock(5, () => 1) }])
    const tiles = buildDax([
      { id: 203, data: buildImageBlock(1, 8, 2, () => 0x77) },
      { id: 21, data: buildImageBlock(1, 8, 4, () => 0x44) },
    ])
    return new GameLibrary(memorySource(new Map([
      ['POOL.CFG', Uint8Array.from([0])],
      ['GEO1.DAX', geo],
      ['WALLDEF1.DAX', wallDef],
      ['8X8D1.DAX', tiles],
    ])))
  }

  it('detects the game and lists named levels', async () => {
    const lib = library()
    expect(lib.game.id).toBe('pool-of-radiance')

    const levels = await lib.levels()
    expect(levels).toHaveLength(1)
    expect(levels[0]!.name).toBe('Sokal Keep')
  })

  it('loads a level as a grid', async () => {
    const lib = library()
    const map = await lib.level((await lib.levels())[0]!)
    expect(map!.cells).toHaveLength(256)
    expect(map!.cells[0]!.walls.north).toBe(1)
  })

  it('renders the level wall textures', async () => {
    const lib = libraryWithoutEcl()
    const wallSet = await lib.wallSetFor((await lib.levels())[0]!)
    expect(wallSet.textures).toHaveLength(5)
    expect(wallSet.textures[0]!.width).toBe(56)
    expect(wallSet.textures[0]!.height).toBe(64)
    expect(wallSet.sources[0]).toMatchObject({ file: 'WALLDEF1.DAX', blockId: 21 })
  })

  it('finds the level script by the map it loads', async () => {
    const lib = library()
    const program = await lib.eclForLevel((await lib.levels())[0]!)
    expect(program).toBeDefined()
    expect(program!.loadsMaps).toContain(21)
    expect(program!.loadsWallSets[0]).toEqual([30, 31, 32])
  })

  it('takes the wall sets from the script rather than guessing', async () => {
    const lib = library()
    const wallSet = await lib.wallSetFor((await lib.levels())[0]!)
    // The script asks for 30/31/32, none of which exist in this folder, so nothing
    // is rendered — which is the honest answer, not a silent fallback to block 21.
    expect(wallSet.sources).toEqual([])
    expect(wallSet.textures).toEqual([])
  })

  it('falls back to the matching block id when there is no script', async () => {
    const lib = libraryWithoutEcl()
    const wallSet = await lib.wallSetFor((await lib.levels())[0]!)
    expect(wallSet.sources[0]).toMatchObject({ blockId: 21 })
  })

  it('reads what each event on the level says', async () => {
    const lib = library()
    const events = await lib.eventsFor((await lib.levels())[0]!)
    expect(events!.summaries.size).toBe(6)
    expect(events!.summaries.get(3)!.text).toEqual(['YOU SEE ROOM 3'])
    expect(events!.summaries.get(0)!.fights).toBe(false)
  })
})
