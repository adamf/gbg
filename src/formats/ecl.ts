/**
 * ECL — the compiled scripts that drive everything a level does.
 *
 * `ECL*.DAX` blocks hold bytecode for a small stack-less VM. It is where the events
 * live: step on a square with event 7 and it is an ECL subroutine that decides what
 * you see, what you fight, and what it says to you. It also holds the commands that
 * load a level's map and wall graphics, which is why the previous byte-scan for
 * those opcodes can now be thrown away.
 *
 * This is a decoder, not an interpreter. It walks the code from every entry point
 * it can find, decodes instructions, and reports the structure: where each event
 * starts, what text it prints, what it loads. Running the scripts would need the
 * whole game state they read from; reading them needs only the bytes.
 *
 * Layout. A block opens with five addresses — the VM entry points — and the rest is
 * code. Addresses are absolute in the original 16-bit memory map, so a byte at
 * address A is at `data[A - memStart]`, where memStart is where the game loaded the
 * block: 0x9900 for Pool of Radiance, 0x8000 for the rest. The first two bytes of
 * the block are not part of the image and are skipped.
 *
 * Derived from the EclDump reader in Gold Box Explorer
 * (github.com/simeonpilgrim/goldboxexplorer), itself from disassembly.
 */

import type { GameId } from './detect.js'

/** Where each game loaded an ECL block in the original memory map. */
export function memStartFor(game: GameId): number {
  return game === 'pool-of-radiance' ? 0x9900 : 0x8000
}

export type OperandKind =
  | 'immediate'       // code 0x00 — a literal byte
  | 'memory'          // codes 0x01, 0x03 — read from a memory address
  | 'literal'         // code 0x02 — a literal word
  | 'inline-string'   // code 0x80 — a compressed string in the instruction
  | 'string-pointer'  // code 0x81 — an address to read a string from
  | 'unknown'

export interface EclOperand {
  code: number
  /** The operand's value: the literal, the address, or the byte. */
  word: number
  kind: OperandKind
  /** Present for the two string operand kinds. */
  text?: string
}

export interface EclInstruction {
  address: number
  opcode: number
  name: string
  operands: EclOperand[]
  /** Strings this instruction carries, in the order the VM numbers them. */
  strings: string[]
  /** Addresses this instruction can transfer control to. */
  targets: number[]
  /** Bytes consumed. */
  length: number
  /** True when control does not fall through to the next address. */
  terminates: boolean
}

export interface EclProgram {
  blockId: number
  memStart: number
  /** The five addresses in the block header, in order. */
  entryPoints: {
    vmRun: number
    searchLocation: number
    preCampCheck: number
    campInterrupted: number
    start: number
  }
  /** Decoded instructions by address. Unreached bytes are simply absent. */
  instructions: Map<number, EclInstruction>
  /** Event number to subroutine address, from the level's event jump table. */
  events: number[]
  /** Map ids this script loads (LOAD FILES). */
  loadsMaps: number[]
  /** Wall set id triples this script loads (LOAD PIECES). */
  loadsWallSets: number[][]
  problems: string[]
}

interface CommandSpec {
  name: string
  /** How the operands are laid out. Most commands take a fixed number. */
  shape: 'none' | 'fixed' | 'onGoto' | 'vertMenu' | 'horizMenu'
  operands?: number
  /**
   * What it does to control flow:
   *   stop     ends this run of instructions
   *   jump     ends it, and continues at the operand address
   *   call     continues at the operand address and also falls through
   *   skip     the next instruction is conditional and does not end the run
   *   newEcl   loads a different script, so this run ends
   */
  flow?: 'stop' | 'jump' | 'call' | 'skip' | 'newEcl'
}

/**
 * The VM's instruction set. Sizes are the operand-set counts the original decoder
 * used; the menu commands and ON GOTO read a count and then that many more.
 */
const COMMANDS: Record<number, CommandSpec> = {
  0x00: { name: 'EXIT', shape: 'none', flow: 'stop' },
  0x01: { name: 'GOTO', shape: 'fixed', operands: 1, flow: 'jump' },
  0x02: { name: 'GOSUB', shape: 'fixed', operands: 1, flow: 'call' },
  0x03: { name: 'COMPARE', shape: 'fixed', operands: 2 },
  0x04: { name: 'ADD', shape: 'fixed', operands: 3 },
  0x05: { name: 'SUBTRACT', shape: 'fixed', operands: 3 },
  0x06: { name: 'DIVIDE', shape: 'fixed', operands: 3 },
  0x07: { name: 'MULTIPLY', shape: 'fixed', operands: 3 },
  0x08: { name: 'RANDOM', shape: 'fixed', operands: 2 },
  0x09: { name: 'SAVE', shape: 'fixed', operands: 2 },
  0x0a: { name: 'LOAD CHARACTER', shape: 'fixed', operands: 1 },
  0x0b: { name: 'LOAD MONSTER', shape: 'fixed', operands: 3 },
  0x0c: { name: 'SETUP MONSTER', shape: 'fixed', operands: 3 },
  0x0d: { name: 'APPROACH', shape: 'none' },
  0x0e: { name: 'PICTURE', shape: 'fixed', operands: 1 },
  0x0f: { name: 'INPUT NUMBER', shape: 'fixed', operands: 2 },
  0x10: { name: 'INPUT STRING', shape: 'fixed', operands: 2 },
  0x11: { name: 'PRINT', shape: 'fixed', operands: 1 },
  0x12: { name: 'PRINTCLEAR', shape: 'fixed', operands: 1 },
  0x13: { name: 'RETURN', shape: 'none', flow: 'stop' },
  0x14: { name: 'COMPARE AND', shape: 'fixed', operands: 4 },
  0x15: { name: 'VERTICAL MENU', shape: 'vertMenu' },
  0x16: { name: 'IF =', shape: 'none', flow: 'skip' },
  0x17: { name: 'IF <>', shape: 'none', flow: 'skip' },
  0x18: { name: 'IF <', shape: 'none', flow: 'skip' },
  0x19: { name: 'IF >', shape: 'none', flow: 'skip' },
  0x1a: { name: 'IF <=', shape: 'none', flow: 'skip' },
  0x1b: { name: 'IF >=', shape: 'none', flow: 'skip' },
  0x1c: { name: 'CLEAR MONSTERS', shape: 'none' },
  0x1d: { name: 'PARTY STRENGTH', shape: 'fixed', operands: 1 },
  0x1e: { name: 'CHECK PARTY', shape: 'fixed', operands: 6 },
  0x1f: { name: 'UNKNOWN 1F', shape: 'fixed', operands: 2 },
  0x20: { name: 'NEW ECL', shape: 'fixed', operands: 1, flow: 'newEcl' },
  0x21: { name: 'LOAD FILES', shape: 'fixed', operands: 3 },
  0x22: { name: 'PARTY SURPRISE', shape: 'fixed', operands: 2 },
  0x23: { name: 'SURPRISE', shape: 'fixed', operands: 4 },
  0x24: { name: 'COMBAT', shape: 'none' },
  0x25: { name: 'ON GOTO', shape: 'onGoto' },
  0x26: { name: 'ON GOSUB', shape: 'onGoto' },
  0x27: { name: 'TREASURE', shape: 'fixed', operands: 8 },
  0x28: { name: 'ROB', shape: 'fixed', operands: 3 },
  0x29: { name: 'ENCOUNTER MENU', shape: 'fixed', operands: 14 },
  0x2a: { name: 'GET TABLE', shape: 'fixed', operands: 3 },
  0x2b: { name: 'HORIZONTAL MENU', shape: 'horizMenu' },
  0x2c: { name: 'PARLAY', shape: 'fixed', operands: 6 },
  0x2d: { name: 'CALL', shape: 'fixed', operands: 1 },
  0x2e: { name: 'DAMAGE', shape: 'fixed', operands: 5 },
  0x2f: { name: 'AND', shape: 'fixed', operands: 3 },
  0x30: { name: 'OR', shape: 'fixed', operands: 3 },
  0x31: { name: 'SPRITE OFF', shape: 'none' },
  0x32: { name: 'FIND ITEM', shape: 'fixed', operands: 1 },
  0x33: { name: 'PRINT RETURN', shape: 'none', flow: 'stop' },
  0x34: { name: 'ECL CLOCK', shape: 'fixed', operands: 2 },
  0x35: { name: 'SAVE TABLE', shape: 'fixed', operands: 3 },
  0x36: { name: 'ADD NPC', shape: 'fixed', operands: 2 },
  0x37: { name: 'LOAD PIECES', shape: 'fixed', operands: 3 },
  0x38: { name: 'PROGRAM', shape: 'fixed', operands: 1 },
  0x39: { name: 'WHO', shape: 'fixed', operands: 1 },
  0x3a: { name: 'DELAY', shape: 'none' },
  0x3b: { name: 'SPELL', shape: 'fixed', operands: 3 },
  0x3c: { name: 'PROTECTION', shape: 'fixed', operands: 1 },
  0x3d: { name: 'CLEAR BOX', shape: 'none' },
}

/** Commands whose printed text is what the player actually reads. */
const PRINTING = new Set([0x11, 0x12])

/**
 * Text is packed six bits to a character, four characters per three bytes.
 * Codes 0x01..0x1f are letters, shifted up into ASCII; 0x20..0x3f are already
 * ASCII; 0 is padding.
 */
export function decompressEclString(data: Uint8Array): string {
  let out = ''
  let state = 1
  let last = 0

  const emit = (value: number) => {
    if (value === 0) return
    out += String.fromCharCode(value <= 0x1f ? value + 0x40 : value)
  }

  for (const byte of data) {
    switch (state) {
      case 1:
        emit((byte >> 2) & 0x3f)
        state = 2
        break
      case 2:
        emit(((last << 4) | (byte >> 4)) & 0x3f)
        state = 3
        break
      default:
        emit(((last << 2) | (byte >> 6)) & 0x3f)
        emit(byte & 0x3f)
        state = 1
        break
    }
    last = byte
  }

  return out
}

/** Decodes one ECL block. Never throws: anything it cannot read becomes a problem. */
export function decodeEcl(blockId: number, block: Uint8Array, memStart: number): EclProgram {
  // The first two bytes of the block are not part of the loaded image.
  const image = block.subarray(2)
  const problems: string[] = []

  const byteAt = (address: number): number => {
    const at = (address - memStart) & 0xffff
    return at < image.length ? image[at]! : 0xff
  }
  const inRange = (address: number): boolean => ((address - memStart) & 0xffff) < image.length

  const instructions = new Map<number, EclInstruction>()
  /** Which instruction owns each byte, so a jump into the middle of one is caught. */
  const ownerOf = new Map<number, number>()
  const pending: number[] = []
  const seen = new Set<number>()

  let events: number[] = []
  let eventTableSize = 0
  const loadsMaps: number[] = []
  const loadsWallSets: number[][] = []

  const schedule = (address: number): void => {
    if (!inRange(address) || seen.has(address)) return
    pending.push(address)
  }

  // ---- operand decoding --------------------------------------------------

  /** Cursor shared by the operand reader, mirroring the VM's own offset register. */
  let cursor = 0

  /**
   * Reads `count` operand sets starting after the opcode, exactly as the VM did:
   * each set is a code byte and a low byte, with a third byte for the word codes,
   * and one extra byte consumed after the last set.
   */
  function readOperands(count: number): { operands: EclOperand[]; strings: string[] } {
    const operands: EclOperand[] = []
    const strings: string[] = []

    for (let i = 0; i < count; i++) {
      const code = byteAt(cursor + 1)
      const low = byteAt(cursor + 2)
      cursor += 2

      if (code === 0x01 || code === 0x02 || code === 0x03) {
        cursor++
        const high = byteAt(cursor)
        operands.push({ code, word: low | (high << 8), kind: code === 0x02 ? 'literal' : 'memory' })
      } else if (code === 0x80) {
        // A compressed string sitting in the instruction stream.
        const length = low
        let text = ''
        if (length > 0) {
          const bytes = new Uint8Array(length)
          for (let b = 0; b < length; b++) bytes[b] = byteAt(cursor + 1 + b)
          cursor += length
          text = decompressEclString(bytes)
        }
        strings.push(text)
        operands.push({ code, word: low, kind: 'inline-string', text })
      } else if (code === 0x81) {
        cursor++
        const high = byteAt(cursor)
        const address = low | (high << 8)
        const text = readStringFromMemory(address)
        strings.push(text)
        operands.push({ code, word: address, kind: 'string-pointer', text })
      } else if (code === 0x00) {
        operands.push({ code, word: low, kind: 'immediate' })
      } else {
        operands.push({ code, word: low, kind: 'unknown' })
      }
    }

    cursor++
    return { operands, strings }
  }

  /**
   * A string operand can point at the script's own bytes or at game memory this
   * decoder does not have. The first is readable; the rest is described, not invented.
   */
  function readStringFromMemory(address: number): string {
    if (!inRange(address)) return `<string in game memory at 0x${address.toString(16).padStart(4, '0')}>`
    let text = ''
    let at = address
    while (inRange(at)) {
      const byte = byteAt(at)
      if (byte === 0) break
      text += String.fromCharCode(byte)
      at++
    }
    return text
  }

  // ---- header ------------------------------------------------------------

  cursor = memStart
  const header: number[] = []
  for (let i = 0; i < 5; i++) header.push(readOperands(1).operands[0]?.word ?? 0)

  const entryPoints = {
    vmRun: header[0]!,
    searchLocation: header[1]!,
    preCampCheck: header[2]!,
    campInterrupted: header[3]!,
    start: header[4]!,
  }

  for (const address of header) schedule(address)

  // ---- instruction walk --------------------------------------------------

  let skipNext = false
  let guard = 0

  while (pending.length > 0) {
    const entry = pending.shift()!
    if (seen.has(entry) || !inRange(entry)) continue

    // A jump landing inside an instruction we already decoded means one of the two
    // readings is wrong. Record it and move on rather than decoding overlapping code.
    const owner = ownerOf.get(entry)
    if (owner !== undefined && owner !== entry) {
      problems.push(`0x${entry.toString(16)} lands inside the instruction at 0x${owner.toString(16)}`)
      continue
    }

    cursor = entry
    skipNext = false
    let running = true

    while (running) {
      if (guard++ > 200_000) {
        problems.push('gave up: the decoder ran far longer than any real script')
        running = false
        break
      }

      const address = cursor
      if (seen.has(address)) break
      if (!inRange(address)) break

      const opcode = byteAt(address)
      const spec = COMMANDS[opcode]
      if (!spec) {
        problems.push(`unknown opcode 0x${opcode.toString(16).padStart(2, '0')} at 0x${address.toString(16)}`)
        break
      }

      const conditional = skipNext
      skipNext = false

      const decoded = decodeOne(address, opcode, spec)
      seen.add(address)
      instructions.set(address, decoded)
      for (let i = 0; i < decoded.length; i++) ownerOf.set(address + i, address)

      for (const target of decoded.targets) schedule(target)

      // A conditional instruction is one the IF before it may skip, so control
      // carries on to the next instruction either way.
      if (decoded.terminates && !conditional) running = false
      if (spec.flow === 'skip') skipNext = true
    }
  }

  function decodeOne(address: number, opcode: number, spec: CommandSpec): EclInstruction {
    cursor = address
    const targets: number[] = []
    let operands: EclOperand[] = []
    let strings: string[] = []

    if (spec.shape === 'none') {
      cursor++
    } else if (spec.shape === 'fixed') {
      ({ operands, strings } = readOperands(spec.operands ?? 0))
    } else if (spec.shape === 'onGoto') {
      // A selector and a count, then that many jump targets.
      const head = readOperands(2)
      const count = head.operands[1]?.word ?? 0
      cursor--
      const table = readOperands(Math.min(count, 256))
      operands = [...head.operands, ...table.operands]
      strings = [...head.strings, ...table.strings]

      const addresses = table.operands.map((operand) => operand.word)
      for (const target of addresses) targets.push(target)

      // The level's event dispatch is the largest such table in the block. A short
      // one is an ordinary branch on some other value.
      const selector = head.operands[0]
      const selectorUsable = selector !== undefined && selector.kind !== 'unknown'
      if (count > 4 && count > eventTableSize && selectorUsable) {
        eventTableSize = count
        events = addresses
      }
    } else {
      // Both menus read a fixed head whose last operand is the number of entries.
      const headCount = spec.shape === 'vertMenu' ? 3 : 2
      const head = readOperands(headCount)
      const count = head.operands[headCount - 1]?.word ?? 0
      cursor--
      const entries = readOperands(Math.min(count, 256))
      operands = [...head.operands, ...entries.operands]
      strings = [...head.strings, ...entries.strings]
    }

    if (spec.flow === 'jump' || spec.flow === 'call') {
      const target = operands[0]?.word
      if (target !== undefined) targets.push(target)
    }

    if (opcode === 0x21) {
      // LOAD FILES: the first operand is the map to load.
      const map = operands[0]
      if (map && map.kind !== 'unknown') loadsMaps.push(map.word)
    }
    if (opcode === 0x37) {
      // LOAD PIECES: three wall set ids.
      const triple = operands.slice(0, 3).map((operand) => operand.word)
      if (triple.length === 3) loadsWallSets.push(triple)
    }

    return {
      address,
      opcode,
      name: spec.name,
      operands,
      strings,
      targets,
      length: (cursor - address) & 0xffff,
      terminates: spec.flow === 'stop' || spec.flow === 'jump' || spec.flow === 'newEcl',
    }
  }

  return { blockId, memStart, entryPoints, instructions, events, loadsMaps, loadsWallSets, problems }
}

/** True when this instruction shows the player text. */
export function isPrinting(instruction: EclInstruction): boolean {
  return PRINTING.has(instruction.opcode) && instruction.strings.length > 0
}

/**
 * What the player would see and face at one event, by following the script from the
 * event's entry point.
 *
 * Branches are not evaluated — there is no game state to evaluate them against — so
 * both sides of every condition are reported. That makes this a summary of what an
 * event *can* do, which is the honest thing to show and is what a map annotation
 * wants anyway.
 */
export interface EventSummary {
  event: number
  address: number
  /** Text the event can print, in the order it was found. */
  text: string[]
  /** Command names the event uses, in order of first appearance. */
  actions: string[]
  /** True when the event can start a fight. */
  fights: boolean
}

export function summariseEvent(program: EclProgram, event: number, maxInstructions = 400): EventSummary | undefined {
  const address = program.events[event]
  if (address === undefined) return undefined

  const text: string[] = []
  const actions: string[] = []
  let fights = false

  const visited = new Set<number>()
  const queue = [address]
  let budget = maxInstructions

  while (queue.length > 0 && budget > 0) {
    let at = queue.shift()!

    while (budget-- > 0) {
      if (visited.has(at)) break
      visited.add(at)

      const instruction = program.instructions.get(at)
      if (!instruction) break

      if (isPrinting(instruction)) {
        for (const line of instruction.strings) if (line.trim() !== '') text.push(line)
      }
      if (!actions.includes(instruction.name)) actions.push(instruction.name)
      if (instruction.opcode === 0x24 || instruction.opcode === 0x0b) fights = true

      for (const target of instruction.targets) if (!visited.has(target)) queue.push(target)
      if (instruction.terminates) break

      at = (at + instruction.length) & 0xffff
    }
  }

  return { event, address, text, actions, fights }
}
