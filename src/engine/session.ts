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
  CALL_DUEL, CALL_QUIET, CALL_REDRAW, CALL_WILD, CALL_SOUND, CALL_STEP_FORWARD, EclMemory, EclVm, POOL_ADDRESSES,
  type CombatOutcome, type EclHost, type EncounterView, type MonsterGroup, type VmWorld,
} from './ecl-vm.js'
import { backward, forward, strafeLeft, strafeRight, turnAround, turnLeft, turnRight, type PartyState } from './party.js'
import { Roster, type Member } from './roster.js'
import { characterLevel, className, raceName, type Character, type Item } from '../formats/character.js'
export type { Spell }
import { Combat, labelMonsters, type Combatant } from './combat.js'
import { Battle, type Fighter } from './battle.js'
import { buy, describeCoins, emptyPool, poolIsEmpty, sell, shareCoins, take, type Pool } from './treasure.js'
import { itemDisplayName } from '../formats/items.js'
import { spellById, type Spell } from '../formats/spells.js'
import { autoPrepare, canCast, cast, forget, knownAt, memorise, ready, refresh, slots } from './casting.js'
import { readyToTrain, train, TRAINING_COST } from './training.js'
import { ready as readyItem, recompute, unready } from './equipment.js'
import type { ItemType } from '../formats/items.js'
import { writeCharacter, writeItems, writeSavedGame } from '../formats/save-writer.js'
import { SAVED_GAME_EXTRA, SAVED_GAME_GLOBALS, SAVED_GAME_SCRATCH } from '../formats/library.js'
import { pay } from './treasure.js'

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
  /** The group is gone from the view. */
  spriteOff(): void
  monsters(groups: readonly MonsterGroup[]): void
  /**
   * A round of combat has been resolved; shows the lines and asks whether to keep
   * fighting. Returns false to run.
   */
  combatRound(round: number, lines: readonly string[], party: readonly Combatant[], monsters: readonly Combatant[]): Promise<'fight' | 'cast' | 'run'>
  /** Which kind of fight the player wants. */
  battleMode(monsters: readonly Combatant[]): Promise<'tactical' | 'quick'>
  /** The art a battle is drawn with, before it starts. */
  battleArt(tiles: readonly Rgba[], decorations: readonly Rgba[], outdoors: boolean): void
  /** Shows the battle after something happened; `lines` say what. */
  battleUpdate(battle: Battle, lines: readonly string[]): Promise<void>
  /**
   * The player's turn: the page moves the fighter and strikes; `cast` runs a spell
   * for them. Returns 'run' if the party tries to flee, otherwise when the turn ends.
   */
  battleTurn(battle: Battle, fighter: Fighter, cast: () => Promise<string[]>, use: () => Promise<string[]>): Promise<'done' | 'run'>
  /** The battle is over; take the map down. */
  battleEnd(): void
  /** The party changed: someone was hurt, paid, or picked. */
  party(members: readonly Member[], selected: number): void
  /** Picks a party member by index. */
  who(prompt: string, members: readonly Member[]): Promise<number>
  /** The game was saved to the browser. */
  saved(): void
  /** Files in the original's formats, for the player to put in their game folder. */
  files(files: readonly { name: string; bytes: Uint8Array }[]): void
  combat(monsters: readonly MonsterGroup[]): Promise<CombatOutcome>
  parlay(): Promise<number>
  /** Something worth telling a developer, not the player. */
  note(message: string): void
}

const START_HOUR = 8
const HOURS_PER_REST = 8

/** Everything a game needs to pick up where it left off. Stays in the browser. */
export interface Snapshot {
  version: 1
  area: number
  blockId: number
  mapId: number
  party: PartyState
  memory: { words: number[]; strings: [number, string][] }
  members: { character: Character; items: Item[] }[]
  pool?: Pool
}

export class GameSession {
  readonly memory = new EclMemory()
  readonly roster = new Roster()
  /** The dice. Replaceable, so a run can be replayed. */
  random: (max: number) => number = (max) => Math.floor(Math.random() * (max + 1))
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
  /** Set by a duel CALL: the next fight is this member alone. */
  private champion: Member | undefined
  /** What TREASURE left on the ground, or a shop's shelf. */
  pool: Pool = emptyPool()
  private itemNames: string[] = []
  private itemTypes: ItemType[] = []

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
  async resume(saved: SavedGame, members?: Member[]): Promise<void> {
    this.restore(saved)
    this.roster.members = members ?? await this.library.party(saved)
    for (const { character } of this.roster.members) if (canCast(character) && character.prepared.length === 0) autoPrepare(character)
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

  /** Which script is running. */
  get scriptId(): number {
    return this.blockId
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

  /** Picks up a saved snapshot: the same script, map and party as when it was taken. */
  async load(snapshot: Snapshot): Promise<void> {
    this.memory.restore(snapshot.memory)
    this.roster.members = snapshot.members.map((m) => ({ character: m.character, items: m.items }))
    this.pool = snapshot.pool ?? emptyPool()
    this.area = snapshot.area
    this.party = snapshot.party
    this.positionSetByScript = true
    const ref = await this.library.levelById(snapshot.mapId, this.area)
    if (!ref) {
      this.ui.note(`the saved map ${snapshot.mapId} is not in the folder`)
      return
    }
    this.map = await this.library.level(ref)
    this.mapRef = ref
    this.textures = (await this.library.wallSetFor(ref)).textures
    this.levelDirty = true
    this.ui.party(this.roster.members, this.roster.selected)
    await this.withScript(async () => {
      await this.loadScript(snapshot.blockId)
      // The script was already running when the game was saved, so no start entry.
      this.memory.write(POOL_ADDRESSES.lastEclBlock, this.blockId)
    })
  }

  snapshot(): Snapshot {
    return {
      version: 1,
      area: this.area,
      blockId: this.blockId,
      mapId: this.map?.id ?? 0,
      party: { ...this.party },
      memory: this.memory.snapshot(),
      members: this.roster.members.map((m) => ({ character: m.character, items: m.items })),
      pool: this.pool,
    }
  }

  /**
   * Making camp: rest to heal, or save. The script gets its say first — the
   * pre-camp entry can refuse — and while the party rests, the area's own odds
   * decide whether something wanders in and the camp-interrupted entry runs.
   */
  async camp(): Promise<void> {
    if (this.running || !this.program) return
    await this.withScript(async () => {
      if (await this.runEntry(this.program!.entryPoints.preCampCheck)) return
      await this.campMenu()
    })
  }

  /**
   * The original's party menu, which PROGRAM 0 opened. Here it is the training
   * hall's business: the hall's mask says who it teaches.
   */
  private async partyMenu(): Promise<void> {
    const mask = this.memory.read(POOL_ADDRESSES.trainingMask)
    if (mask === 0) return
    const random = this.random
    for (;;) {
      const candidates = this.roster.members
        .map((member) => ({ member, tracks: readyToTrain(member.character, mask) }))
        .filter((c) => c.tracks.length > 0)
      if (candidates.length === 0) {
        this.ui.print('NOBODY HERE IS READY TO TRAIN.', true)
        await this.ui.menu(undefined, ['PRESS <RETURN> OR BUTTON TO CONTINUE'], 'horizontal')
        return
      }
      const options = candidates.flatMap((c) => c.tracks.map((track) => `${c.member.character.name} AS ${track.toUpperCase()} — ${TRAINING_COST} GOLD`))
      const choice = await this.ui.menu('TRAIN:', [...options, 'LEAVE'], 'vertical')
      if (choice >= options.length) return
      const flat = candidates.flatMap((c) => c.tracks.map((track) => ({ member: c.member, track })))
      const { member, track } = flat[choice]!
      if (!pay(member, TRAINING_COST)) {
        this.ui.print(`${member.character.name} CANNOT PAY.`, true)
        continue
      }
      const gained = train(member.character, track, random)
      this.ui.print(`${member.character.name} IS NOW A LEVEL ${gained.level} ${track.toUpperCase()}, AND GAINS ${gained.hitPoints} HIT POINTS.`, true)
      this.ui.party(this.roster.members, this.roster.selected)
    }
  }

  private async campMenu(): Promise<void> {
    {
      for (;;) {
        // The dead need a temple, not a night's sleep.
        const hurt = this.roster.members.filter((m) => m.character.hpCurrent < m.character.hpMax && m.character.status !== 'dead')
        const unready = this.roster.members.filter((m) => m.character.prepared.length > m.character.memorised.length)
        const state = hurt.length > 0 ? `${hurt.length} NEED REST.` : unready.length > 0 ? 'SPELLS TO MEMORISE.' : 'EVERYONE IS WELL.'
        const choice = await this.ui.menu(`CAMP. ${state}`,
          ['REST', 'MEMORISE', 'CAST', 'USE', 'SAVE GAME', 'EXPORT DOS SAVE B', 'LEAVE CAMP'], 'vertical')
        if (choice === 0) {
          if (await this.rest()) return
        } else if (choice === 1) {
          await this.memoriseMenu()
        } else if (choice === 2) {
          await this.castOutside()
        } else if (choice === 3) {
          await this.useOutside()
        } else if (choice === 4) {
          this.ui.saved()
        } else if (choice === 5) {
          this.ui.files(await this.dosSave('B'))
          this.ui.print('SAVGAMB.DAT AND THE CHRDATB FILES ARE READY. PUT THEM IN THE GAME FOLDER AND LOAD GAME B.', true)
        } else {
          return
        }
      }
    }
  }

  /** One night's rest: a hit point back for each, unless something interrupts. Returns true if it did. */
  private async rest(): Promise<boolean> {
    const period = Math.max(1, this.memory.read(POOL_ADDRESSES.restPeriod) || HOURS_PER_REST)
    const chance = this.memory.read(POOL_ADDRESSES.restChance)
    for (let hour = 0; hour < HOURS_PER_REST; hour++) {
      this.advanceTime(60)
      if ((hour + 1) % period === 0 && chance > 0 && this.random(99) < chance) {
        this.ui.print('THE PARTY IS DISTURBED!', true)
        await this.runEntry(this.program!.entryPoints.campInterrupted)
        return true
      }
    }
    for (const { character } of this.roster.members) {
      if (character.status === 'unconscious') {
        character.status = 'okay'
        character.statusByte = 0
      }
      if (character.status === 'okay' && character.hpCurrent < character.hpMax) character.hpCurrent++
      refresh(character)
    }
    this.ui.print('THE PARTY RESTS. SPELLS ARE MEMORISED.', true)
    this.ui.party(this.roster.members, this.roster.selected)
    return false
  }

  /** Outdoors: the original showed the map from above and let the script do the walking. */
  get overhead(): boolean {
    return this.memory.read(POOL_ADDRESSES.inDungeon) === 0
  }

  get searching(): boolean {
    return (this.memory.read(POOL_ADDRESSES.searchFlags) & 1) !== 0
  }

  /** Searching: slower going, and the scripts show what a careful party finds. */
  toggleSearch(): void {
    const flags = this.memory.read(POOL_ADDRESSES.searchFlags)
    this.memory.write(POOL_ADDRESSES.searchFlags, flags ^ 1)
  }

  /** Looking: the square's script runs again with the looking bit set. */
  async look(): Promise<void> {
    if (this.running || !this.program) return
    const flags = this.memory.read(POOL_ADDRESSES.searchFlags)
    this.memory.write(POOL_ADDRESSES.searchFlags, flags | 2)
    await this.withScript(() => this.afterStep())
    this.memory.write(POOL_ADDRESSES.searchFlags, this.memory.read(POOL_ADDRESSES.searchFlags) & ~2)
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

    if (!result.moved) {
      // Walking off the edge through an open side is how the party leaves an area:
      // the script's per-step code reads the flag and loads the neighbour.
      if (this.leavesMap(result.blocked)) {
        this.memory.write(POOL_ADDRESSES.triedToExit, 1)
        await this.withScript(() => this.afterStep())
        this.memory.write(POOL_ADDRESSES.triedToExit, 0)
        return true
      }
      return false
    }

    this.party = result.state
    // A wilderness square is a long way; a searched dungeon square is slow going.
    this.advanceTime(this.overhead ? 60 : this.searching ? 10 : 1)
    await this.withScript(() => this.afterStep())
    return true
  }

  /** True when a step in `direction` goes off the map and nothing solid is in the way. */
  private leavesMap(direction: Direction): boolean {
    const map = this.map
    if (!map) return false
    const here = cellAt(map, this.party.row, this.party.col)
    if (!here) return false
    const next = stepFrom(this.party.row, this.party.col, direction)
    const offMap = next.row < 0 || next.row > 15 || next.col < 0 || next.col > 15
    const open = here.walls[direction] === 0 || here.doors[direction] !== 0
    return offMap && open
  }

  // ---- running scripts -------------------------------------------------------

  private async withScript(work: () => Promise<void>): Promise<void> {
    this.running = true
    try {
      await work()
    } catch (error) {
      this.ui.note(`script failed: ${error instanceof Error ? `${error.message}\n${error.stack?.split('\n').slice(1, 4).join('\n')}` : String(error)}`)
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
    this.memory.write(POOL_ADDRESSES.triedToExit, 0)
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
    if (result.reason === 'newEcl' && result.newEcl === 0xff) {
      // The original reloaded "block 255" and looped on the missing block; nothing to load.
      return false
    }
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
    if (this.levelDirty) this.showLevelNow()
    this.positionSetByScript = false
    this.ui.showParty(this.party)
    this.ui.party(this.roster.members, this.roster.selected)
  }

  private showLevelNow(): void {
    if (!this.map) return
    if (!this.positionSetByScript) {
      const cell = startingCell(this.map)
      this.party = { row: cell.row, col: cell.col, facing: startingFacing(this.map, cell) }
    }
    this.ui.showLevel(this.map, this.textures, this.mapRef?.name ?? `Map ${this.map.id}`)
    this.ui.showParty(this.party)
    this.levelDirty = false
  }

  // ---- combat ------------------------------------------------------------------

  /** Runs a fight against the groups LOAD MONSTER queued, a round at a time. */
  private async fight(groups: readonly MonsterGroup[]): Promise<CombatOutcome> {
    this.memory.write(POOL_ADDRESSES.combatResult, 0)
    if (groups.length === 0) {
      if (this.memory.read(POOL_ADDRESSES.enterTemple) === 1) {
        this.memory.write(POOL_ADDRESSES.enterTemple, 0)
        await this.temple()
      } else if (this.memory.read(POOL_ADDRESSES.enterShop) === 1) {
        this.memory.write(POOL_ADDRESSES.enterShop, 0)
        await this.shop()
      } else {
        await this.takeTreasure()
      }
      return 'won'
    }

    const loaded: { member: Member; count: number; picture: number }[] = []
    const types = await this.types()
    for (const group of groups) {
      const monster = await this.library.monster(this.area, group.id)
      if (!monster) {
        this.ui.note(`monster ${group.id} is not in MON${this.area}CHA.DAX`)
        continue
      }
      // A bow in its hands gives the record's attack its range; its book gives it spells.
      const bow = monster.items.find((item) => item.readied && (types[item.type]?.range ?? 0) > 0)
      if (bow) monster.character.attacks.range = types[bow.type]!.range
      if (canCast(monster.character)) autoPrepare(monster.character)
      loaded.push({ member: monster, count: group.count, picture: group.picture })
    }
    if (loaded.length === 0) return this.ui.combat(groups)
    const random = this.random
    const outcome = await this.fightLoaded(loaded, random)
    this.memory.write(POOL_ADDRESSES.combatResult, outcome === 'won' ? 0 : outcome === 'fled' ? 0x81 : 0x80)
    return outcome
  }

  private async fightLoaded(loaded: { member: Member; count: number; picture: number }[], random: (max: number) => number): Promise<CombatOutcome> {

    const fighters = this.champion ? [this.champion] : this.roster.members
    this.champion = undefined
    const party: Combatant[] = fighters.map((member) => ({ member, label: member.character.name }))
    const monsters = labelMonsters(loaded)

    const mode = await this.ui.battleMode(monsters)
    if (mode === 'tactical' && this.map) {
      for (const c of party) c.icon = await this.library.partyIcon(c.member.character)
      const icons = new Map<number, Rgba | undefined>()
      for (const c of monsters) {
        if (c.picture === undefined) continue
        if (!icons.has(c.picture)) icons.set(c.picture, await this.library.combatIcon(this.area, c.picture))
        c.icon = icons.get(c.picture)
      }
      return this.tacticalFight(party, monsters, random)
    }

    const combat = new Combat(party, monsters, random)
    let outcome: CombatOutcome = 'won'
    let lines: string[] = [`${combat.monsters.length} FOE${combat.monsters.length === 1 ? '' : 'S'}: ${[...new Set(combat.monsters.map((m) => m.member.character.name))].join(', ')}.`]
    while (!combat.over) {
      this.ui.party(this.roster.members, this.roster.selected)
      const choice = await this.ui.combatRound(combat.round, lines, combat.party, combat.monsters)
      if (choice === 'cast') {
        lines = await this.castInCombat(combat)
        continue
      }
      if (choice === 'run') {
        // Running works when the party is quicker than what is chasing it.
        const chase = Math.max(...combat.monstersStanding.map((m) => m.member.character.movement))
        if (this.roster.movement().min + random(5) >= chase) {
          outcome = 'fled'
          break
        }
        lines = ['THE PARTY CANNOT GET AWAY!']
      }
      lines = combat.next()
    }
    if (combat.over) {
      this.ui.party(this.roster.members, this.roster.selected)
      await this.ui.combatRound(combat.round, lines, combat.party, combat.monsters)
    }
    combat.finish()

    return this.reckon(combat, outcome)
  }

  /**
   * After the fight: the fallen monsters' experience is split across the survivors,
   * and what they carried — coins and items — lies on the ground for the taking.
   */
  private async reckon(combat: Combat, outcome: CombatOutcome): Promise<CombatOutcome> {
    if (outcome !== 'fled') outcome = combat.party.some((c) => c.member.character.status === 'okay') ? 'won' : 'lost'
    if (outcome === 'won') {
      const experience = combat.experience()
      const standing = this.roster.active
      if (experience > 0 && standing.length > 0) {
        const each = Math.floor(experience / standing.length)
        for (const member of standing) member.character.experience += each
        this.ui.print(`EACH SURVIVOR GAINS ${each} EXPERIENCE.`, true)
      }
      for (const m of combat.monsters) {
        if (m.member.character.status === 'okay' || m.member.character.status === 'running') continue
        m.member.character.money.forEach((n, kind) => { this.pool.coins[kind] = (this.pool.coins[kind] ?? 0) + n })
        for (const item of m.member.items) this.pool.items.push({ ...item, readied: false })
      }
    }
    if (outcome === 'lost') this.ui.print('THE PARTY HAS FALLEN.', true)
    this.ui.party(this.roster.members, this.roster.selected)
    if (outcome === 'won') await this.takeTreasure()
    return outcome
  }

  /** The fight on the grid: turns until one side is done, then the same reckoning. */
  private async tacticalFight(party: Combatant[], monsters: Combatant[], random: (max: number) => number): Promise<CombatOutcome> {
    const battle = new Battle(this.map!, party, monsters, this.party, 1, random, this.overhead)
    this.ui.battleArt(await this.library.combatTiles(this.overhead), await this.library.randomTiles(), this.overhead)
    let outcome: CombatOutcome = 'won'
    await this.ui.battleUpdate(battle, [`${monsters.length} FOE${monsters.length === 1 ? '' : 'S'}: ${[...new Set(monsters.map((m) => m.member.character.name))].join(', ')}.`])

    while (!battle.over) {
      const fighter = battle.current
      if (!fighter) { battle.endTurn(); continue }
      if (fighter.side === 'monster') {
        const lines = battle.monsterTurn(fighter)
        await this.ui.battleUpdate(battle, lines)
        battle.endTurn()
        continue
      }
      const result = await this.ui.battleTurn(battle, fighter, async () => {
        const lines = await this.castInCombat(battle.combat)
        fighter.acted = true
        fighter.moves = 0
        return lines
      }, async () => {
        const lines = await this.useInCombat(battle.combat, fighter)
        if (lines.length > 0) { fighter.acted = true; fighter.moves = 0 }
        return lines
      })
      this.ui.party(this.roster.members, this.roster.selected)
      if (result === 'run') {
        const chase = Math.max(0, ...battle.combat.monstersStanding.map((m) => m.member.character.movement))
        if (this.roster.movement().min + random(5) >= chase) { outcome = 'fled'; break }
        await this.ui.battleUpdate(battle, ['THE PARTY CANNOT GET AWAY!'])
      }
      battle.endTurn()
    }
    this.ui.battleEnd()
    battle.combat.finish()

    return this.reckon(battle.combat, outcome)
  }

  private async names(): Promise<string[]> {
    if (this.itemNames.length === 0) this.itemNames = await this.library.itemNames()
    return this.itemNames
  }

  private async types(): Promise<ItemType[]> {
    if (this.itemTypes.length === 0) this.itemTypes = await this.library.itemTypes()
    return this.itemTypes
  }

  /**
   * The game as the original's files: SAVGAM?.DAT with the memory blocks, the script
   * image and the position, and a .SAV and .ITM per member named for the slot, the
   * way the shipped J party is.
   */
  async dosSave(letter: string): Promise<{ name: string; bytes: Uint8Array }[]> {
    this.memory.write(POOL_ADDRESSES.lastX, this.party.col)
    this.memory.write(POOL_ADDRESSES.lastY, this.party.row)
    this.memory.write(POOL_ADDRESSES.lastEclBlock, this.blockId)
    const names = await this.names()
    const { itemDisplayName } = await import('../formats/items.js')
    const files: { name: string; bytes: Uint8Array }[] = []
    const party: string[] = []
    this.roster.members.forEach((member, index) => {
      const base = `CHRDAT${letter.toUpperCase()}${index + 1}`
      party.push(base)
      files.push({ name: `${base}.SAV`, bytes: writeCharacter(member.character) })
      files.push({ name: `${base}.ITM`, bytes: writeItems(member.items, member.items.map((item) => itemDisplayName(item, names))) })
    })
    const cell = this.map && cellAt(this.map, this.party.row, this.party.col)
    files.unshift({
      name: `SAVGAM${letter.toUpperCase()}.DAT`,
      bytes: writeSavedGame({
        area: this.area,
        globals: this.memory.bytesOf(POOL_ADDRESSES.globalsBase, SAVED_GAME_GLOBALS / 2),
        areaScratch: this.memory.bytesOf(POOL_ADDRESSES.areaScratchBase, SAVED_GAME_SCRATCH / 2),
        extra: this.memory.bytesOf(POOL_ADDRESSES.extraBase, SAVED_GAME_EXTRA / 2),
        script: this.memory.imageBytes(),
        position: {
          col: this.party.col, row: this.party.row, facing: DIRECTIONS.indexOf(this.party.facing),
          wallAhead: cell ? cell.walls[this.party.facing] : 0,
          cellEvent: cell ? cell.event | (cell.eventFlag ? 0x80 : 0) : 0,
        },
        party,
      }),
    })
    // The original wrote the party's position and last script into the globals too.
    return files
  }

  /** Rolls up a party through the menus, for a new game without the pre-made six. */
  async createParty(): Promise<Member[]> {
    const { ALIGNMENTS, CLASSES_BY_RACE, createCharacter, qualifies, rollStats } = await import('./create.js')
    const { CLASSES, RACES } = await import('../formats/character.js')
    const random = this.random
    const types = await this.types()
    const members: Member[] = []
    while (members.length < 6) {
      const races = RACES.filter((r) => r !== 'monster')
      const start = await this.ui.menu(`${members.length} IN THE PARTY. ADD SOMEONE?`, [...races.map((r) => r.toUpperCase()), members.length > 0 ? 'THE PARTY IS COMPLETE' : 'USE THE PRE-MADE PARTY'], 'vertical')
      const race = races[start]
      if (!race) break
      let stats = rollStats(race, random)
      for (;;) {
        const line = `STR ${stats.str}  INT ${stats.int}  WIS ${stats.wis}  DEX ${stats.dex}  CON ${stats.con}  CHA ${stats.cha}`
        const keep = await this.ui.menu(line, ['KEEP THESE', 'ROLL AGAIN'], 'horizontal')
        if (keep === 0) break
        stats = rollStats(race, random)
      }
      const allowed = (CLASSES_BY_RACE[race as keyof typeof CLASSES_BY_RACE] ?? []).filter((i) => qualifies(i, stats))
      if (allowed.length === 0) {
        this.ui.print('THOSE DICE ALLOW NO CLASS FOR THAT RACE. ROLL AGAIN.', true)
        continue
      }
      const classIndex = allowed[await this.ui.menu('CLASS:', allowed.map((i) => CLASSES[i]!.toUpperCase()), 'vertical')]!
      const sex = (await this.ui.menu('SEX:', ['MALE', 'FEMALE'], 'horizontal')) as 0 | 1
      const alignment = await this.ui.menu('ALIGNMENT:', [...ALIGNMENTS], 'vertical')
      this.ui.print('NAME?', true)
      const name = (await this.ui.inputString()).trim() || `HERO ${members.length + 1}`
      const character = createCharacter({ name, race, classIndex, sex, alignment, stats }, random)
      recompute(character, [], types)
      const member: Member = { character, items: [] }
      members.push(member)
      this.ui.print(await this.sheetOf(member), true)
      await this.ui.menu(undefined, ['PRESS <RETURN> OR BUTTON TO CONTINUE'], 'horizontal')
    }
    return members
  }

  /** The sheet's equipment menu: ready or put down each thing carried. */
  async equip(index: number): Promise<void> {
    const member = this.roster.members[index]
    if (!member || this.running) return
    const names = await this.names()
    const types = await this.types()
    if (types.length === 0) {
      this.ui.print('THE ITEMS TABLE IS MISSING FROM THE FOLDER, SO NOTHING CAN BE READIED.', true)
      return
    }
    for (;;) {
      const options = member.items.map((item) => `${item.readied ? 'PUT DOWN' : 'READY'} ${itemDisplayName(item, names)}`)
      const choice = await this.ui.menu(`${member.character.name}: AC ${member.character.ac}`, [...options, 'DONE'], 'vertical')
      if (choice >= options.length) break
      const item = member.items[choice]!
      if (item.readied) unready(member.character, member.items, choice, types)
      else if (!readyItem(member.character, member.items, choice, types)) this.ui.print('THAT CANNOT BE READIED.', true)
      this.ui.party(this.roster.members, this.roster.selected)
    }
    this.ui.print(await this.sheet(index), true)
  }

  /** What is on the ground: share the coins, pick up the items, or walk away. */
  private async takeTreasure(): Promise<void> {
    if (poolIsEmpty(this.pool)) return
    const names = await this.names()
    for (;;) {
      const coins = describeCoins(this.pool.coins)
      const items = this.pool.items.map((item) => `TAKE ${itemDisplayName(item, names)}`)
      const options = [...(coins ? [`SHARE ${coins}`] : []), ...items, 'LEAVE THE REST']
      const choice = await this.ui.menu('ON THE GROUND:', options, 'vertical')
      if (choice === options.length - 1) return
      if (coins && choice === 0) {
        shareCoins(this.pool, this.roster.active.length > 0 ? this.roster.active : this.roster.members)
      } else {
        const index = coins ? choice - 1 : choice
        const who = await this.ui.who('WHO TAKES IT?', this.roster.members)
        const member = this.roster.members[who]
        if (member) take(this.pool, index, member)
      }
      this.ui.party(this.roster.members, this.roster.selected)
      if (poolIsEmpty(this.pool)) return
    }
  }

  /** A shop sells what the script put on the shelf and buys the party's things for half. */
  private async shop(): Promise<void> {
    const names = await this.names()
    const shelf = [...this.pool.items]
    this.pool.items = []
    for (;;) {
      const choice = await this.ui.menu('THE SHOP.', ['BUY', 'SELL', 'LEAVE'], 'horizontal')
      if (choice === 2) return
      if (choice === 0) {
        if (shelf.length === 0) {
          this.ui.print('THERE IS NOTHING FOR SALE.', true)
          continue
        }
        const pick = await this.ui.menu('FOR SALE:', [...shelf.map((item) => `${itemDisplayName(item, names)} — ${item.value} GOLD`), 'NOTHING'], 'vertical')
        const item = shelf[pick]
        if (!item) continue
        const who = await this.ui.who('WHO BUYS IT?', this.roster.members)
        const member = this.roster.members[who]
        if (!member) continue
        this.ui.print(buy(member, item) ? `${member.character.name} BUYS THE ${itemDisplayName(item, names).toUpperCase()}.` : `${member.character.name} CANNOT AFFORD IT.`, true)
      } else {
        const who = await this.ui.who('WHO SELLS?', this.roster.members)
        const member = this.roster.members[who]
        if (!member || member.items.length === 0) continue
        const pick = await this.ui.menu('SELL WHAT?', [...member.items.map((item) => `${itemDisplayName(item, names)} — ${Math.floor(item.value / 2)} GOLD`), 'NOTHING'], 'vertical')
        if (pick >= member.items.length) continue
        const price = sell(member, pick)
        this.ui.print(`THE SHOPKEEPER PAYS ${price} GOLD.`, true)
      }
      this.ui.party(this.roster.members, this.roster.selected)
    }
  }

  /** A member's sheet, for the page to show on request. */
  async sheet(index: number): Promise<string> {
    const member = this.roster.members[index]
    return member ? this.sheetOf(member) : ''
  }

  private async sheetOf(member: Member): Promise<string> {
    const names = await this.names()
    const c = member.character
    const lines = [
      `${c.name}  ${['MALE', 'FEMALE'][c.sex] ?? ''}  ${raceName(c).toUpperCase()}  ${className(c).toUpperCase()}`,
      `LEVEL ${characterLevel(c)}   EXP ${c.experience}   AGE ${c.age}`,
      `STR ${c.stats.str}${c.stats.strPercent ? `/${c.stats.strPercent}` : ''}  INT ${c.stats.int}  WIS ${c.stats.wis}  DEX ${c.stats.dex}  CON ${c.stats.con}  CHA ${c.stats.cha}`,
      `HP ${c.hpCurrent}/${c.hpMax}   AC ${c.ac}   THAC0 ${c.thac0}   MOVE ${c.movement}   ${c.status.toUpperCase()}`,
      `${describeCoins(c.money) || 'NO COINS'}`,
      ...member.items.map((item) => `${item.readied ? '* ' : '  '}${itemDisplayName(item, names)}`),
    ]
    if (canCast(c)) {
      const spells = await Promise.all(c.memorised.map((id) => this.spellName(id)))
      lines.push(`SPELLS: ${spells.length > 0 ? spells.join(', ').toUpperCase() : 'NONE MEMORISED'}`)
    }
    return lines.join('\n')
  }

  private spellNames: string[] = []

  private async spellName(id: number): Promise<string> {
    if (this.spellNames.length === 0) this.spellNames = await this.library.spellNames()
    return this.spellNames[id] ?? spellById(id)?.name ?? `SPELL ${id}`
  }

  /** Camp: choose what each caster will have after a rest. */
  private async memoriseMenu(): Promise<void> {
    const casters = this.roster.members.filter((m) => canCast(m.character))
    if (casters.length === 0) {
      this.ui.print('NOBODY HERE CASTS SPELLS.', true)
      return
    }
    const who = await this.ui.menu('MEMORISE FOR:', [...casters.map((m) => m.character.name), 'DONE'], 'vertical')
    const member = casters[who]
    if (!member) return
    const c = member.character
    const how = await this.ui.menu(`${c.name}: ${c.prepared.length} PREPARED.`, ['CHOOSE EACH', 'AUTOMATIC', 'BACK'], 'horizontal')
    if (how === 1) {
      autoPrepare(c)
      this.ui.print(`${c.name} PREPARES ${(await Promise.all(c.prepared.map((id) => this.spellName(id)))).join(', ').toUpperCase()}.`, true)
      return
    }
    if (how !== 0) return
    const chosen: number[] = []
    for (const casterClass of ['cleric', 'magic-user'] as const) {
      const perLevel = slots(c, casterClass)
      for (let level = 1; level <= perLevel.length; level++) {
        const known = knownAt(c, casterClass, level)
        for (let slot = 0; slot < (perLevel[level - 1] ?? 0) && known.length > 0; slot++) {
          const names = await Promise.all(known.map((id) => this.spellName(id)))
          const pick = await this.ui.menu(`${casterClass.toUpperCase()} LEVEL ${level}, SLOT ${slot + 1}:`, [...names, 'LEAVE EMPTY'], 'vertical')
          if (pick < known.length) chosen.push(known[pick]!)
        }
      }
    }
    memorise(c, chosen)
    this.ui.print(`${c.name} WILL MEMORISE ${chosen.length} SPELL${chosen.length === 1 ? '' : 'S'} ON RESTING.`, true)
  }

  /** Camp: cast something that works outside a fight, a cure mostly. */
  private async castOutside(): Promise<void> {
    const casters = this.roster.members.filter((m) => ready(m.character).some((s) => s.anytime))
    if (casters.length === 0) {
      this.ui.print('NOBODY HAS A SPELL READY THAT HELPS HERE.', true)
      return
    }
    const who = await this.ui.menu('WHO CASTS?', [...casters.map((m) => m.character.name), 'NOBODY'], 'vertical')
    const member = casters[who]
    if (!member) return
    const usable = ready(member.character).filter((s) => s.anytime)
    const pick = await this.ui.menu('CAST:', [...usable.map((s) => s.name.toUpperCase()), 'NOTHING'], 'vertical')
    const spell = usable[pick]
    if (!spell) return
    const target = await this.ui.who('ON WHOM?', this.roster.members)
    const onto = this.roster.members[target]
    if (!onto) return
    forget(member.character, spell.id)
    const { lines } = cast(spell, member.character, [onto.character], this.random)
    this.ui.print(lines.join('\n'), true)
    this.ui.party(this.roster.members, this.roster.selected)
  }

  /** Camp: drink a potion. */
  private async useOutside(): Promise<void> {
    await this.names()
    const carriers = this.roster.members.filter((m) => this.usableItems(m).length > 0)
    if (carriers.length === 0) {
      this.ui.print('NOBODY CARRIES ANYTHING TO USE HERE.', true)
      return
    }
    const who = await this.ui.menu('WHO USES SOMETHING?', [...carriers.map((m) => m.character.name), 'NOBODY'], 'vertical')
    const member = carriers[who]
    if (!member) return
    const usable = this.usableItems(member)
    const pick = await this.ui.menu('USE:', [...usable.map((u) => u.label.toUpperCase()), 'NOTHING'], 'vertical')
    const choice = usable[pick]
    if (!choice) return
    const target = await this.ui.who('ON WHOM?', this.roster.members)
    const onto = this.roster.members[target]
    if (!onto) return
    this.ui.print((await this.useItem(member, choice, [onto.character])).join('\n'), true)
  }

  /** In a fight: a potion for a friend or a wand at a foe. */
  async useInCombat(combat: Combat, fighter: Fighter): Promise<string[]> {
    await this.names()
    const member = fighter.combatant.member
    const usable = this.usableItems(member)
    if (usable.length === 0) return ['NOTHING TO USE.']
    const pick = await this.ui.menu('USE:', [...usable.map((u) => u.label.toUpperCase()), 'NOTHING'], 'vertical')
    const choice = usable[pick]
    if (!choice) return []
    const atFoes = choice.label.toUpperCase().includes('WAND')
    const candidates = atFoes ? combat.monstersStanding : combat.party
    const at = await this.ui.menu(atFoes ? 'AT WHOM?' : 'ON WHOM?', [...candidates.map((c) => c.label), 'NOBODY'], 'vertical')
    const target = candidates[at]
    if (!target) return []
    combat.acted.add(member.character)
    return this.useItem(member, choice, [target.member.character], combat)
  }

  /** A round's casting: any caster with something ready may use it before blows fall. */
  private async castInCombat(combat: Combat): Promise<string[]> {
    const random = this.random
    const casters = combat.party.filter((c) => c.member.character.status === 'okay' && !combat.acted.has(c.member.character) && ready(c.member.character).length > 0)
    if (casters.length === 0) return ['NOBODY HAS A SPELL READY.']
    const who = await this.ui.menu('WHO CASTS?', [...casters.map((c) => c.label), 'NOBODY'], 'vertical')
    const caster = casters[who]
    if (!caster) return []
    const usable = ready(caster.member.character)
    const pick = await this.ui.menu('CAST:', [...usable.map((s) => s.name.toUpperCase()), 'NOTHING'], 'vertical')
    const spell = usable[pick]
    if (!spell) return []

    let targets: Character[] = []
    switch (spell.target) {
      case 'self': targets = [caster.member.character]; break
      case 'party': targets = combat.party.map((c) => c.member.character); break
      case 'ally': {
        const at = await this.ui.menu('ON WHOM?', [...combat.party.map((c) => c.label), 'NOBODY'], 'vertical')
        const ally = combat.party[at]
        if (!ally) return []
        targets = [ally.member.character]
        break
      }
      case 'foe': {
        const foes = combat.monstersStanding
        const at = await this.ui.menu('AT WHOM?', [...foes.map((c) => c.label), 'NOBODY'], 'vertical')
        const foe = foes[at]
        if (!foe) return []
        targets = [foe.member.character]
        break
      }
      case 'foes':
        targets = combat.monstersStanding.slice(0, spell.effect.count ?? 99).map((c) => c.member.character)
        break
    }
    forget(caster.member.character, spell.id)
    combat.acted.add(caster.member.character)
    const { lines } = cast(spell, caster.member.character, targets, random, combat)
    this.ui.party(this.roster.members, this.roster.selected)
    return lines
  }

  /** The game is won: the closing pictures, then the word. */
  private async ending(): Promise<void> {
    const archive = await this.library.archive('FINAL5.DAX')
    const { decodeAnyImage } = await import('../formats/image.js')
    const pictures = (archive?.blocks ?? []).map((b) => decodeAnyImage(b.data, 'FINAL5.DAX')?.frames[0]).filter((f): f is Rgba => f !== undefined)
    for (const [i, picture] of pictures.entries()) {
      this.ui.picture(picture)
      this.ui.print(i === 0 ? 'THE POOL OF RADIANCE IS NO MORE. PHLAN IS FREE.' : '', true)
      await this.ui.menu(undefined, ['PRESS <RETURN> OR BUTTON TO CONTINUE'], 'horizontal')
    }
    this.ui.print('YOU HAVE WON. THANK YOU FOR PLAYING.', true)
    await this.ui.menu(undefined, ['PRESS <RETURN> OR BUTTON TO CONTINUE'], 'horizontal')
    this.ui.picture(undefined)
  }

  /** A temple heals the wounded for gold, one hit point a coin, the way clerics charge. */
  private async temple(): Promise<void> {
    for (;;) {
      const hurt = this.roster.members.filter((m) => m.character.hpCurrent < m.character.hpMax || m.character.status !== 'okay')
      const gold = this.roster.members.reduce((n, m) => n + (m.character.money[3] ?? 0), 0)
      const choice = await this.ui.menu(`THE TEMPLE. YOU HAVE ${gold} GOLD.`, ['HEAL THE PARTY', 'LEAVE'], 'vertical')
      if (choice !== 0) return
      if (hurt.length === 0) {
        this.ui.print('NOBODY NEEDS HEALING.', true)
        continue
      }
      let paid = 0
      for (const { character } of hurt) {
        const need = character.hpMax - character.hpCurrent
        const payer = this.roster.members.find((m) => (m.character.money[3] ?? 0) >= need)
        if (!payer) continue
        payer.character.money[3]! -= need
        character.hpCurrent = character.hpMax
        if (character.status !== 'dead') {
          character.status = 'okay'
          character.statusByte = 0
        }
        paid += need
      }
      this.ui.print(paid > 0 ? `THE CLERICS TEND YOUR WOUNDS FOR ${paid} GOLD.` : 'YOU CANNOT PAY.', true)
      this.ui.party(this.roster.members, this.roster.selected)
    }
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
        session.ui.showParty(session.party)
      },
      setFacing(facing) {
        session.party = { ...session.party, facing: DIRECTIONS[facing & 3] as Direction }
        session.positionSetByScript = true
        session.ui.showParty(session.party)
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
        // The original moved without looking at walls and wrapped at the edges: that
        // wrap is how a party leaving one area arrives at the far side of the next.
        const next = stepFrom(session.party.row, session.party.col, session.party.facing)
        session.party = { ...session.party, row: (next.row + 16) & 0x0f, col: (next.col + 16) & 0x0f }
        session.positionSetByScript = true
        session.ui.showParty(session.party)
      },
    }
  }

  private host(): EclHost {
    const ui = this.ui
    return {
      random: (max) => this.random(max),
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
      spriteOff: () => ui.spriteOff(),
      loadMonster: () => ui.monsters(this.vm.monsters),
      clearMonsters: () => ui.monsters([]),
      combat: (groups) => this.fight(groups),
      parlay: () => ui.parlay(),
      who: (prompt) => ui.who(prompt, this.roster.members),
      partyStrength: () => this.roster.strength(),
      partyMovement: () => this.roster.movement(),
      loadMap: async (id) => {
        // Outdoors the original loaded no map; the wilderness block stays under the party.
        if (this.overhead) return
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
        // 127 was the original's way of saying "block 0 of this area's file".
        const wanted = ids.map((id) => (id === 0x7f ? 0 : id))
        this.textures = (await this.library.wallSetFromIds(wanted, this.area)).textures
        this.levelDirty = true
        // Show the level now rather than when the script finishes: it may be about
        // to talk for a while, and the player should see where they are.
        this.showLevelNow()
      },
      call: async (id) => {
        switch (id) {
          case CALL_STEP_FORWARD: return
          case CALL_REDRAW: ui.showParty(this.party); return
          case CALL_SOUND: return
          case CALL_DUEL: {
            const index = await ui.who('WHO WILL FIGHT?', this.roster.members)
            this.champion = this.roster.members[index]
            return
          }
          default:
            if (CALL_WILD.has(id)) ui.showParty(this.party)
            else if (!CALL_QUIET.has(id)) ui.note(`CALL 0x${id.toString(16)} is not implemented`)
        }
      },
      program: async (id) => {
        if (id === 0) {
          await this.partyMenu()
          return
        }
        if (id === 9) {
          await this.campMenu()
          return
        }
        if (id === 8) {
          await this.ending()
          return
        }
        if (id === 3) ui.print('THE PARTY HAS BEEN KILLED.', true)
      },
      treasure: async (treasure) => {
        const add = [treasure.copper, treasure.silver, treasure.electrum, treasure.gold, treasure.platinum, treasure.gems, treasure.jewellery]
        for (let i = 0; i < add.length; i++) this.pool.coins[i] = (this.pool.coins[i] ?? 0) + add[i]!
        if (treasure.items < 0x80) {
          this.pool.items.push(...(await this.library.itemBlock(this.area, treasure.items)))
        } else if (treasure.items !== 0xff) {
          ui.note(`${treasure.items - 0x80} random items are not generated yet`)
        }
      },
      damage: (spec) => {
        const lines = this.roster.applyDamage(spec, this.random)
        for (const line of lines) ui.print(`\n${line}`, false)
        ui.party(this.roster.members, this.roster.selected)
      },
      log: (message) => ui.note(message),
      addNpc: async (id, morale) => {
        const npc = await this.library.monster(this.area, id)
        if (!npc || this.roster.members.length >= 8) return
        npc.character.control = (morale >> 1) + 0x80
        if (canCast(npc.character)) autoPrepare(npc.character)
        this.roster.members.push(npc)
        ui.print(`${npc.character.name} JOINS THE PARTY.`, false)
        ui.party(this.roster.members, this.roster.selected)
      },
      rob: (everyone, keepPercent, itemChance) => {
        const victims = everyone ? this.roster.members : [this.roster.current ?? this.roster.members[0]].filter((m): m is Member => m !== undefined)
        for (const line of this.roster.rob(victims, keepPercent, itemChance, this.random)) ui.print(`\n${line}`, false)
        ui.party(this.roster.members, this.roster.selected)
      },
      spellHolder: (id) => this.roster.spellHolder(id),
      checkParty: (kind, which) => this.roster.checkParty(kind, which),
    }
  }

  /** Where this wilderness script can send the party: every other script it names. */
  async travelOptions(): Promise<{ id: number; name: string }[]> {
    if (!this.program) return []
    const { mapName } = await import('../formats/detect.js')
    const ids = new Set<number>()
    for (const instruction of this.program.instructions.values()) {
      if (instruction.opcode === 0x20) {
        const target = instruction.operands[0]
        if (target && target.kind !== 'memory' && target.word !== this.blockId) ids.add(target.word & 0xff)
      }
    }
    return [...ids].map((id) => ({ id, name: mapName(this.library.game.id, id) }))
  }

  /**
   * Goes straight to another area's script, as arriving there would. The wilderness
   * scripts steer by overland coordinates whose map is not read yet; this is the way
   * across in the meantime.
   */
  async travelTo(id: number): Promise<void> {
    if (this.running) return
    await this.withScript(async () => {
      await this.loadScript(id)
      this.memory.write(POOL_ADDRESSES.inDungeon, 1)
      await this.runStart()
    })
  }

  /** Something from a pack: potions and wands, in or out of a fight. */
  usableItems(member: Member): { index: number; label: string; use: (targets: Character[], combat?: Combat) => string[] }[] {
    const random = this.random
    const names = this.itemNames
    const out: { index: number; label: string; use: (targets: Character[], combat?: Combat) => string[] }[] = []
    member.items.forEach((item, index) => {
      const label = itemDisplayName(item, names)
      const upper = label.toUpperCase()
      const heal = (dice: number, sides: number, bonus: number) => (targets: Character[]) => targets.map((t) => {
        let amount = bonus
        for (let i = 0; i < dice; i++) amount += random(sides - 1) + 1
        amount = Math.min(amount, t.hpMax - t.hpCurrent)
        t.hpCurrent += amount
        if (t.status === 'unconscious' && t.hpCurrent > 0) { t.status = 'okay'; t.statusByte = 0 }
        return `${t.name} DRINKS AND IS HEALED ${amount}.`
      })
      if (upper.includes('POTION') && upper.includes('EXTRA HEALING')) out.push({ index, label, use: heal(3, 8, 3) })
      else if (upper.includes('POTION') && upper.includes('HEALING')) out.push({ index, label, use: heal(2, 4, 2) })
      else if (upper.includes('WAND') && upper.includes('MAGIC MISSILE') && item.plus > 0) {
        out.push({ index, label: `${label} (${item.plus} CHARGES)`, use: (targets, combat) => {
          item.plus -= 1
          const spell = spellById(15)!
          return cast(spell, { ...member.character, levels: [0, 0, 0, 0, 0, 6, 0, 0] }, targets, random, combat).lines
        } })
      }
    })
    return out
  }

  /** Uses one thing on someone; consumes potions. Returns what happened. */
  async useItem(member: Member, choice: { index: number; use: (targets: Character[], combat?: Combat) => string[] }, targets: Character[], combat?: Combat): Promise<string[]> {
    const item = member.items[choice.index]
    const lines = choice.use(targets, combat)
    if (item && itemDisplayName(item, this.itemNames).toUpperCase().includes('POTION')) member.items.splice(choice.index, 1)
    this.ui.party(this.roster.members, this.roster.selected)
    return lines
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
