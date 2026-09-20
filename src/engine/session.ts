/**
 * A game in progress: the level the party is on, where they stand, and the script
 * that decides what happens when they move.
 *
 * This is the loop the original ran. Entering a level runs its script's start entry;
 * every step runs the per-step entry and then the event dispatch for the square. A
 * script can load another map, another script, or move the party, and the session
 * follows. Everything the player sees goes out through `SessionUi`.
 */

import { decodeEcl, memStartFor, type EclProgram } from '../formats/ecl.js'
import type { Rgba } from '../formats/ega.js'
import { canWalk, cellAt, DIRECTIONS, type Direction, type GeoMap } from '../formats/geo.js'
import type { GameLibrary, LevelRef, SavedGame } from '../formats/library.js'
import { startingCell, startingFacing } from './dungeon.js'
import {
  EclMemory, EclVm, POOL_ADDRESSES,
  type CombatOutcome, type EclHost, type EncounterView, type MonsterGroup, type VmWorld,
} from './ecl-vm.js'
import { backward, forward, strafeLeft, strafeRight, turnAround, turnLeft, turnRight, type PartyState } from './party.js'
import { Roster, type Member } from './roster.js'
import { Combat, labelMonsters, type Combatant } from './combat.js'

export type MoveCommand = 'forward' | 'back' | 'left' | 'right' | 'turnLeft' | 'turnRight' | 'turnAround'

/** What the page must provide for a script to be played. */
export interface SessionUi {
  showLevel(map: GeoMap, textures: readonly Rgba[], name: string): void
  /** The party moved without walking there — a script placed them. */
  showParty(state: PartyState): void
  print(text: string, clear: boolean): void
  newLine(): void
  menu(prompt: string | undefined, items: readonly string[], layout: 'vertical' | 'horizontal'): Promise<number>
  inputNumber(): Promise<number>
  inputString(): Promise<string>
  delay(): Promise<void>
  /** A picture to show over the view, or nothing to go back to the view. */
  picture(image: Rgba | undefined): void
  encounter(view: EncounterView, image: Rgba | undefined): void
  monsters(groups: readonly MonsterGroup[]): void
  /**
   * A round of combat has been resolved; shows the lines and asks whether to keep
   * fighting. Returns false to run.
   */
  combatRound(round: number, lines: readonly string[], party: readonly Combatant[], monsters: readonly Combatant[]): Promise<boolean>
  /** The party changed: someone was hurt, paid, or picked. */
  party(members: readonly Member[], selected: number): void
  /** Picks a party member by index. */
  who(prompt: string, members: readonly Member[]): Promise<number>
  combat(monsters: readonly MonsterGroup[]): Promise<CombatOutcome>
  parlay(): Promise<number>
  /** Something worth telling a developer, not the player. */
  note(message: string): void
}

const START_HOUR = 8

export class GameSession {
  readonly memory = new EclMemory()
  readonly roster = new Roster()
  private readonly vm: EclVm
  private program: EclProgram | undefined
  private blockId = 0
  /** The area number: which ECL, GEO and PIC files this script lives in. */
  private area = 1

  map: GeoMap | undefined
  mapRef: LevelRef | undefined
  textures: readonly Rgba[] = []
  party: PartyState = { row: 0, col: 0, facing: 'north' }

  private levelDirty = false
  private positionSetByScript = false
  private running = false

  constructor(private readonly library: GameLibrary, private readonly ui: SessionUi) {
    this.memory.world = this.world()
    this.memory.character = this.roster.hook()
    this.vm = new EclVm(this.memory, this.host())
    this.setTime(START_HOUR, 0)
    this.memory.write(POOL_ADDRESSES.inDungeon, 1)
  }

  /** Loads a saved game's globals, so the scripts see the world as it was left. */
  restore(saved: SavedGame): void {
    this.memory.loadWords(POOL_ADDRESSES.globalsBase, saved.globals)
    this.memory.loadWords(POOL_ADDRESSES.areaScratchBase, saved.areaScratch)
    this.memory.loadWords(POOL_ADDRESSES.extraBase, saved.extra)
    this.area = saved.area
  }

  /**
   * Starts where a saved game left off: its last script, at its last position. A new
   * game is this with the saved game the original shipped.
   */
  async resume(saved: SavedGame): Promise<void> {
    this.restore(saved)
    this.roster.members = await this.library.party(saved)
    this.ui.party(this.roster.members, this.roster.selected)
    const blockId = this.memory.read(POOL_ADDRESSES.lastEclBlock)
    const ref = await this.library.levelById(blockId, this.area)
    if (!ref) {
      this.ui.note(`the saved game's map ${blockId} is not in the folder`)
      return
    }
    this.map = await this.library.level(ref)
    this.mapRef = ref
    this.textures = (await this.library.wallSetFor(ref)).textures
    this.levelDirty = true
    this.party = {
      row: this.memory.read(POOL_ADDRESSES.lastY) & 0x0f,
      col: this.memory.read(POOL_ADDRESSES.lastX) & 0x0f,
      facing: 'north',
    }
    this.positionSetByScript = true

    // The script checks whether it was the last one loaded to skip its setup; it was.
    await this.withScript(async () => {
      await this.loadScript(blockId)
      await this.runStart()
    })
  }

  get busy(): boolean {
    return this.running
  }

  /** Enters a level from the list: runs the script that loads it, which loads it. */
  async enterLevel(ref: LevelRef): Promise<void> {
    const program = await this.library.eclForLevel(ref)
    const blockId = program?.blockId ?? ref.id
    this.area = Number(ref.file.match(/\d+/)?.[0] ?? 1)

    // Loaded here, before the script, so a script that never says LOAD FILES still
    // leaves the player standing somewhere.
    this.map = await this.library.level(ref)
    this.mapRef = ref
    this.textures = (await this.library.wallSetFor(ref)).textures
    this.levelDirty = true

    await this.withScript(async () => {
      await this.loadScript(blockId)
      await this.runStart()
    })
  }

  /** A movement key. Turns are free; steps run the script when they land. */
  async move(command: MoveCommand): Promise<boolean> {
    if (this.running || !this.map) return false
    const map = this.map

    if (command === 'turnLeft' || command === 'turnRight' || command === 'turnAround') {
      this.party = command === 'turnLeft' ? turnLeft(this.party) : command === 'turnRight' ? turnRight(this.party) : turnAround(this.party)
      return true
    }

    const result =
      command === 'forward' ? forward(map, this.party)
        : command === 'back' ? backward(map, this.party)
          : command === 'left' ? strafeLeft(map, this.party)
            : strafeRight(map, this.party)
    if (!result.moved) return false

    this.party = result.state
    this.advanceTime(1)
    await this.withScript(() => this.afterStep())
    return true
  }

  // ---- running scripts -------------------------------------------------------

  private async withScript(work: () => Promise<void>): Promise<void> {
    this.running = true
    try {
      await work()
    } catch (error) {
      this.ui.note(`script failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.running = false
      this.settle()
    }
  }

  private async loadScript(blockId: number): Promise<void> {
    const found = await this.library.eclBlock(blockId, this.area)
    if (!found) {
      this.ui.note(`no script block ${blockId} in any ECL file`)
      this.program = undefined
      return
    }
    const memStart = memStartFor(this.library.game.id)
    this.memory.loadImage(found.data, memStart)
    this.program = decodeEcl(blockId, found.data, memStart)
    this.blockId = blockId
    this.area = found.area

    // A freshly loaded script starts with clean scratch, as the original's init did.
    this.memory.clearWords(POOL_ADDRESSES.scratchStart, POOL_ADDRESSES.scratchEnd)
    this.memory.clearWords(POOL_ADDRESSES.localsStart, POOL_ADDRESSES.localsEnd)
  }

  /** The start entry, then the per-step pair — what the original did on every load. */
  private async runStart(): Promise<void> {
    if (!this.program) return
    if (await this.runEntry(this.program.entryPoints.start)) return
    this.memory.write(POOL_ADDRESSES.lastEclBlock, this.blockId)
    await this.afterStep()
  }

  private async afterStep(): Promise<void> {
    if (!this.program) return
    if (await this.runEntry(this.program.entryPoints.vmRun)) return
    if (await this.runEntry(this.program.entryPoints.searchLocation)) return
    this.memory.write(POOL_ADDRESSES.lastEclBlock, this.blockId)
  }

  /**
   * Runs one entry point. When the script loads another script, that one's start code
   * runs in its place, so the return says whether control left this script.
   */
  private async runEntry(entry: number): Promise<boolean> {
    const result = await this.vm.run(entry)
    if (result.reason === 'newEcl' && result.newEcl !== undefined) {
      await this.loadScript(result.newEcl)
      await this.runStart()
      return true
    }
    if (result.reason === 'unknown-opcode' || result.reason === 'runaway') {
      this.ui.note(`script stopped: ${result.reason}`)
    }
    return false
  }

  /** After a script has run: rebuild the level if it changed, and show where the party is. */
  private settle(): void {
    if (this.levelDirty && this.map) {
      if (!this.positionSetByScript) {
        const cell = startingCell(this.map)
        this.party = { row: cell.row, col: cell.col, facing: startingFacing(this.map, cell) }
      }
      this.ui.showLevel(this.map, this.textures, this.mapRef?.name ?? `Map ${this.map.id}`)
      this.levelDirty = false
    }
    this.positionSetByScript = false
    this.ui.showParty(this.party)
    this.ui.party(this.roster.members, this.roster.selected)
  }

  // ---- combat ------------------------------------------------------------------

  /** Runs a fight against the groups LOAD MONSTER queued, a round at a time. */
  private async fight(groups: readonly MonsterGroup[]): Promise<CombatOutcome> {
    const loaded: { member: Member; count: number }[] = []
    for (const group of groups) {
      const monster = await this.library.monster(this.area, group.id)
      if (monster) loaded.push({ member: monster, count: group.count })
      else this.ui.note(`monster ${group.id} is not in MON${this.area}CHA.DAX`)
    }
    if (loaded.length === 0) return this.ui.combat(groups)

    const party = this.roster.members.map((member) => ({ member, label: member.character.name }))
    const combat = new Combat(party, labelMonsters(loaded), (max) => Math.floor(Math.random() * (max + 1)))
    const random = (max: number) => Math.floor(Math.random() * (max + 1))

    let outcome: CombatOutcome = 'won'
    while (!combat.over) {
      const lines = combat.next()
      this.ui.party(this.roster.members, this.roster.selected)
      if (combat.over) {
        await this.ui.combatRound(combat.round, lines, combat.party, combat.monsters)
        break
      }
      const keepFighting = await this.ui.combatRound(combat.round, lines, combat.party, combat.monsters)
      if (!keepFighting) {
        // Running works when the party is quicker than what is chasing it.
        const chase = Math.max(...combat.monstersStanding.map((m) => m.member.character.movement))
        if (this.roster.movement().min + random(5) >= chase) {
          outcome = 'fled'
          break
        }
        this.ui.print('THE PARTY CANNOT GET AWAY!', true)
      }
    }

    if (outcome !== 'fled') outcome = combat.partyStanding.length > 0 ? 'won' : 'lost'
    if (outcome === 'won') {
      const experience = combat.experience()
      const standing = this.roster.active
      if (experience > 0 && standing.length > 0) {
        const each = Math.floor(experience / standing.length)
        for (const member of standing) member.character.experience += each
        this.ui.print(`EACH SURVIVOR GAINS ${each} EXPERIENCE.`, true)
      }
    }
    if (outcome === 'lost') this.ui.print('THE PARTY HAS FALLEN.', true)
    this.ui.party(this.roster.members, this.roster.selected)
    return outcome
  }

  // ---- time --------------------------------------------------------------------

  private setTime(hour: number, minute: number): void {
    this.memory.write(POOL_ADDRESSES.timeHour, hour)
    this.memory.write(POOL_ADDRESSES.timeMinutesTens, Math.floor(minute / 10))
    this.memory.write(POOL_ADDRESSES.timeMinutesOnes, minute % 10)
  }

  get time(): { hour: number; minute: number } {
    return {
      hour: this.memory.read(POOL_ADDRESSES.timeHour),
      minute: this.memory.read(POOL_ADDRESSES.timeMinutesTens) * 10 + this.memory.read(POOL_ADDRESSES.timeMinutesOnes),
    }
  }

  private advanceTime(minutes: number): void {
    const { hour, minute } = this.time
    const total = hour * 60 + minute + minutes
    if (total >= 24 * 60) this.memory.write(POOL_ADDRESSES.timeDay, this.memory.read(POOL_ADDRESSES.timeDay) + 1)
    this.setTime(Math.floor(total / 60) % 24, total % 60)
  }

  // ---- what the VM sees --------------------------------------------------------

  private world(): VmWorld {
    const session = this
    return {
      get position() {
        return { row: session.party.row, col: session.party.col, facing: DIRECTIONS.indexOf(session.party.facing) }
      },
      setPosition(row, col) {
        session.party = { ...session.party, row: row & 0x0f, col: col & 0x0f }
        session.positionSetByScript = true
      },
      setFacing(facing) {
        session.party = { ...session.party, facing: DIRECTIONS[facing & 3] as Direction }
        session.positionSetByScript = true
      },
      wallAhead() {
        const cell = session.map && cellAt(session.map, session.party.row, session.party.col)
        return cell ? cell.walls[session.party.facing] : 0
      },
      cellEvent() {
        const cell = session.map && cellAt(session.map, session.party.row, session.party.col)
        return cell ? cell.event | (cell.eventFlag ? 0x80 : 0) : 0
      },
      distanceAhead() {
        const map = session.map
        if (!map) return 0
        let { row, col } = session.party
        let distance = 0
        while (distance < 2 && canWalk(map, row, col, session.party.facing)) {
          ;({ row, col } = stepFrom(row, col, session.party.facing))
          distance++
        }
        return distance
      },
      stepForward() {
        if (!session.map) return
        const result = forward(session.map, session.party)
        if (result.moved) {
          session.party = result.state
          session.positionSetByScript = true
        }
      },
    }
  }

  private host(): EclHost {
    const ui = this.ui
    return {
      print: (text, clear) => ui.print(text, clear),
      newLine: () => ui.newLine(),
      menu: (prompt, items, layout) => ui.menu(prompt, items, layout),
      inputNumber: () => ui.inputNumber(),
      inputString: () => ui.inputString(),
      delay: () => ui.delay(),
      picture: async (id) => {
        ui.picture(id === 0xff ? undefined : await this.library.picture(this.area, id))
      },
      encounter: async (view) => {
        // Up close it is the portrait; further off, the sprite drawn at that distance.
        const image = view.distance === 0
          ? await this.library.picture(this.area, view.picture)
          : (await this.library.sprite(this.area, view.sprite))?.frames[view.distance]
        ui.encounter(view, image)
      },
      loadMonster: () => ui.monsters(this.vm.monsters),
      clearMonsters: () => ui.monsters([]),
      combat: (groups) => this.fight(groups),
      parlay: () => ui.parlay(),
      who: (prompt) => ui.who(prompt, this.roster.members),
      partyStrength: () => this.roster.strength(),
      partyMovement: () => this.roster.movement(),
      loadMap: async (id) => {
        const ref = await this.library.levelById(id, this.area)
        if (!ref) {
          ui.note(`script asked for map ${id}, which is not in the folder`)
          return
        }
        const map = await this.library.level(ref)
        if (!map) return
        this.map = map
        this.mapRef = ref
        this.levelDirty = true
      },
      loadWallSets: async (ids) => {
        this.textures = (await this.library.wallSetFromIds(ids)).textures
        this.levelDirty = true
      },
      call: (id) => {
        if (id !== 0xc01e) ui.note(`CALL 0x${id.toString(16)} is not implemented`)
      },
      program: (id) => {
        const names: Record<number, string> = { 0: 'the start menu', 3: 'the party has been killed', 8: 'the game is won', 9: 'the party makes camp' }
        ui.note(`PROGRAM ${id}: ${names[id] ?? 'unknown'} (not implemented)`)
      },
      treasure: (treasure) => {
        const coins = [['copper', treasure.copper], ['silver', treasure.silver], ['electrum', treasure.electrum], ['gold', treasure.gold], ['platinum', treasure.platinum]] as const
        const found = coins.filter(([, n]) => n > 0).map(([name, n]) => `${n} ${name}`)
        if (treasure.gems > 0) found.push(`${treasure.gems} gems`)
        if (treasure.jewellery > 0) found.push(`${treasure.jewellery} jewellery`)
        if (found.length === 0) return
        this.roster.addTreasure(treasure)
        ui.print(`YOU FIND ${found.join(', ').toUpperCase()}.`, false)
        ui.party(this.roster.members, this.roster.selected)
      },
      damage: (spec) => {
        const lines = this.roster.applyDamage(spec, (max) => Math.floor(Math.random() * (max + 1)))
        for (const line of lines) ui.print(`\n${line}`, false)
        ui.party(this.roster.members, this.roster.selected)
      },
      log: (message) => ui.note(message),
    }
  }
}

function stepFrom(row: number, col: number, facing: Direction): { row: number; col: number } {
  switch (facing) {
    case 'north': return { row: row - 1, col }
    case 'east': return { row, col: col + 1 }
    case 'south': return { row: row + 1, col }
    case 'west': return { row, col: col - 1 }
  }
}
