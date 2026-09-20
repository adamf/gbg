import { describe, expect, it } from 'vitest'

import { decodeEcl, decompressEclString, memStartFor, summariseEvent } from '../src/formats/ecl.js'
import { buildEclBlock, compressEclString, ECL_CODE_START, eclInstruction } from './fixtures.js'

const MEM = 0x9900
const at = (offset: number) => MEM + ECL_CODE_START + offset

/** Assembles a block whose start entry point is the first piece of code. */
function program(pieces: { at: number; bytes: number[] }[], start = at(0)) {
  return decodeEcl(1, buildEclBlock({
    memStart: MEM,
    header: [start, start, start, start, start],
    code: pieces,
    size: 0x900,
  }), MEM)
}

describe('ECL string packing', () => {
  it('round-trips text through the six-bit packing', () => {
    for (const text of ['HELLO', 'THE POOL OF RADIANCE', 'A', 'ABCD', '12345678']) {
      expect(decompressEclString(compressEclString(text))).toBe(text)
    }
  })

  it('shifts letters up out of the control range', () => {
    // 'A' is code 0x01 packed, and must come back as ASCII 0x41.
    expect(decompressEclString(Uint8Array.from([0x01 << 2, 0, 0]))).toBe('A')
  })

  it('drops padding rather than emitting nulls', () => {
    expect(decompressEclString(compressEclString('HI'))).toBe('HI')
  })

  it('passes punctuation and digits through unshifted', () => {
    expect(decompressEclString(compressEclString('0123 -'))).toBe('0123 -')
  })
})

describe('ECL header', () => {
  it('reads the five entry point addresses', () => {
    const decoded = decodeEcl(7, buildEclBlock({
      memStart: MEM,
      header: [0x9a00, 0x9b00, 0x9c00, 0x9d00, 0x9e00],
      code: [],
      size: 0x900,
    }), MEM)

    expect(decoded.blockId).toBe(7)
    expect(decoded.entryPoints).toEqual({
      vmRun: 0x9a00,
      searchLocation: 0x9b00,
      preCampCheck: 0x9c00,
      campInterrupted: 0x9d00,
      start: 0x9e00,
    })
  })

  it('puts Pool of Radiance at 0x9900 and everything else at 0x8000', () => {
    expect(memStartFor('pool-of-radiance')).toBe(0x9900)
    expect(memStartFor('curse-of-the-azure-bonds')).toBe(0x8000)
  })
})

describe('ECL instruction decoding', () => {
  it('decodes an instruction and measures its length', () => {
    // PRINT 'HELLO' then EXIT.
    const print = eclInstruction(0x11, [{ str: 'HELLO' }])
    const decoded = program([
      { at: at(0), bytes: [...print, ...eclInstruction(0x00)] },
    ])

    const instruction = decoded.instructions.get(at(0))!
    expect(instruction.name).toBe('PRINT')
    expect(instruction.strings).toEqual(['HELLO'])
    expect(instruction.length).toBe(print.length)

    expect(decoded.instructions.get(at(print.length))!.name).toBe('EXIT')
    expect(decoded.problems).toEqual([])
  })

  it('sizes immediate, memory and word operands differently', () => {
    const decoded = program([{
      at: at(0),
      bytes: [
        ...eclInstruction(0x04, [{ mem: 0x9a00 }, { imm: 3 }, { word: 0x1234 }]),
        ...eclInstruction(0x00),
      ],
    }])

    const add = decoded.instructions.get(at(0))!
    expect(add.name).toBe('ADD')
    expect(add.operands.map((o) => o.kind)).toEqual(['memory', 'immediate', 'literal'])
    expect(add.operands[2]!.word).toBe(0x1234)
    // 1 opcode + 3 + 2 + 3 operand bytes, plus the VM's trailing step.
    expect(add.length).toBe(1 + 3 + 2 + 3)
  })

  it('follows a GOTO and stops falling through', () => {
    const goto = eclInstruction(0x01, [{ word: at(32) }])
    const decoded = program([
      { at: at(0), bytes: goto },
      // Bytes right after the GOTO that must never be decoded as instructions.
      { at: at(goto.length), bytes: [0xfe, 0xfe, 0xfe] },
      { at: at(32), bytes: eclInstruction(0x11, [{ str: 'ARRIVED' }]) },
    ])

    expect(decoded.instructions.get(at(0))!.terminates).toBe(true)
    expect(decoded.instructions.has(at(goto.length))).toBe(false)
    expect(decoded.instructions.get(at(32))!.strings).toEqual(['ARRIVED'])
  })

  it('follows a GOSUB and also carries on past it', () => {
    const gosub = eclInstruction(0x02, [{ word: at(40) }])
    const decoded = program([
      { at: at(0), bytes: [...gosub, ...eclInstruction(0x11, [{ str: 'AFTER' }]), ...eclInstruction(0x00)] },
      { at: at(40), bytes: [...eclInstruction(0x11, [{ str: 'INSIDE' }]), ...eclInstruction(0x13)] },
    ])

    expect(decoded.instructions.get(at(0))!.terminates).toBe(false)
    expect(decoded.instructions.get(at(gosub.length))!.strings).toEqual(['AFTER'])
    expect(decoded.instructions.get(at(40))!.strings).toEqual(['INSIDE'])
  })

  it('keeps decoding past a terminator the IF before it can skip', () => {
    // IF = / RETURN / PRINT: the RETURN is conditional, so the PRINT is reachable.
    const decoded = program([{
      at: at(0),
      bytes: [
        ...eclInstruction(0x16),
        ...eclInstruction(0x13),
        ...eclInstruction(0x11, [{ str: 'REACHED' }]),
        ...eclInstruction(0x00),
      ],
    }])

    expect(decoded.instructions.get(at(2))!.strings).toEqual(['REACHED'])
  })

  it('stops at an unconditional terminator', () => {
    const decoded = program([{
      at: at(0),
      bytes: [...eclInstruction(0x13), ...eclInstruction(0x11, [{ str: 'UNREACHED' }])],
    }])

    expect(decoded.instructions.size).toBe(1)
    expect(decoded.instructions.get(at(1))).toBeUndefined()
  })

  it('reports an unknown opcode instead of guessing', () => {
    const decoded = program([{ at: at(0), bytes: [0x7f, 0x00, 0x00] }])
    expect(decoded.problems.some((p) => p.includes('unknown opcode 0x7f'))).toBe(true)
  })
})

describe('ECL loading commands', () => {
  it('reads the map a script loads', () => {
    const decoded = program([{
      at: at(0),
      bytes: [
        ...eclInstruction(0x21, [{ imm: 21 }, { imm: 0 }, { imm: 0 }]),
        ...eclInstruction(0x00),
      ],
    }])
    expect(decoded.loadsMaps).toEqual([21])
  })

  it('reads the three wall sets a script loads', () => {
    const decoded = program([{
      at: at(0),
      bytes: [
        ...eclInstruction(0x37, [{ imm: 4 }, { imm: 5 }, { imm: 6 }]),
        ...eclInstruction(0x00),
      ],
    }])
    expect(decoded.loadsWallSets).toEqual([[4, 5, 6]])
  })
})

describe('ECL event tables', () => {
  /** An ON GOTO over `count` handlers, each printing its own line. */
  function withEventTable(count: number) {
    const targets = Array.from({ length: count }, (_, i) => at(200 + i * 16))
    const onGoto = eclInstruction(0x25, [
      { mem: 0x9a00 },
      { imm: count },
      ...targets.map((target) => ({ word: target })),
    ])

    return program([
      { at: at(0), bytes: [...onGoto, ...eclInstruction(0x00)] },
      ...targets.map((target, i) => ({
        at: target,
        bytes: [...eclInstruction(0x11, [{ str: `EVENT ${i}` }]), ...eclInstruction(0x13)],
      })),
    ])
  }

  it('takes the largest jump table as the level event dispatch', () => {
    const decoded = withEventTable(8)
    expect(decoded.events).toHaveLength(8)
    expect(decoded.events[0]).toBe(at(200))
    expect(decoded.events[7]).toBe(at(200 + 7 * 16))
  })

  it('ignores a short branch table', () => {
    const decoded = program([{
      at: at(0),
      bytes: [
        ...eclInstruction(0x25, [{ mem: 0x9a00 }, { imm: 3 }, { word: at(64) }, { word: at(64) }, { word: at(64) }]),
        ...eclInstruction(0x00),
      ],
    }, { at: at(64), bytes: eclInstruction(0x13) }])

    expect(decoded.events).toEqual([])
  })

  it('decodes every handler the table points at', () => {
    const decoded = withEventTable(6)
    for (const address of decoded.events) {
      expect(decoded.instructions.get(address)!.name).toBe('PRINT')
    }
  })

  it('summarises what an event says and does', () => {
    const decoded = withEventTable(6)
    const summary = summariseEvent(decoded, 2)!
    expect(summary.event).toBe(2)
    expect(summary.text).toEqual(['EVENT 2'])
    expect(summary.actions).toContain('PRINT')
    expect(summary.fights).toBe(false)
  })

  it('notices an event that starts a fight', () => {
    const target = at(300)
    const decoded = program([
      {
        at: at(0),
        bytes: [
          ...eclInstruction(0x25, [
            { mem: 0x9a00 }, { imm: 5 },
            { word: target }, { word: target }, { word: target }, { word: target }, { word: target },
          ]),
          ...eclInstruction(0x00),
        ],
      },
      {
        at: target,
        bytes: [
          ...eclInstruction(0x11, [{ str: 'ORCS' }]),
          ...eclInstruction(0x24),
          ...eclInstruction(0x13),
        ],
      },
    ])

    const summary = summariseEvent(decoded, 0)!
    expect(summary.fights).toBe(true)
    expect(summary.text).toEqual(['ORCS'])
  })

  it('gives nothing for an event number the table does not have', () => {
    expect(summariseEvent(withEventTable(6), 99)).toBeUndefined()
  })

  it('follows a GOSUB out of an event and back', () => {
    const handler = at(300)
    const shared = at(400)
    const decoded = program([
      {
        at: at(0),
        bytes: [
          ...eclInstruction(0x25, [
            { mem: 0x9a00 }, { imm: 5 },
            { word: handler }, { word: handler }, { word: handler }, { word: handler }, { word: handler },
          ]),
          ...eclInstruction(0x00),
        ],
      },
      {
        at: handler,
        bytes: [
          ...eclInstruction(0x11, [{ str: 'A DOOR' }]),
          ...eclInstruction(0x02, [{ word: shared }]),
          ...eclInstruction(0x13),
        ],
      },
      { at: shared, bytes: [...eclInstruction(0x11, [{ str: 'IT IS LOCKED' }]), ...eclInstruction(0x13)] },
    ])

    expect(summariseEvent(decoded, 0)!.text).toEqual(['A DOOR', 'IT IS LOCKED'])
  })

  it('terminates on a script that jumps back to itself', () => {
    const decoded = program([{ at: at(0), bytes: eclInstruction(0x01, [{ word: at(0) }]) }])
    expect(decoded.instructions.size).toBe(1)
    expect(decoded.problems).toEqual([])
  })
})
