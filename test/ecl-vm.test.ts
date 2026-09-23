import { describe, expect, it } from 'vitest'

import { EclMemory, EclVm, MAPPED, type EclHost, type VmWorld } from '../src/engine/ecl-vm.js'
import { buildEclBlock, ECL_CODE_START, eclInstruction, type EclArg } from './fixtures.js'

const MEM = 0x9900
const at = (offset: number) => MEM + ECL_CODE_START + offset

const EXIT = 0x00, GOSUB = 0x02, COMPARE = 0x03, ADD = 0x04, SUBTRACT = 0x05
const RANDOM = 0x08, SAVE = 0x09, PRINT = 0x11, PRINTCLEAR = 0x12, RETURN = 0x13
const VMENU = 0x15, IF_EQ = 0x16, IF_NE = 0x17, IF_LT = 0x18, NEW_ECL = 0x20, LOAD_FILES = 0x21
const ON_GOTO = 0x25, GET_TABLE = 0x2a, AND = 0x2f, LOAD_PIECES = 0x37

/** Lays instructions out back to back from the code start and returns their addresses. */
function assemble(pieces: (number[] | { at: number; bytes: number[] })[]) {
  const code: { at: number; bytes: number[] }[] = []
  let cursor = at(0)
  for (const piece of pieces) {
    if (Array.isArray(piece)) {
      code.push({ at: cursor, bytes: piece })
      cursor += piece.length
    } else {
      code.push(piece)
    }
  }
  return buildEclBlock({ memStart: MEM, header: [at(0), at(0), at(0), at(0), at(0)], code, size: 0x900 })
}

function ins(opcode: number, ...args: EclArg[]): number[] {
  return eclInstruction(opcode, args)
}

async function runProgram(block: Uint8Array, host: EclHost = {}, world?: VmWorld) {
  const memory = new EclMemory()
  memory.loadImage(block, MEM)
  memory.world = world
  const vm = new EclVm(memory, host)
  const result = await vm.run(at(0))
  return { memory, vm, result }
}

function recordingHost() {
  const printed: string[] = []
  const host: EclHost = { print: (text, clear) => { printed.push((clear ? '!' : '') + text) } }
  return { host, printed }
}

describe('arithmetic and memory', () => {
  it('saves, adds and subtracts in the operand order the original used', async () => {
    const { memory } = await runProgram(assemble([
      ins(SAVE, { imm: 5 }, { mem: 0x4a00 }),
      ins(ADD, { imm: 3 }, { mem: 0x4a00 }, { mem: 0x4a01 }),
      ins(SUBTRACT, { imm: 2 }, { mem: 0x4a01 }, { mem: 0x4a02 }), // b - a
      ins(EXIT),
    ]))
    expect(memory.read(0x4a00)).toBe(5)
    expect(memory.read(0x4a01)).toBe(8)
    expect(memory.read(0x4a02)).toBe(6)
  })

  it('reads a table entry out of the script image', async () => {
    const table = at(100)
    const { memory } = await runProgram(assemble([
      ins(GET_TABLE, { mem: table }, { imm: 2 }, { mem: 0x4a00 }),
      ins(EXIT),
      { at: table, bytes: [10, 20, 30, 40] },
    ]))
    expect(memory.read(0x4a00)).toBe(30)
  })

  it('stores a string and prints it back through a pointer', async () => {
    const { host, printed } = recordingHost()
    await runProgram(assemble([
      ins(SAVE, { str: ' GOBLINS' }, { mem: 0x9800 }),
      ins(PRINT, { strAt: 0x9800 }),
      ins(EXIT),
    ]), host)
    expect(printed).toEqual([' GOBLINS'])
  })
})

describe('branching', () => {
  it('runs the instruction after IF only when the compare flag holds', async () => {
    const { host, printed } = recordingHost()
    await runProgram(assemble([
      ins(SAVE, { imm: 8 }, { mem: 0x4a00 }),
      ins(COMPARE, { mem: 0x4a00 }, { imm: 8 }),
      ins(IF_EQ),
      ins(PRINT, { str: 'EQUAL' }),
      ins(IF_NE),
      ins(PRINTCLEAR, { str: 'NOT EQUAL' }),
      ins(COMPARE, { mem: 0x4a00 }, { imm: 9 }),
      ins(IF_LT),
      ins(PRINT, { str: 'LESS' }),
      ins(EXIT),
    ]), host)
    expect(printed).toEqual(['EQUAL', 'LESS'])
  })

  it('skips a multi-operand instruction whole, not just its opcode', async () => {
    const { memory } = await runProgram(assemble([
      ins(COMPARE, { imm: 1 }, { imm: 2 }),
      ins(IF_EQ),
      ins(SAVE, { imm: 99 }, { mem: 0x4a00 }),
      ins(SAVE, { imm: 7 }, { mem: 0x4a01 }),
      ins(EXIT),
    ]))
    expect(memory.read(0x4a00)).toBe(0)
    expect(memory.read(0x4a01)).toBe(7)
  })

  it('returns from a GOSUB and exits on RETURN with an empty stack', async () => {
    const { host, printed } = recordingHost()
    const sub = at(200)
    await runProgram(assemble([
      ins(GOSUB, { word: sub }),
      ins(PRINT, { str: 'BACK' }),
      ins(RETURN),
      ins(PRINT, { str: 'NEVER' }),
      { at: sub, bytes: [...ins(PRINT, { str: 'IN SUB' }), ...ins(RETURN)] },
    ]), host)
    expect(printed).toEqual(['IN SUB', 'BACK'])
  })

  it('dispatches ON GOTO by index and falls through when out of range', async () => {
    const { host, printed } = recordingHost()
    const a = at(200)
    const b = at(220)
    await runProgram(assemble([
      ins(SAVE, { imm: 1 }, { mem: 0x4a00 }),
      ins(ON_GOTO, { mem: 0x4a00 }, { imm: 2 }, { word: a }, { word: b }),
      ins(PRINT, { str: 'FELL THROUGH' }),
      ins(EXIT),
      { at: a, bytes: [...ins(PRINT, { str: 'A' }), ...ins(EXIT)] },
      { at: b, bytes: [...ins(PRINT, { str: 'B' }), ...ins(SAVE, { imm: 5 }, { mem: 0x4a00 }),
        ...ins(ON_GOTO, { mem: 0x4a00 }, { imm: 2 }, { word: a }, { word: b }),
        ...ins(PRINT, { str: 'OUT OF RANGE' }), ...ins(EXIT)] },
    ]), host)
    expect(printed).toEqual(['B', 'OUT OF RANGE'])
  })

  it('AND leaves flags so that IF < means the result was not zero', async () => {
    const { host, printed } = recordingHost()
    await runProgram(assemble([
      ins(AND, { imm: 0x83 }, { imm: 0x7f }, { mem: 0x4a00 }),
      ins(IF_LT),
      ins(PRINT, { str: 'SET' }),
      ins(AND, { imm: 0x80 }, { imm: 0x7f }, { mem: 0x4a01 }),
      ins(IF_LT),
      ins(PRINT, { str: 'CLEAR' }),
      ins(EXIT),
    ]), host)
    expect(printed).toEqual(['SET'])
  })

  it('arithmetic leaves the flags alone, so the IFs after it read the last COMPARE', async () => {
    // Valhingen Graveyard's start: COMPARE a, b; IF < SUBTRACT; IF >= SAVE 0; IF = SAVE 1
    // — every IF branches on the one COMPARE, whatever the subtraction produced.
    const IF_GE = 0x1b
    const { host, printed } = recordingHost()
    await runProgram(assemble([
      ins(COMPARE, { imm: 2 }, { imm: 2 }),
      ins(SUBTRACT, { imm: 5 }, { imm: 3 }, { mem: 0x4a00 }), // 3 - 5: negative, flags untouched
      ins(IF_GE),
      ins(PRINT, { str: 'GE' }),
      ins(IF_EQ),
      ins(PRINT, { str: 'EQ' }),
      ins(IF_LT),
      ins(PRINT, { str: 'NOT PRINTED' }),
      ins(EXIT),
    ]), host)
    expect(printed).toEqual(['GE', 'EQ'])
  })
})

describe('the outside world', () => {
  it('asks the host for menu choices and stores the index', async () => {
    const seen: { prompt: string | undefined; items: readonly string[] }[] = []
    const host: EclHost = {
      menu: async (prompt, items) => { seen.push({ prompt, items }); return 2 },
    }
    const { memory } = await runProgram(assemble([
      ins(VMENU, { mem: 0x6e79 }, { str: 'DO YOU:' }, { imm: 3 }, { str: 'FIGHT' }, { str: 'WAIT' }, { str: 'LEAVE' }),
      ins(EXIT),
    ]), host)
    expect(seen).toEqual([{ prompt: 'DO YOU:', items: ['FIGHT', 'WAIT', 'LEAVE'] }])
    expect(memory.read(0x6e79)).toBe(2)
  })

  it('draws RANDOM from zero to the operand inclusive', async () => {
    const asked: number[] = []
    const host: EclHost = { random: (max) => { asked.push(max); return max } }
    const { memory } = await runProgram(assemble([
      ins(RANDOM, { imm: 3 }, { mem: 0x4a00 }),
      ins(RANDOM, { imm: 255 }, { mem: 0x4a01 }),
      ins(EXIT),
    ]), host)
    expect(asked).toEqual([3, 254])
    expect(memory.read(0x4a00)).toBe(3)
  })

  it('reports level loads and hands NEW ECL back to the caller', async () => {
    const maps: number[] = []
    const walls: number[][] = []
    const host: EclHost = {
      loadMap: (id) => { maps.push(id) },
      loadWallSets: (ids) => { walls.push([...ids]) },
    }
    const { result } = await runProgram(assemble([
      ins(LOAD_FILES, { imm: 18 }, { imm: 2 }, { imm: 255 }),
      ins(LOAD_PIECES, { imm: 1 }, { imm: 3 }, { imm: 5 }),
      ins(NEW_ECL, { imm: 9 }),
      ins(PRINT, { str: 'NEVER' }),
    ]), host)
    expect(maps).toEqual([18])
    expect(walls).toEqual([[1, 3, 5]])
    expect(result).toEqual({ reason: 'newEcl', newEcl: 9 })
  })

  it('maps the party position and the square event into memory, both ways', async () => {
    const world: VmWorld = {
      position: { row: 4, col: 7, facing: 1 },
      setPosition(row, col) { this.position = { ...this.position, row, col } },
      setFacing(facing) { this.position = { ...this.position, facing } },
      wallAhead: () => 3,
      cellEvent: () => 0x85,
      distanceAhead: () => 0,
      stepForward() {},
    }
    const { host, printed } = recordingHost()
    const event5 = at(200)
    // Exactly the shape of a real level's event dispatch.
    const { memory } = await runProgram(assemble([
      ins(AND, { mem: MAPPED.cellEvent }, { imm: 127 }, { mem: 0x6e79 }),
      ins(ON_GOTO, { mem: 0x6e79 }, { imm: 6 }, { word: at(0) }, { word: at(0) }, { word: at(0) }, { word: at(0) }, { word: at(0) }, { word: event5 }),
      ins(EXIT),
      { at: event5, bytes: [
        ...ins(PRINT, { mem: MAPPED.positionX }),
        ...ins(SAVE, { imm: 9 }, { mem: MAPPED.positionY }),
        ...ins(SAVE, { imm: 3 }, { mem: MAPPED.facing }),
        ...ins(EXIT),
      ] },
    ]), host, world)
    expect(printed).toEqual(['7'])
    expect(world.position).toEqual({ row: 9, col: 7, facing: 3 })
    expect(memory.read(MAPPED.wallAhead)).toBe(3)
  })
})

describe('saving', () => {
  it('round-trips the saved address ranges and stored strings', async () => {
    const { EclMemory } = await import('../src/engine/ecl-vm.js')
    const memory = new EclMemory()
    memory.write(0x4a34, 64)
    memory.write(0x6dd2, 2)
    memory.write(0x9800, 0x1234)
    memory.writeString(0x9800, 'GOBLINS')
    memory.write(0x1000, 99) // outside the saved ranges
    const restored = new EclMemory()
    restored.restore(JSON.parse(JSON.stringify(memory.snapshot())))
    expect(restored.read(0x4a34)).toBe(64)
    expect(restored.read(0x6dd2)).toBe(2)
    expect(restored.read(0x9800)).toBe(0x1234)
    expect(restored.readString(0x9800)).toBe('GOBLINS')
    expect(restored.read(0x1000)).toBe(0)
  })

  it('sends COMBAT to the host even with nobody loaded, for shops and temples', async () => {
    const calls: number[] = []
    const host: EclHost = { combat: async (monsters) => { calls.push(monsters.length); return 'won' } }
    await runProgram(assemble([ins(0x24), ins(EXIT)]), host)
    expect(calls).toEqual([0])
  })
})
