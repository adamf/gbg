/**
 * Runs the ECL scripts.
 *
 * The decoder in `formats/ecl.ts` reads the bytecode; this executes it. The VM is the
 * original's: a program counter, a call stack for GOSUB, six compare flags that the
 * IF commands test, and a 16-bit address space where the script's own bytes sit at
 * `memStart` and everything else — quest flags, the selected character, the party's
 * position — is memory the game mapped in around it.
 *
 * Anything that needs the player or the screen goes through `EclHost`: printing,
 * menus, pictures, combat. The VM itself has no idea what a canvas is, so it runs
 * the same in a test as in the page.
 *
 * Semantics follow the Curse of the Azure Bonds reimplementation
 * (github.com/simeonpilgrim/coab, `engine/ovr003.cs` and `ovr008.cs`), which came
 * from disassembly. Pool of Radiance maps its globals at different addresses, which
 * `POOL_ADDRESSES` records; the instruction set is the same.
 */

import { ECL_COMMANDS, readOperandSets, type EclOperand } from '../formats/ecl.js'

// ---- the memory map ----------------------------------------------------------

/**
 * Addresses the original mapped onto live game state rather than storage. These
 * are the same in every game.
 */
export const MAPPED = {
  /** Column of the party's square. */
  positionX: 0xc04b,
  /** Row of the party's square. */
  positionY: 0xc04c,
  /** Facing: 0 north, 1 east, 2 south, 3 west. */
  facing: 0xc04d,
  /** Wall type of the wall the party is facing. */
  wallAhead: 0xc04e,
  /** The event byte of the party's square, high bit and all. */
  cellEvent: 0xc04f,
  /** Facing again, as the original stored it internally (0, 2, 4, 6). */
  facingRaw: 0x033d,
} as const

/**
 * Where Pool of Radiance keeps the globals its scripts read most. An address here is
 * one 16-bit word. Derived from the field offsets in the Gold Box Explorer memory
 * notes: `address = ((offset - 0x6e00) mod 0x10000) / 2`.
 */
export const POOL_ADDRESSES = {
  /** The map (GEO block) the party is on; the Temple of Bane's script tells inside (31) from outside (24) by it. */
  currentMap: 0x49c5,
  timeMinutesOnes: 0x49c7,
  timeMinutesTens: 0x49c8,
  timeHour: 0x49c9,
  timeDay: 0x49ca,
  timeYear: 0x49cb,
  inDungeon: 0x49e6,
  lastX: 0x49f0,
  lastY: 0x49f1,
  /** The script that ran last. A level's start code checks this to skip re-setup. */
  lastEclBlock: 0x49f2,
  blockAreaView: 0x49fb,
  /** Scratch the original reset whenever a script was loaded fresh. */
  scratchStart: 0x4a00,
  scratchEnd: 0x4a20,
  /** Set when the party walks off the map's edge; the per-step code sends them to the next area. */
  triedToExit: 0x6dd5,
  /** The area number the original names its files by (coab's area2 game_area); the scripts set it before NEW ECL. */
  gameArea: 0x6e12,
  /** The head a script's PICTURE composes over a BODY block when no PIC block has its number. */
  pictureHead: 0x6de1,
  /** The three wall-set block ids in play; the original reloads them from the area's WALLDEF on a load (−1 = none, 0 = the area's block 0 holds all three). */
  wallSets: 0x4afa,
  /** Overland: the party's square in the wilderness script's window, x then y. */
  overlandX: 0x49c3,
  overlandY: 0x49c4,
  /** Overland scratch the scripts compute a step into, and CALL 0xC01B/0xC018 read: x, y, the tile found, the tile to plant. */
  overlandWorkX: 0x00fb,
  overlandWorkY: 0x00fc,
  overlandTerrain: 0x035f,
  overlandPlant: 0x00b1,
  /** 255 from the per-step code means the move the party asked for does not happen. */
  moveCancelled: 0x6dc9,
  /** Resting: a check every this many hours, and the chance of an interruption. */
  restPeriod: 0x6dd2,
  restChance: 0x6dd3,
  /** How the last fight ended, for the scripts: 0 won, 0x80 lost, 0x81 the party ran. */
  combatResult: 0x6dc7,
  /** How many monsters fell in the last fight; Kuto's Well counts a rout as a kill only when it is not zero. */
  monstersKilled: 0x6dc8,
  /** Set by a script before COMBAT to mean a temple or a shop rather than a fight. */
  enterTemple: 0x6de2,
  enterShop: 0x6e6c,
  /** Which classes the hall the party stands in trains; PROGRAM 0 then offers training. */
  trainingMask: 0x6da8,
  /** Bit 0: the party is searching as it walks; bit 1: it is looking at this square. */
  searchFlags: 0x6dca,
  /** The per-area scratch words the scripts use as local variables. */
  localsStart: 0x6e79,
  localsEnd: 0x6e90,
  /** Where a saved game's three blocks map in. */
  globalsBase: 0x4900,
  areaScratchBase: 0x6b00,
  extraBase: 0x9700,
} as const

/** What the party is doing in the world, for the mapped addresses. */
export interface VmWorld {
  position: { row: number; col: number; facing: number }
  /** The eight-point compass the wilderness steers by: 0 north, clockwise. Indoors it is the facing doubled. */
  compass: number
  setCompass(compass: number): void
  setPosition(row: number, col: number): void
  setFacing(facing: number): void
  /** Wall type of the wall directly ahead, 0 when open. */
  wallAhead(): number
  /** The full event byte of the party's square. */
  cellEvent(): number
  /** How many open squares lie ahead, capped at 2 — where a monster group stands. */
  distanceAhead(): number
  /** Moves the party one square forward if it can. */
  stepForward(): void
}

/** Where the selected character's fields appear to a script. */
export const SELECTED_CHARACTER_BASE = 0x6b00
const SELECTED_CHARACTER_SPAN = 0x340

/**
 * The selected character, as LOAD CHARACTER and WHO pick one. Offsets are from
 * `SELECTED_CHARACTER_BASE`; a read the roster does not answer falls through to
 * ordinary memory, which is where the original kept its per-area scratch.
 */
export interface CharacterHook {
  select(index: number): void
  name(): string
  read(offset: number): number | undefined
  write(offset: number, value: number): boolean
}

/** The address ranges a saved game carries, matching the original's three blocks. */
const SAVED_RANGES: readonly [number, number][] = [[0x4900, 0x4d00], [0x6b00, 0x7000], [0x9700, 0x9900]]

/** A 64K address space with the script image mapped in and the world mapped over it. */
export class EclMemory {
  private readonly words = new Uint16Array(0x10000)
  private readonly strings = new Map<number, string>()
  private image = new Uint8Array(0)
  memStart = 0
  world: VmWorld | undefined
  character: CharacterHook | undefined

  /** Maps a script block in. The block's first two bytes are not part of the image. */
  loadImage(block: Uint8Array, memStart: number): void {
    this.image = block.slice(2)
    this.memStart = memStart
  }

  inImage(address: number): boolean {
    return ((address - this.memStart) & 0xffff) < this.image.length
  }

  byteAt(address: number): number {
    const at = (address - this.memStart) & 0xffff
    return at < this.image.length ? this.image[at]! : 0xff
  }

  read(address: number): number {
    const world = this.world
    if (world) {
      switch (address) {
        case MAPPED.positionX: return world.position.col
        case MAPPED.positionY: return world.position.row
        case MAPPED.facing: return world.position.facing & 3
        case MAPPED.facingRaw: return world.compass & 7
        case MAPPED.wallAhead: return world.wallAhead()
        case MAPPED.cellEvent: return world.cellEvent()
      }
    }
    if (this.character && address >= SELECTED_CHARACTER_BASE && address < SELECTED_CHARACTER_BASE + SELECTED_CHARACTER_SPAN) {
      const value = this.character.read(address - SELECTED_CHARACTER_BASE)
      if (value !== undefined) return value & 0xffff
    }
    if (this.inImage(address)) return this.byteAt(address)
    return this.words[address & 0xffff]!
  }

  write(address: number, value: number): void {
    const world = this.world
    if (world) {
      switch (address) {
        case MAPPED.positionX: world.setPosition(world.position.row, value & 0xff); return
        case MAPPED.positionY: world.setPosition(value & 0xff, world.position.col); return
        case MAPPED.facing: world.setFacing(value & 3); return
        case MAPPED.facingRaw: world.setCompass(value & 7); return
      }
    }
    if (this.character && address >= SELECTED_CHARACTER_BASE && address < SELECTED_CHARACTER_BASE + SELECTED_CHARACTER_SPAN) {
      if (this.character.write(address - SELECTED_CHARACTER_BASE, value & 0xffff)) return
    }
    if (this.inImage(address)) {
      this.image[(address - this.memStart) & 0xffff] = value & 0xff
      return
    }
    this.words[address & 0xffff] = value & 0xffff
  }

  /** Text stored at an address: a script's own string, or one a SAVE put there. */
  readString(address: number): string {
    if (address === SELECTED_CHARACTER_BASE && this.character) return this.character.name()
    if (this.inImage(address)) {
      let text = ''
      let at = address
      while (this.inImage(at)) {
        const byte = this.byteAt(at)
        if (byte === 0) break
        text += String.fromCharCode(byte)
        at++
      }
      return text
    }
    return this.strings.get(address & 0xffff) ?? ''
  }

  writeString(address: number, text: string): void {
    this.strings.set(address & 0xffff, text)
  }

  /**
   * Maps a block of 16-bit words to a run of addresses. The original kept its globals
   * in a struct and addressed them as `base + 2 * address`, so a saved game's bytes
   * land here two at a time.
   */
  loadWords(firstAddress: number, bytes: Uint8Array): void {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      this.words[(firstAddress + i / 2) & 0xffff] = bytes[i]! | (bytes[i + 1]! << 8)
    }
  }

  /** The stored words and strings, for saving. The script image is reloaded, not saved. */
  snapshot(): { words: number[]; strings: [number, string][] } {
    const words: number[] = []
    for (const [from, to] of SAVED_RANGES) for (let a = from; a < to; a++) words.push(this.words[a]!)
    return { words, strings: [...this.strings] }
  }

  restore(saved: { words: number[]; strings: [number, string][] }): void {
    let i = 0
    for (const [from, to] of SAVED_RANGES) for (let a = from; a < to; a++) this.words[a] = saved.words[i++] ?? 0
    this.strings.clear()
    for (const [address, text] of saved.strings) this.strings.set(address, text)
  }

  /** A run of words as the original's bytes, two per address, for writing a save. */
  bytesOf(firstAddress: number, count: number): Uint8Array {
    const out = new Uint8Array(count * 2)
    for (let i = 0; i < count; i++) {
      const word = this.words[(firstAddress + i) & 0xffff]!
      out[i * 2] = word & 0xff
      out[i * 2 + 1] = (word >> 8) & 0xff
    }
    return out
  }

  /** The script image as loaded, for the save's copy of it. */
  imageBytes(): Uint8Array {
    return this.image
  }

  /** Zeroes a range of words, the way the original reset its scratch on a fresh script. */
  clearWords(from: number, to: number): void {
    for (let a = from; a < to; a++) this.words[a & 0xffff] = 0
  }
}

// ---- what the host provides -----------------------------------------------------

export interface MonsterGroup {
  /** Monster record id in the area's MON*.DAX files. */
  id: number
  count: number
  /** Combat picture block. */
  picture: number
}

export interface EncounterView {
  sprite: number
  picture: number
  /** 0 adjacent, 1 one square off, 2 two squares off. */
  distance: number
}

export type CombatOutcome = 'won' | 'fled' | 'lost'

export interface Treasure {
  copper: number
  silver: number
  electrum: number
  gold: number
  platinum: number
  gems: number
  jewellery: number
  /** < 0x80 loads that ITEM block; 0xff is nothing; otherwise `value - 0x80` random items. */
  items: number
}

export interface DamageSpec {
  flags: number
  dice: number
  sides: number
  bonus: number
  kind: number
}

/**
 * Everything a script can ask of the outside world. All optional: a missing method
 * gets a quiet default, so a test host can be an empty object.
 */
export interface EclHost {
  print?(text: string, clear: boolean): Promise<void> | void
  newLine?(): void
  clearBox?(): void
  /** Returns the chosen index. */
  menu?(prompt: string | undefined, items: readonly string[], layout: 'vertical' | 'horizontal'): Promise<number>
  inputNumber?(): Promise<number>
  /** `maxLength` is the INPUT STRING's own limit, which is also a hint at the word wanted. */
  inputString?(maxLength: number): Promise<string>
  delay?(): Promise<void> | void
  /** A PIC block to show, or 255 to go back to the view. */
  picture?(id: number): void
  spriteOff?(): void
  /** A monster group is on screen, at this distance. */
  encounter?(view: EncounterView): void
  loadMonster?(group: MonsterGroup): void
  clearMonsters?(): void
  combat?(monsters: readonly MonsterGroup[]): Promise<CombatOutcome>
  /** Which of HAUGHTY, SLY, NICE, MEEK, ABUSIVE the player chose. */
  parlay?(): Promise<number>
  /** Picks a party member; returns their index. */
  who?(prompt: string): Promise<number>
  partyStrength?(): number
  partyMovement?(): { min: number; max: number }
  treasure?(treasure: Treasure): Promise<void> | void
  damage?(spec: DamageSpec): Promise<void> | void
  loadMap?(id: number): Promise<void> | void
  loadWallSets?(ids: readonly [number, number, number]): Promise<void> | void
  /** A call into the game's own code by address. */
  call?(id: number): Promise<void> | void
  /** 0 the start menu, 3 party killed, 8 game won, 9 encamp. */
  program?(id: number): Promise<void> | void
  /** An NPC joins the party: a monster record by id, at this morale. */
  addNpc?(id: number, morale: number): Promise<void> | void
  /** Thieves: keep `keepPercent` of the coins and lose each item with `itemChance` percent. */
  rob?(everyone: boolean, keepPercent: number, itemChance: number): Promise<void> | void
  /** Who has a spell ready: their index and the spell's one-based place in their list. */
  spellHolder?(spellId: number): { player: number; index: number } | undefined
  /** CHECK PARTY: the party's least, greatest and average of a movement or a thief skill, or whether anyone has an affect. */
  checkParty?(kind: 'movement' | 'skill' | 'affect', which: number): [number, number, number, number]
  /** Uniform in 0..max inclusive. */
  random?(max: number): number
  log?(message: string): void
}

export interface RunResult {
  reason: 'exit' | 'newEcl' | 'program' | 'unknown-opcode' | 'runaway'
  newEcl?: number
  program?: number
}

/**
 * CALL targets: addresses in the original's own code. The scripts use a handful.
 * Pool of Radiance's, read off the scripts rather than the binary: 0xc01e walks the
 * party one square forward (the same in Curse); 0x2c90 redraws the view after the
 * script moved the party; 0xba03 plays the sound whose number was saved at 0x03de.
 */
export const CALL_STEP_FORWARD = 0xc01e
export const CALL_REDRAW = 0x2c90
export const CALL_SOUND = 0xba03
/** The next COMBAT is a duel: one party member against one foe. */
export const CALL_DUEL = 0x8001
/** The training hall's arena: the chosen character duels an even match of themselves. */
export const CALL_SPAR = 0x8000
/** Wilderness-map bookkeeping and picture-area helpers with nothing to do here. */
export const CALL_QUIET = new Set([0x0806, 0x2c51, 0x2c4e, 0xc009, 0xc003])
/**
 * Wilderness moves. The script keeps its own overland coordinates at 0x00fb/0x00fc on
 * a grid larger than the map; these calls committed them. Here the party walks the
 * map it is on and the calls only redraw.
 */
/** Wilderness: 0xC01B reads the tile at the work square into overlandTerrain; 0xC018 plants overlandPlant there. */
export const CALL_TERRAIN = 0xc01b
export const CALL_PLANT = 0xc018
export const CALL_WILD = new Set([CALL_PLANT, CALL_TERRAIN])

const MAX_STEPS = 200_000

// ---- the interpreter ---------------------------------------------------------

export class EclVm {
  private pc = 0
  private readonly stack: number[] = []
  private readonly flags = [false, false, false, false, false, false]
  private result: RunResult | undefined
  /** Monster groups LOAD MONSTER has queued for the next COMBAT. */
  readonly monsters: MonsterGroup[] = []
  private encounterView: EncounterView = { sprite: 0, picture: 0, distance: 0 }
  private selectedPlayer = 0
  /** How the most recent COMBAT ended, for the host to act on. */
  lastCombat: CombatOutcome | undefined

  constructor(readonly memory: EclMemory, readonly host: EclHost = {}) {}

  /** Runs from an entry point until the script exits. */
  async run(entry: number): Promise<RunResult> {
    this.pc = entry & 0xffff
    this.stack.length = 0
    this.result = undefined

    let steps = 0
    while (!this.result) {
      if (steps++ > MAX_STEPS) {
        this.host.log?.(`gave up at 0x${this.pc.toString(16)}: the script ran far longer than any real one`)
        this.result = { reason: 'runaway' }
        break
      }
      this.trace?.(this.pc)
      await this.step()
    }
    return this.result
  }

  /** Called with the address of every instruction about to run; for debugging a script. */
  trace?: (pc: number) => void

  private byteAt = (address: number): number => this.memory.byteAt(address)
  private readString = (address: number): string => this.memory.readString(address)

  private operands(count: number): { operands: EclOperand[]; strings: string[] } {
    const read = readOperandSets(this.byteAt, this.readString, this.pc, count)
    this.pc = read.next
    return read
  }

  /** The variable part of ON GOTO and the menus: the cursor steps back one byte first. */
  private moreOperands(count: number): { operands: EclOperand[]; strings: string[] } {
    const read = readOperandSets(this.byteAt, this.readString, (this.pc - 1) & 0xffff, count)
    this.pc = read.next
    return read
  }

  private value(operand: EclOperand | undefined): number {
    if (!operand) return 0
    switch (operand.kind) {
      case 'memory': return this.memory.read(operand.word)
      case 'literal': return operand.word
      default: return operand.word & 0xff
    }
  }

  private isString(operand: EclOperand | undefined): boolean {
    return operand !== undefined && operand.code >= 0x80
  }

  private compare(a: number, b: number): void {
    this.flags[0] = a === b
    this.flags[1] = a !== b
    this.flags[2] = a < b
    this.flags[3] = a > b
    this.flags[4] = a <= b
    this.flags[5] = a >= b
  }

  private compareStrings(a: string, b: string): void {
    const order = a < b ? -1 : a > b ? 1 : 0
    this.compare(order, 0)
  }

  /** Advances past the instruction at pc without running it. */
  private skipInstruction(): void {
    const opcode = this.byteAt(this.pc)
    const spec = ECL_COMMANDS[opcode]
    if (!spec) {
      this.pc = (this.pc + 1) & 0xffff
      return
    }
    switch (spec.shape) {
      case 'none':
        this.pc = (this.pc + 1) & 0xffff
        break
      case 'fixed':
        this.operands(spec.operands ?? 0)
        break
      case 'onGoto': {
        const head = this.operands(2)
        this.moreOperands(Math.min(this.value(head.operands[1]), 256))
        break
      }
      case 'vertMenu': {
        const head = this.operands(3)
        this.moreOperands(Math.min(this.value(head.operands[2]), 256))
        break
      }
      case 'horizMenu': {
        const head = this.operands(2)
        this.moreOperands(Math.min(this.value(head.operands[1]), 256))
        break
      }
    }
  }

  private random(max: number): number {
    if (this.host.random) return this.host.random(max)
    return Math.floor(Math.random() * (max + 1))
  }

  private exit(): void {
    this.result = { reason: 'exit' }
    this.stack.length = 0
  }

  private async step(): Promise<void> {
    const address = this.pc
    const opcode = this.byteAt(address)

    switch (opcode) {
      case 0x00: // EXIT
        this.pc++
        this.exit()
        return

      case 0x01: { // GOTO
        const { operands } = this.operands(1)
        this.pc = operands[0]!.word
        return
      }

      case 0x02: { // GOSUB
        const { operands } = this.operands(1)
        this.stack.push(this.pc)
        this.pc = operands[0]!.word
        return
      }

      case 0x03: { // COMPARE
        const { operands, strings } = this.operands(2)
        if (this.isString(operands[0]) || this.isString(operands[1])) {
          this.compareStrings(strings[0] ?? '', strings[1] ?? '')
        } else {
          this.compare(this.value(operands[0]), this.value(operands[1]))
        }
        return
      }

      case 0x04: case 0x05: case 0x06: case 0x07: { // ADD SUBTRACT DIVIDE MULTIPLY
        const { operands } = this.operands(3)
        const a = this.value(operands[0])
        const b = this.value(operands[1])
        let value: number
        if (opcode === 0x04) value = a + b
        else if (opcode === 0x05) value = b - a
        else if (opcode === 0x06) value = b === 0 ? 0 : Math.floor(a / b)
        else value = a * b
        // The flags are left alone (coab's CMD_AddSubDivMulti): Valhingen Graveyard's
        // COMPARE, SUBTRACT, IF >=, IF = all branch on the one COMPARE.
        this.memory.write(operands[2]!.word, value & 0xffff)
        return
      }

      case 0x08: { // RANDOM
        const { operands } = this.operands(2)
        let max = this.value(operands[0]) & 0xff
        // The original bumped the range by one unless it was already at the byte's top.
        if (max < 0xff) max++
        this.memory.write(operands[1]!.word, this.random(max - 1))
        return
      }

      case 0x09: { // SAVE
        const { operands, strings } = this.operands(2)
        const target = operands[1]!.word
        if (this.isString(operands[0])) this.memory.writeString(target, strings[0] ?? '')
        else this.memory.write(target, this.value(operands[0]))
        return
      }

      case 0x0a: { // LOAD CHARACTER
        const { operands } = this.operands(1)
        this.selectedPlayer = this.value(operands[0]) & 0x7f
        this.memory.character?.select(this.selectedPlayer)
        return
      }

      case 0x0b: { // LOAD MONSTER
        const { operands } = this.operands(3)
        const group: MonsterGroup = {
          id: this.value(operands[0]) & 0xff,
          count: Math.max(1, this.value(operands[1]) & 0xff),
          picture: this.value(operands[2]) & 0xff,
        }
        this.monsters.push(group)
        this.host.loadMonster?.(group)
        return
      }

      case 0x0c: { // SETUP MONSTER
        const { operands } = this.operands(3)
        const maxDistance = this.value(operands[1]) & 0xff
        const world = this.memory.world
        this.encounterView = {
          sprite: this.value(operands[0]) & 0xff,
          picture: this.value(operands[2]) & 0xff,
          distance: Math.min(maxDistance, world ? world.distanceAhead() : 0),
        }
        this.host.encounter?.(this.encounterView)
        return
      }

      case 0x0d: // APPROACH
        this.pc++
        if (this.encounterView.distance > 0) {
          this.encounterView = { ...this.encounterView, distance: this.encounterView.distance - 1 }
          this.host.encounter?.(this.encounterView)
        }
        return

      case 0x0e: { // PICTURE
        const { operands } = this.operands(1)
        this.host.picture?.(this.value(operands[0]) & 0xff)
        return
      }

      case 0x0f: { // INPUT NUMBER
        const { operands } = this.operands(2)
        const number = this.host.inputNumber ? await this.host.inputNumber() : 0
        this.memory.write(operands[1]!.word, number & 0xffff)
        return
      }

      case 0x10: { // INPUT STRING
        const { operands } = this.operands(2)
        const text = this.host.inputString ? await this.host.inputString(this.value(operands[0]) & 0xff) : ''
        this.memory.writeString(operands[1]!.word, text.length === 0 ? ' ' : text)
        return
      }

      case 0x11: case 0x12: { // PRINT, PRINTCLEAR
        const { operands, strings } = this.operands(1)
        const text = this.isString(operands[0]) ? (strings[0] ?? '') : String(this.value(operands[0]))
        await this.host.print?.(text, opcode === 0x12)
        return
      }

      case 0x13: { // RETURN
        this.pc++
        const back = this.stack.pop()
        if (back === undefined) this.exit()
        else this.pc = back
        return
      }

      case 0x14: { // COMPARE AND
        const { operands } = this.operands(4)
        const both = this.value(operands[0]) === this.value(operands[1])
          && this.value(operands[2]) === this.value(operands[3])
        this.flags.fill(false)
        this.flags[both ? 0 : 1] = true
        return
      }

      case 0x15: { // VERTICAL MENU
        const head = this.operands(3)
        const target = head.operands[0]!.word
        const count = Math.min(this.value(head.operands[2]), 256)
        const items = this.moreOperands(count).strings
        const chosen = await this.choose(head.strings[0], items, 'vertical')
        this.memory.write(target, chosen)
        return
      }

      case 0x16: case 0x17: case 0x18: case 0x19: case 0x1a: case 0x1b: // IF = <> < > <= >=
        this.pc++
        if (!this.flags[opcode - 0x16]) this.skipInstruction()
        return

      case 0x1c: // CLEAR MONSTERS
        this.pc++
        this.monsters.length = 0
        this.host.clearMonsters?.()
        return

      case 0x1d: { // PARTY STRENGTH
        const { operands } = this.operands(1)
        this.memory.write(operands[0]!.word, (this.host.partyStrength?.() ?? 10) & 0xff)
        return
      }

      case 0x1e: { // CHECK PARTY
        // The first operand is an address in the original's code space: 0x9f means
        // movement, 0xa5–0xac a thief skill, 8001 an affect. Four results follow.
        const { operands } = this.operands(6)
        const what = (operands[0]!.word - 0x7fff) & 0xffff
        const which = this.value(operands[1])
        let results: [number, number, number, number] = [0, 0, 0, 0]
        if (this.host.checkParty) {
          if (what === 8001) results = this.host.checkParty('affect', which)
          else if (what >= 0xa5 && what <= 0xac) results = this.host.checkParty('skill', what - 0xa5)
          else if (what === 0x9f) results = this.host.checkParty('movement', 0)
        }
        operands.slice(2, 6).forEach((operand, i) => this.memory.write(operand.word, results[i] ?? 0))
        return
      }

      case 0x1f: // UNKNOWN 1F
        this.operands(2)
        return

      case 0x20: { // NEW ECL
        const { operands } = this.operands(1)
        this.result = { reason: 'newEcl', newEcl: this.value(operands[0]) & 0xff }
        this.stack.length = 0
        return
      }

      case 0x21: { // LOAD FILES
        const { operands } = this.operands(3)
        const map = this.value(operands[0]) & 0xff
        if (map !== 0xff && map !== 0x7f) await this.host.loadMap?.(map)
        return
      }

      case 0x22: // PARTY SURPRISE
        this.operands(2)
        return

      case 0x23: { // SURPRISE
        const { operands } = this.operands(4)
        // Two dice against the party's and the monsters' alertness; 3 means both sides surprised.
        const a = this.value(operands[0])
        const b = this.value(operands[1])
        const c = this.value(operands[2])
        const d = this.value(operands[3])
        const partyEdge = d + 2 - a
        const monsterEdge = c + 2 - b
        const roll1 = this.random(5) + 1
        const roll2 = this.random(5) + 1
        let surprise = 0
        if (roll1 <= partyEdge) surprise = roll2 <= monsterEdge ? 3 : 1
        if (roll2 <= monsterEdge) surprise = 2
        this.memory.write(0x2cb, surprise)
        return
      }

      case 0x24: { // COMBAT
        // With monsters loaded this is a fight. Without, the original opened the shop
        // or temple the area flags asked for, or handed over pooled treasure.
        this.pc++
        this.lastCombat = this.host.combat ? await this.host.combat(this.monsters) : 'won'
        this.monsters.length = 0
        this.host.clearMonsters?.()
        // A wiped party is the end of the game in the original; the script does not
        // go on to loop its "surrender or die" over the fallen.
        if (this.lastCombat === 'lost') { this.result = { reason: 'exit' }; this.stack.length = 0 }
        return
      }

      case 0x25: case 0x26: { // ON GOTO, ON GOSUB
        const head = this.operands(2)
        const index = this.value(head.operands[0]) & 0xff
        const count = this.value(head.operands[1]) & 0xff
        const table = this.moreOperands(count).operands
        if (index < count) {
          const target = table[index]!.word
          if (opcode === 0x26) this.stack.push(this.pc)
          this.pc = target
        }
        return
      }

      case 0x27: { // TREASURE
        const { operands } = this.operands(8)
        const [copper, silver, electrum, gold, platinum, gems, jewellery, items] = operands.map((o) => this.value(o))
        await this.host.treasure?.({
          copper: copper!, silver: silver!, electrum: electrum!, gold: gold!,
          platinum: platinum!, gems: gems!, jewellery: jewellery!, items: items!,
        })
        return
      }

      case 0x28: { // ROB
        const { operands } = this.operands(3)
        await this.host.rob?.(this.value(operands[0]) !== 0, 100 - (this.value(operands[1]) & 0xff), this.value(operands[2]) & 0xff)
        return
      }

      case 0x29: { // ENCOUNTER MENU
        const { operands, strings } = this.operands(14)
        await this.encounterMenu(operands, strings)
        return
      }

      case 0x2a: { // GET TABLE
        const { operands } = this.operands(3)
        const base = operands[0]!.word
        const index = this.value(operands[1]) & 0xff
        this.memory.write(operands[2]!.word, this.memory.read((base + index) & 0xffff))
        return
      }

      case 0x2b: { // HORIZONTAL MENU
        const head = this.operands(2)
        const target = head.operands[0]!.word
        const count = Math.min(this.value(head.operands[1]), 256)
        const items = this.moreOperands(count).strings
        const chosen = await this.choose(undefined, items, 'horizontal')
        this.memory.write(target, chosen)
        return
      }

      case 0x2c: { // PARLAY
        const { operands } = this.operands(6)
        const chosen = this.host.parlay ? await this.host.parlay() : 2
        const values = operands.slice(0, 5).map((o) => this.value(o) & 0xff)
        this.memory.write(operands[5]!.word, values[Math.min(4, Math.max(0, chosen))]!)
        return
      }

      case 0x2d: { // CALL
        const { operands } = this.operands(1)
        const id = operands[0]!.word
        if (id === CALL_STEP_FORWARD) this.memory.world?.stepForward()
        await this.host.call?.(id)
        return
      }

      case 0x2e: { // DAMAGE
        const { operands } = this.operands(5)
        await this.host.damage?.({
          flags: this.value(operands[0]) & 0xff,
          dice: this.value(operands[1]),
          sides: this.value(operands[2]),
          bonus: this.value(operands[3]),
          kind: this.value(operands[4]) & 0xff,
        })
        return
      }

      case 0x2f: case 0x30: { // AND, OR
        const { operands } = this.operands(3)
        const a = this.value(operands[0])
        const b = this.value(operands[1])
        const result = (opcode === 0x2f ? a & b : a | b) & 0xff
        // The original compared zero against the result, in that order.
        this.compare(0, result)
        this.memory.write(operands[2]!.word, result)
        return
      }

      case 0x31: // SPRITE OFF
        this.pc++
        this.host.spriteOff?.()
        return

      case 0x32: { // FIND ITEM
        this.operands(1)
        // No inventory yet: nobody has it.
        this.flags.fill(false)
        this.flags[1] = true
        return
      }

      case 0x33: // PRINT RETURN
        this.pc++
        this.host.newLine?.()
        return

      case 0x34: // ECL CLOCK
        this.operands(2)
        return

      case 0x35: { // SAVE TABLE
        const { operands } = this.operands(3)
        const base = operands[1]!.word
        const offset = this.value(operands[2])
        this.memory.write((base + offset) & 0xffff, this.value(operands[0]))
        return
      }

      case 0x36: { // ADD NPC
        const { operands } = this.operands(2)
        await this.host.addNpc?.(this.value(operands[0]) & 0xff, this.value(operands[1]) & 0xff)
        return
      }

      case 0x37: { // LOAD PIECES
        const { operands } = this.operands(3)
        const ids = operands.slice(0, 3).map((o) => this.value(o) & 0xff)
        await this.host.loadWallSets?.([ids[0]!, ids[1]!, ids[2]!])
        return
      }

      case 0x38: { // PROGRAM
        const { operands } = this.operands(1)
        const id = this.value(operands[0]) & 0xff
        await this.host.program?.(id)
        if (id === 3 || id === 9) {
          this.result = { reason: 'program', program: id }
          this.stack.length = 0
        }
        return
      }

      case 0x39: { // WHO
        const { strings } = this.operands(1)
        this.selectedPlayer = this.host.who ? await this.host.who(strings[0] ?? '') : 0
        this.memory.character?.select(this.selectedPlayer)
        return
      }

      case 0x3a: // DELAY
        this.pc++
        await this.host.delay?.()
        return

      case 0x3b: { // SPELL
        // Who has the spell ready: its place in their list, and which member. Not found
        // is 0xff and the last member, as the original left it.
        const { operands } = this.operands(3)
        const found = this.host.spellHolder?.(this.value(operands[0]) & 0xff)
        this.memory.write(operands[1]!.word, found ? found.index : 0xff)
        this.memory.write(operands[2]!.word, found ? found.player : 0xff)
        return
      }

      case 0x3c: // PROTECTION
        this.operands(1)
        return

      case 0x3d: // CLEAR BOX
        this.pc++
        this.host.clearBox?.()
        return

      default:
        this.host.log?.(`unknown opcode 0x${opcode.toString(16).padStart(2, '0')} at 0x${address.toString(16)}`)
        this.result = { reason: 'unknown-opcode' }
        return
    }
  }

  get player(): number {
    return this.selectedPlayer
  }

  private async choose(prompt: string | undefined, items: readonly string[], layout: 'vertical' | 'horizontal'): Promise<number> {
    if (items.length === 0) return 0
    const chosen = this.host.menu ? await this.host.menu(prompt, items, layout) : 0
    return Math.min(items.length - 1, Math.max(0, chosen | 0))
  }

  /**
   * The encounter menu: COMBAT, WAIT, FLEE and ADVANCE or PARLAY, with the monsters'
   * attitude deciding what each choice leads to. Stores 0 (nothing happens), 1 (fight),
   * 2 (the party gets away) or 3 (talk) — the script branches on that.
   */
  private async encounterMenu(operands: EclOperand[], strings: string[]): Promise<void> {
    const sprite = this.value(operands[0]) & 0xff
    const maxDistance = this.value(operands[1]) & 0xff
    const picture = this.value(operands[2]) & 0xff
    const target = operands[3]!.word
    const attitudes = operands.slice(4, 9).map((o) => this.value(o) & 0xff)
    const fleeThreshold = this.value(operands[12]) & 0xff
    const chaseThreshold = this.value(operands[13]) & 0xff

    const world = this.memory.world
    let distance = Math.min(maxDistance, world ? world.distanceAhead() : 0)
    this.encounterView = { sprite, picture, distance }
    this.host.encounter?.(this.encounterView)

    const movement = this.host.partyMovement?.() ?? { min: 12, max: 12 }
    const inDungeon = this.memory.read(POOL_ADDRESSES.inDungeon) !== 0 || world !== undefined

    const closer = (): void => {
      if (distance > 0) distance--
      this.encounterView = { sprite, picture, distance }
      this.host.encounter?.(this.encounterView)
    }

    for (let round = 0; round < 64; round++) {
      // The line above the menu depends on how close they are; blank lines are skipped.
      let text = ''
      for (let i = 0; i < 3 && text.length === 0; i++) text = strings[(distance + i) % 3] ?? ''
      if (text.length > 0) await this.host.print?.(text, true)

      const close = distance === 0 || !inDungeon
      const items = close ? ['COMBAT', 'WAIT', 'FLEE', 'PARLAY'] : ['COMBAT', 'WAIT', 'FLEE', 'ADVANCE']
      let chosen = await this.choose(undefined, items, 'horizontal')
      if (close && chosen === 3) chosen = 4
      const attitude = attitudes[chosen] ?? 0

      // Each attitude is a small table of what the choice leads to.
      const COMBAT = 0, WAIT = 1, FLEE = 2, ADVANCE = 3, PARLAY = 4
      let result: number | undefined

      switch (attitude) {
        case 0:
          result = chosen !== FLEE ? 1 : movement.min >= fleeThreshold ? 2 : 1
          break
        case 1:
          if (chosen === COMBAT) result = 1
          else if (chosen === FLEE) result = 2
          else if (chosen === ADVANCE) closer()
          else if (chosen === PARLAY) { if (distance > 0) closer(); else result = 3 }
          break
        case 2:
          result = chosen === COMBAT ? (chaseThreshold > movement.max ? 0 : 1) : 0
          break
        case 3:
          if (chosen === COMBAT) result = 1
          else if (chosen === WAIT || chosen === ADVANCE) closer()
          else if (chosen === FLEE) result = 2
          else if (distance <= 0) result = 3
          else closer()
          break
        default:
          if (chosen === COMBAT) result = 1
          else if (chosen === FLEE) result = 2
          else if (distance <= 0) result = 3
          else closer()
          break
      }

      if (result !== undefined) {
        this.memory.write(target, result)
        return
      }
    }
  }
}
