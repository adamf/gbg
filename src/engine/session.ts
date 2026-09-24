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
import { OVERLAND_STEPS, tileAt, windowColumn, type OverlandMap } from '../formats/overland.js'
import { startingCell, startingFacing } from './dungeon.js'
import {
  CALL_DUEL, CALL_PLANT, CALL_QUIET, CALL_SPAR, CALL_REDRAW, CALL_SOUND, CALL_STEP_FORWARD, CALL_TERRAIN, EclMemory, EclVm, MAPPED, POOL_ADDRESSES,
  type CombatOutcome, type EclHost, type EncounterView, type MonsterGroup, type VmWorld,
} from './ecl-vm.js'
import { backward, forward, strafeLeft, strafeRight, turnAround, turnLeft, turnRight, type PartyState } from './party.js'
import { Roster, type Member } from './roster.js'
import { characterLevel, className, raceName, type Character, type Item } from '../formats/character.js'
export type { Spell }
import { Combat, labelMonsters, type Combatant } from './combat.js'
import { Battle, type Fighter } from './battle.js'
import { randomItems } from './loot.js'
import { missileFor, SPRITE } from './sprites.js'
import { refit } from './burden.js'
import { buy, describeCoins, emptyPool, poolIsEmpty, sell, shareCoins, take, type Pool, worth } from './treasure.js'
import { itemDisplayName } from '../formats/items.js'
import { spellById, type Spell, type SpellTarget } from '../formats/spells.js'
import { canReadScroll, canScribe, isScroll, readFromScroll, scribe, scrollReader, scrollSpells } from './scrolls.js'
import { autoPrepare, canCast, cast, forget, knownAt, memorise, ready, refresh, slots } from './casting.js'
import { readyToTrain, train, TRAINING_COST } from './training.js'
import { ready as readyItem, recompute, slotOf, unready } from './equipment.js'
import type { ItemType } from '../formats/items.js'
import { writeCharacter, writeItems, writeSavedGame } from '../formats/save-writer.js'
import { SAVED_GAME_EXTRA, SAVED_GAME_GLOBALS, SAVED_GAME_SCRATCH } from '../formats/library.js'
import { goldOf, pay, poolOnto } from './treasure.js'

/** A character's sheet as data. */
export interface SheetData {
  name: string
  title: string
  level: number
  experience: number
  age: number
  stats: [string, string][]
  hp: number
  hpMax: number
  ac: number
  thac0: number
  movement: number
  status: string
  coins: string
  items: { label: string; readied: boolean; wearable: boolean }[]
  spells: string[]
  prepared: string[]
  caster: boolean
}
/** One class and level of a caster's book: how many slots, what is known, what is chosen. */
export interface SpellChoice {
  casterClass: 'cleric' | 'magic-user'
  level: number
  slots: number
  known: { id: number; name: string }[]
  chosen: number[]
}

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
  inputString(maxLength?: number): Promise<string>
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
  battleArt(tiles: readonly Rgba[], decorations: readonly Rgba[], outdoors: boolean, sprites: ReadonlyMap<number, readonly Rgba[]>): void
  /** Shows the battle after something happened; `lines` say what. */
  battleUpdate(battle: Battle, lines: readonly string[]): Promise<void>
  /**
   * The player's turn: the page moves the fighter and strikes; `cast` runs a spell
   * for them. Returns 'run' if the party tries to flee, otherwise when the turn ends.
   */
  battleTurn(battle: Battle, fighter: Fighter, cast: () => Promise<string[]>, use: () => Promise<string[]>): Promise<'done' | 'run'>
  /** A page with an inventory panel readies and puts down by clicking; the session's toggleItem does the work. */
  equip?(index: number): Promise<void>
  /** A page with a memorisation panel chooses what a caster prepares; the session's spellChoices and setPrepared do the work. */
  memorise?(index: number): Promise<void>
  /**
   * A page that can point at the grid answers this instead of a menu: for an area
   * spell, the fighters under the blast at the square chosen; otherwise up to `count`
   * of the fighters `among`, picked one by one. Nothing when the player thinks better of it.
   */
  aim?(battle: Battle, caster: Fighter, spell: Spell, choice: { kind: 'area' } | { kind: 'fighters'; among: readonly Fighter[]; count: number }): Promise<Fighter[] | undefined>
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
const RAISE_DEAD_COST = 1000

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
  /** The area number: which ECL, GEO, PIC and SPRIT files are current. */
  get areaId(): number { return this.area }

  map: GeoMap | undefined
  mapRef: LevelRef | undefined
  textures: readonly Rgba[] = []
  party: PartyState = { row: 0, col: 0, facing: 'north' }

  private levelDirty = false
  private positionSetByScript = false
  /** True only when a level was picked from the list: the party has nowhere to stand yet. */
  private needsPlacement = false
  private running = false
  /** The eight-point compass outdoors; see VmWorld.compass. */
  private compass = 0
  /** Set by a duel CALL: the next fight is this member alone. */
  private champion: Member | undefined
  /** The monsters of the last fight, for the result words the scripts read. */
  private lastMonsters: Combatant[] = []
  /** Set by the arena master: the next COMBAT is a sparring bout, not to the death. */
  private sparring = false
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
    this.memory.write(POOL_ADDRESSES.gameArea, this.area)
  }

  /**
   * Starts where a saved game left off: its last script, at its last position. A new
   * game is this with the saved game the original shipped.
   */
  async resume(saved: SavedGame, members?: Member[]): Promise<void> {
    this.restore(saved)
    this.roster.members = members ?? await this.library.party(saved)
    await this.armRanges()
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
    this.memory.write(POOL_ADDRESSES.currentMap, ref.id)
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

  /**
   * The record's attack has no reach in it: a readied bow, sling or handful of darts
   * gives the character their range from the type table, so the party can shoot.
   */
  private async armRanges(): Promise<void> {
    const types = await this.types()
    for (const member of this.roster.members) refit(member.character, member.items, types)
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
    this.memory.write(POOL_ADDRESSES.gameArea, this.area)
    // Arriving at a level is arriving indoors: the scripts that hand over from the wilderness say so themselves.
    this.memory.write(POOL_ADDRESSES.inDungeon, 1)

    // Loaded here, before the script, so a script that never says LOAD FILES still
    // leaves the player standing somewhere.
    this.map = await this.library.level(ref)
    this.mapRef = ref
    this.memory.write(POOL_ADDRESSES.currentMap, ref.id)
    this.textures = (await this.library.wallSetFor(ref)).textures
    this.levelDirty = true
    this.needsPlacement = true

    await this.withScript(async () => {
      await this.loadScript(blockId)
      await this.runStart()
    })
  }

  /** Picks up a saved snapshot: the same script, map and party as when it was taken. */
  async load(snapshot: Snapshot): Promise<void> {
    this.memory.restore(snapshot.memory)
    // Copies again, so the snapshot can be loaded more than once.
    this.roster.members = snapshot.members.map((m) => ({ character: structuredClone(m.character), items: structuredClone(m.items) }))
    this.pool = structuredClone(snapshot.pool ?? emptyPool())
    await this.armRanges()
    this.area = snapshot.area
    this.memory.write(POOL_ADDRESSES.gameArea, this.area)
    this.party = snapshot.party
    this.positionSetByScript = true
    const ref = await this.library.levelById(snapshot.mapId, this.area)
    if (!ref) {
      this.ui.note(`the saved map ${snapshot.mapId} is not in the folder`)
      return
    }
    this.map = await this.library.level(ref)
    this.mapRef = ref
    this.memory.write(POOL_ADDRESSES.currentMap, ref.id)
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
      // Copies, so the snapshot stays as it was while the game goes on.
      members: this.roster.members.map((m) => ({ character: structuredClone(m.character), items: structuredClone(m.items) })),
      pool: structuredClone(this.pool),
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
        // The fee is the trainee's, but the party may pool for them here rather than
        // walk back to camp to do it.
        const purse = this.roster.members.reduce((n, m) => n + goldOf(m), 0)
        if (purse < TRAINING_COST) { this.ui.print(`${member.character.name} CANNOT PAY.`, true); continue }
        const pool = await this.ui.menu(`${member.character.name} CANNOT PAY ALONE. POOL THE PARTY'S COINS?`, ['YES', 'NO'], 'horizontal')
        if (pool !== 0) continue
        poolOnto(this.roster.members, member)
        if (!pay(member, TRAINING_COST)) { this.ui.print(`${member.character.name} CANNOT PAY.`, true); continue }
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
        this.ui.showParty(this.party)
        const choice = await this.ui.menu(`CAMP. ${state}`,
          ['REST', 'MEMORISE', 'CAST', 'USE', 'POOL COINS', 'SAVE GAME', 'EXPORT DOS SAVE B', 'SCRIBE', 'LEAVE CAMP'], 'vertical')
        if (choice === 4) {
          const who = await this.ui.who('POOL ON WHOM?', this.roster.members)
          const onto = this.roster.members[who]
          if (onto) { poolOnto(this.roster.members, onto); this.ui.print(`${onto.character.name} HOLDS THE PARTY'S COINS.`, true); this.ui.party(this.roster.members, this.roster.selected) }
          continue
        }
        if (choice === 0) {
          if (await this.rest()) return
        } else if (choice === 1) {
          await this.memoriseMenu()
        } else if (choice === 2) {
          await this.castOutside()
        } else if (choice === 3) {
          await this.useOutside()
        } else if (choice === 5) {
          this.ui.saved()
        } else if (choice === 6) {
          this.ui.files(await this.dosSave('B'))
          this.ui.print('SAVGAMB.DAT AND THE CHRDATB FILES ARE READY. PUT THEM IN THE GAME FOLDER AND LOAD GAME B.', true)
        } else if (choice === 7) {
          await this.scribeMenu()
        } else {
          return
        }
      }
    }
  }

  /** One night's rest: a hit point back for each, unless something interrupts. Returns true if it did. */
  /**
   * How long the party needs: a day for every hit point the worst-hurt member is
   * short (the manual: a point a day of uninterrupted rest), or the time to memorise
   * — a quarter hour a spell level after four hours' relaxation — whichever is more.
   */
  private restHours(): number {
    let hours = 0
    for (const { character } of this.roster.members) {
      if (character.status === 'dead' || character.status === 'gone') continue
      hours = Math.max(hours, 24 * (character.hpMax - Math.max(0, character.hpCurrent)))
      const levels = character.prepared.reduce((n, id) => n + (spellById(id)?.level ?? 1), 0)
      if (character.prepared.length > character.memorised.length) hours = Math.max(hours, 4 + Math.ceil(levels / 4))
    }
    // Nobody hurt and nothing to memorise: a night's sleep, which is how the party
    // waits for the town's doors to open in the morning.
    return Math.max(hours > 0 ? 1 : 8, Math.min(hours, 24 * 14))
  }

  private async rest(): Promise<boolean> {
    const period = Math.max(1, this.memory.read(POOL_ADDRESSES.restPeriod) || HOURS_PER_REST)
    const chance = this.memory.read(POOL_ADDRESSES.restChance)
    const hours = this.restHours()
    let slept = 0
    for (let hour = 0; hour < hours; hour++) {
      slept++
      this.advanceTime(60)
      if ((hour + 1) % period === 0 && chance > 0 && this.random(99) < chance) {
        // The nights already slept still count before whatever wandered in arrives.
        this.heal(slept)
        this.ui.print('THE PARTY IS DISTURBED!', true)
        await this.runEntry(this.program!.entryPoints.campInterrupted)
        return true
      }
    }
    const days = this.heal(slept)
    this.ui.print(`THE PARTY RESTS ${days > 0 ? `${days} DAY${days === 1 ? '' : 'S'}` : `${slept} HOUR${slept === 1 ? '' : 'S'}`}. SPELLS ARE MEMORISED.`, true)
    this.ui.party(this.roster.members, this.roster.selected)
    return false
  }

  /** What a rest of so many hours does: the downed come round, a point a day, spells back. Returns the days. */
  private heal(slept: number): number {
    const days = Math.floor(slept / 24)
    for (const { character } of this.roster.members) {
      if (character.status === 'unconscious' || character.status === 'dying') {
        character.status = 'okay'
        character.statusByte = 0
        character.hpCurrent = Math.max(0, character.hpCurrent)
      }
      if (character.status === 'okay') character.hpCurrent = Math.min(character.hpMax, character.hpCurrent + days)
      if (slept >= 4) refresh(character)
    }
    return days
  }

  /** Outdoors: the original showed the map from above and let the script do the walking. */
  get overhead(): boolean {
    return this.memory.read(POOL_ADDRESSES.inDungeon) === 0
  }

  /** The wilderness map as this game has changed it (scripts plant tiles); a copy of the folder's. */
  private overlandCopy?: OverlandMap
  async overland(): Promise<OverlandMap | undefined> {
    if (!this.overlandCopy) {
      const map = await this.library.overland()
      if (map) this.overlandCopy = { ...map, tiles: new Uint8Array(map.tiles) }
    }
    return this.overlandCopy
  }

  /** Where the party rides: the script's own square, the world column it maps to, and the compass point (0 north, clockwise). */
  get overlandPosition(): { x: number; y: number; worldX: number; facing: number } {
    const x = this.memory.read(POOL_ADDRESSES.overlandX)
    const y = this.memory.read(POOL_ADDRESSES.overlandY)
    return { x, y, worldX: x + windowColumn(this.blockId), facing: this.memory.read(MAPPED.facingRaw) & 7 }
  }

  /**
   * A step outdoors in one of the eight directions. The wilderness script's move
   * entry vets it — the terrain table, the window's edges, a hand-over to the next
   * script — and the step lands when it does not cancel; then the square's script
   * runs, as after any step. An hour passes a square. Returns false when refused.
   */
  async moveOverland(direction: number): Promise<boolean> {
    if (this.running || !this.program || !this.overhead) return false
    const step = OVERLAND_STEPS[direction & 7]!
    const script = this.blockId
    const before = this.overlandPosition
    this.memory.write(MAPPED.facingRaw, direction & 7)
    this.memory.write(POOL_ADDRESSES.moveCancelled, 0)
    let left = false
    await this.withScript(async () => { left = await this.runEntry(this.program!.entryPoints.vmRun) })
    if (left || this.blockId !== script || !this.overhead) { this.ui.showParty(this.party); return true }
    if (this.memory.read(POOL_ADDRESSES.moveCancelled) === 255) {
      this.memory.write(POOL_ADDRESSES.moveCancelled, 0)
      await this.withScript(async () => { await this.runEntry(this.program!.entryPoints.searchLocation) })
      this.ui.showParty(this.party)
      return false
    }
    this.memory.write(POOL_ADDRESSES.overlandX, before.x + step.dx)
    this.memory.write(POOL_ADDRESSES.overlandY, before.y + step.dy)
    this.advanceTime(60)
    this.ui.showParty(this.party)
    await this.withScript(async () => {
      if (await this.runEntry(this.program!.entryPoints.searchLocation)) return
      this.memory.write(POOL_ADDRESSES.lastEclBlock, this.blockId)
    })
    this.ui.showParty(this.party)
    return true
  }

  get searching(): boolean {
    return (this.memory.read(POOL_ADDRESSES.searchFlags) & 1) !== 0
  }

  /**
   * Searching: slower going, and the scripts show what a careful party finds. Turning
   * it on runs the square's script at once, as the original did (coab's 3D loop), so a
   * secret door where the party stands can be found without stepping off.
   */
  async toggleSearch(): Promise<void> {
    const flags = this.memory.read(POOL_ADDRESSES.searchFlags)
    this.memory.write(POOL_ADDRESSES.searchFlags, flags ^ 1)
    if ((flags & 1) === 0 && !this.running && this.program) await this.withScript(() => this.afterStep())
  }

  /** Looking: the square's script runs again with the looking bit set. */
  async look(): Promise<void> {
    if (this.running || !this.program) return
    const flags = this.memory.read(POOL_ADDRESSES.searchFlags)
    this.memory.write(POOL_ADDRESSES.searchFlags, flags | 2)
    await this.withScript(() => this.afterStep())
    this.memory.write(POOL_ADDRESSES.searchFlags, this.memory.read(POOL_ADDRESSES.searchFlags) & ~2)
  }

  /** The dungeon keys outdoors: turns swing the compass an eighth, steps ride that way. */
  private async ride(command: MoveCommand): Promise<boolean> {
    if (this.running) return false
    const facing = this.memory.read(MAPPED.facingRaw) & 7
    const turn = command === 'turnLeft' ? 7 : command === 'turnRight' ? 1 : command === 'turnAround' ? 4 : undefined
    if (turn !== undefined) {
      this.memory.write(MAPPED.facingRaw, (facing + turn) & 7)
      this.ui.showParty(this.party)
      return true
    }
    const offset = command === 'back' ? 4 : command === 'left' ? 6 : command === 'right' ? 2 : 0
    return this.moveOverland((facing + offset) & 7)
  }

  /** A movement key. Turns are free; steps run the script when they land. */
  async move(command: MoveCommand): Promise<boolean> {
    if (this.overhead) return this.ride(command)
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

    // The original's order (coab ovr003, the 3D loop): the script's per-step entry
    // runs first, from the square the party stands on, facing the way it means to
    // go; it may refuse the move (0x6DC9 = 255) or take the party elsewhere. Only
    // then does the party step, and the square it lands on is searched.
    const leaving = !result.moved && this.leavesMap(result.blocked)
    if (!result.moved && !leaving) return false
    this.memory.write(POOL_ADDRESSES.moveCancelled, 0)
    if (leaving) this.memory.write(POOL_ADDRESSES.triedToExit, 1)
    const script = this.blockId
    const was = { ...this.party }
    let left = false
    await this.withScript(async () => { left = await this.runEntry(this.program!.entryPoints.vmRun) })
    if (leaving) this.memory.write(POOL_ADDRESSES.triedToExit, 0)
    const refused = this.memory.read(POOL_ADDRESSES.moveCancelled) === 255
    const moved = this.party.row !== was.row || this.party.col !== was.col
    if (left || this.blockId !== script) return true
    if (refused || moved || !result.moved) {
      // Refused, or carried elsewhere by the script (stairs, a guard's shove): the
      // square the party now stands on is searched all the same — only NEW ECL
      // stops the original's step short of that (coab ovr003).
      await this.withScript(async () => { await this.runEntry(this.program!.entryPoints.searchLocation) })
      return true
    }

    this.party = result.state
    // A wilderness square is a long way; a searched dungeon square is slow going.
    this.advanceTime(this.overhead ? 60 : this.searching ? 10 : 1)
    await this.withScript(async () => {
      if (await this.runEntry(this.program!.entryPoints.searchLocation)) return
      this.memory.write(POOL_ADDRESSES.lastEclBlock, this.blockId)
    })
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
    this.memory.write(POOL_ADDRESSES.gameArea, this.area)

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
    // A script that reloads the map mid-walk (the training hall does) must not move
    // the party; only a level picked from the list needs a place to stand.
    if (this.needsPlacement && !this.positionSetByScript) {
      const cell = startingCell(this.map)
      this.party = { row: cell.row, col: cell.col, facing: startingFacing(this.map, cell) }
    }
    this.needsPlacement = false
    this.ui.showLevel(this.map, this.textures, this.mapRef?.name ?? `Map ${this.map.id}`)
    this.ui.showParty(this.party)
    this.levelDirty = false
  }

  // ---- combat ------------------------------------------------------------------

  /** Runs a fight against the groups LOAD MONSTER queued, a round at a time. */
  private async fight(groups: readonly MonsterGroup[]): Promise<CombatOutcome> {
    this.memory.write(POOL_ADDRESSES.combatResult, 0)
    if (groups.length === 0 && this.sparring) return this.spar()
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
      if (bow) { monster.character.attacks.range = types[bow.type]!.range; monster.character.attacks.missile = missileFor(bow.type) }
      if (canCast(monster.character)) autoPrepare(monster.character)
      loaded.push({ member: monster, count: group.count, picture: group.picture })
    }
    if (loaded.length === 0) return this.ui.combat(groups)
    const random = this.random
    const outcome = await this.fightLoaded(loaded, random)
    // The scripts test the result three ways: won is below 1, fled is exactly 129,
    // and a lost fight is above 128 — so a wipe must not land on 128 itself.
    // A rout — the last monsters ran rather than fell — is 1: the city watch's script
    // checks for exactly that, and the kill counters (`< 1`) leave it out.
    const routed = outcome === 'won' && this.lastMonsters.some((m) => m.member.character.status === 'running')
    this.memory.write(POOL_ADDRESSES.combatResult, outcome === 'won' ? (routed ? 1 : 0) : outcome === 'fled' ? 0x81 : 0xff)
    this.memory.write(POOL_ADDRESSES.monstersKilled, Math.min(255, this.lastMonsters.filter((m) => m.member.character.status === 'dead').length))
    return outcome
  }

  /**
   * The arena's duel: the chosen character against a copy of themselves, evenly
   * matched and not to the death. The original paid it as a hundred experience a level.
   */
  private async spar(): Promise<CombatOutcome> {
    this.sparring = false
    const member = this.roster.members[this.roster.selected]
    if (!member || member.character.status !== 'okay') {
      this.ui.print('THE ARENA MASTER SHAKES HIS HEAD: THAT ONE IS IN NO STATE TO DUEL.', true)
      return 'won'
    }
    const twin: Member = {
      character: { ...member.character, levels: [...member.character.levels], money: [0, 0, 0, 0, 0, 0, 0], memorised: [...member.character.memorised], prepared: [...member.character.prepared], attacks: { ...member.character.attacks }, control: 1, hpCurrent: member.character.hpMax, status: 'okay', statusByte: 0 },
      items: member.items.map((item) => ({ ...item })),
    }
    const before = member.character.experience
    this.champion = member
    const outcome = await this.fightLoaded([{ member: twin, count: 1, picture: -1 }], this.random)
    member.character.experience = before + (outcome === 'won' ? characterLevel(member.character) * 100 : 0)
    if (member.character.hpCurrent < 1) member.character.hpCurrent = 1
    if (member.character.status !== 'okay') { member.character.status = 'okay'; member.character.statusByte = 0 }
    this.ui.print(outcome === 'won' ? `${member.character.name} WINS THE BOUT.` : `${member.character.name} YIELDS.`, true)
    this.ui.party(this.roster.members, this.roster.selected)
    this.memory.write(POOL_ADDRESSES.combatResult, outcome === 'won' ? 0 : 0xff)
    return outcome
  }

  private async fightLoaded(loaded: { member: Member; count: number; picture: number }[], random: (max: number) => number): Promise<CombatOutcome> {

    const fighters = this.champion ? [this.champion] : this.roster.members
    this.champion = undefined
    const party: Combatant[] = fighters.map((member) => ({ member, label: member.character.name }))
    const monsters = labelMonsters(loaded)

    // Both modes fight on the grid, as the original did: QUICK is the same battle
    // with the computer playing the party. The abstract round-by-round fight is
    // only for a session with no map to fight on.
    const mode = await this.ui.battleMode(monsters)
    if (this.map) {
      for (const c of party) {
        c.icon = await this.library.partyIcon(c.member.character)
        c.actionIcon = await this.library.partyIcon(c.member.character, true)
      }
      const icons = new Map<number, [Rgba | undefined, Rgba | undefined]>()
      for (const c of monsters) {
        if (c.picture === undefined) continue
        if (!icons.has(c.picture)) icons.set(c.picture, [await this.library.combatIcon(this.area, c.picture), await this.library.combatIcon(this.area, c.picture, true)])
        ;[c.icon, c.actionIcon] = icons.get(c.picture)!
      }
      return this.tacticalFight(party, monsters, random, mode === 'quick')
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
      // Two sides that cannot hurt each other: the party breaks off before the log does.
      if (combat.round > 300) { outcome = 'fled'; break }
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
    this.lastMonsters = combat.monsters
    if (outcome !== 'fled') {
      const okay = combat.party.some((c) => c.member.character.status === 'okay')
      const ran = combat.party.some((c) => c.member.character.status === 'running')
      outcome = okay ? 'won' : ran ? 'fled' : 'lost'
    }
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
  private async tacticalFight(party: Combatant[], monsters: Combatant[], random: (max: number) => number, quick = false): Promise<CombatOutcome> {
    const battle = new Battle(this.map!, party, monsters, this.party, 1, random, this.overhead)
    battle.types = await this.types()
    const sprites = new Map<number, readonly Rgba[]>()
    for (const id of Object.values(SPRITE)) sprites.set(id, await this.library.combatSprite(id))
    this.ui.battleArt(await this.library.combatTiles(this.overhead), await this.library.randomTiles(), this.overhead, sprites)
    let outcome: CombatOutcome = 'won'
    await this.ui.battleUpdate(battle, [`${monsters.length} FOE${monsters.length === 1 ? '' : 'S'}: ${[...new Set(monsters.map((m) => m.member.character.name))].join(', ')}.`])

    while (!battle.over) {
      if (battle.roundLines.length > 0) {
        await this.ui.battleUpdate(battle, battle.roundLines.splice(0))
        this.ui.party(this.roster.members, this.roster.selected)
      }
      const fighter = battle.current
      if (!fighter) { battle.endTurn(); continue }
      if (fighter.side === 'monster' || quick) {
        // The computer's party breaks off a fight nobody can finish: two sides that
        // cannot reach each other, or a hundred rounds of it.
        if (quick && fighter.side === 'party' && (battle.stalled || battle.combat.round > 100)) { outcome = 'fled'; break }
        const lines = fighter.side === 'monster' ? battle.monsterTurn(fighter) : battle.autoTurn(fighter)
        await this.ui.battleUpdate(battle, lines)
        this.ui.party(this.roster.members, this.roster.selected)
        battle.endTurn()
        continue
      }
      const result = await this.ui.battleTurn(battle, fighter, async () => {
        const lines = await this.castInCombat(battle.combat, battle)
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
        // Quicker than the pursuit, or a fight in which nobody can reach anybody.
        const chase = Math.max(0, ...battle.combat.monstersStanding.map((m) => m.member.character.movement))
        if (battle.stalled || this.roster.movement().min + random(5) >= chase) { outcome = 'fled'; break }
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
    if (this.ui.equip) { await this.ui.equip(index); return }
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
      const choice = await this.ui.menu('THE SHOP.', ['BUY', 'SELL', 'APPRAISE', 'LEAVE'], 'horizontal')
      if (choice === 3) return
      if (choice === 2) {
        // Gems and jewellery are worth nothing until a shop names a price; the
        // original's prices are not known here, so a gem brings 50 to 500 gold and a
        // piece of jewellery 100 to 1000.
        const who = await this.ui.who('WHOSE?', this.roster.members)
        const member = this.roster.members[who]
        if (!member) continue
        const money = member.character.money
        let gold = 0
        for (; (money[5] ?? 0) > 0; money[5]!--) gold += 50 * (this.random(9) + 1)
        for (; (money[6] ?? 0) > 0; money[6]!--) gold += 100 * (this.random(9) + 1)
        money[3] = (money[3] ?? 0) + gold
        this.ui.print(gold > 0 ? `THE SHOPKEEPER OFFERS ${gold} GOLD FOR THE LOT, AND ${member.character.name} TAKES IT.` : 'NOTHING TO APPRAISE.', true)
        continue
      }
      if (choice === 0) {
        if (shelf.length === 0) {
          this.ui.print('THERE IS NOTHING FOR SALE.', true)
          continue
        }
        const pick = await this.ui.menu('FOR SALE:', [...shelf.map((item) => `${itemDisplayName(item, names)} — ${Math.max(1, item.value)} GOLD`), 'NOTHING'], 'vertical')
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
        const templates = await this.library.itemTemplates()
        const pick = await this.ui.menu('SELL WHAT?', [...member.items.map((item) => `${itemDisplayName(item, names)} — ${Math.max(1, Math.floor(worth(item, templates) / 2))} GOLD`), 'NOTHING'], 'vertical')
        if (pick >= member.items.length) continue
        if (member.items[pick]?.readied) unready(member.character, member.items, pick, await this.types())
        const price = sell(member, pick, templates)
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

  /** The sheet as data, for a page that lays it out itself. */
  async sheetData(index: number): Promise<SheetData | undefined> {
    const member = this.roster.members[index]
    if (!member) return undefined
    const names = await this.names()
    const types = await this.types()
    const c = member.character
    const spells = canCast(c) ? await Promise.all(c.memorised.map((id) => this.spellName(id))) : []
    const prepared = canCast(c) ? await Promise.all(c.prepared.map((id) => this.spellName(id))) : []
    return {
      name: c.name,
      title: `${['MALE', 'FEMALE'][c.sex] ?? ''} ${raceName(c).toUpperCase()} ${className(c).toUpperCase()}`.trim(),
      level: characterLevel(c),
      experience: c.experience,
      age: c.age,
      stats: [['STR', `${c.stats.str}${c.stats.strPercent ? `/${c.stats.strPercent}` : ''}`], ['INT', String(c.stats.int)], ['WIS', String(c.stats.wis)], ['DEX', String(c.stats.dex)], ['CON', String(c.stats.con)], ['CHA', String(c.stats.cha)]],
      hp: c.hpCurrent, hpMax: c.hpMax, ac: c.ac, thac0: c.thac0, movement: c.movement, status: c.status.toUpperCase(),
      coins: describeCoins(c.money) || 'NO COINS',
      items: member.items.map((item) => ({ label: itemDisplayName(item, names), readied: item.readied, wearable: slotOf(item, types) !== undefined })),
      spells: spells.map((n) => n.toUpperCase()),
      prepared: prepared.map((n) => n.toUpperCase()),
      caster: canCast(c),
    }
  }

  /** Readies an item or puts it down; the words when it cannot be. */
  async toggleItem(index: number, at: number): Promise<string | undefined> {
    const member = this.roster.members[index]
    const item = member?.items[at]
    if (!member || !item) return undefined
    const types = await this.types()
    if (types.length === 0) return 'THE ITEMS TABLE IS MISSING FROM THE FOLDER, SO NOTHING CAN BE READIED.'
    if (item.readied) unready(member.character, member.items, at, types)
    else if (!readyItem(member.character, member.items, at, types)) return 'THAT CANNOT BE READIED.'
    this.ui.party(this.roster.members, this.roster.selected)
    return undefined
  }

  /** What a caster may prepare: for each class and spell level, the slots and the spells known. */
  async spellChoices(index: number): Promise<SpellChoice[]> {
    const c = this.roster.members[index]?.character
    if (!c || !canCast(c)) return []
    const out: SpellChoice[] = []
    for (const casterClass of ['cleric', 'magic-user'] as const) {
      const perLevel = slots(c, casterClass)
      for (let level = 1; level <= perLevel.length; level++) {
        const count = perLevel[level - 1] ?? 0
        if (count === 0) continue
        const known = knownAt(c, casterClass, level)
        out.push({ casterClass, level, slots: count, known: await Promise.all(known.map(async (id) => ({ id, name: (await this.spellName(id)).toUpperCase() }))), chosen: c.prepared.filter((id) => known.includes(id)) })
      }
    }
    return out
  }

  /** What a caster will have after resting: the ids, as many as the slots allow. */
  async setPrepared(index: number, ids: readonly number[]): Promise<void> {
    const c = this.roster.members[index]?.character
    if (!c) return
    memorise(c, ids)
    this.ui.print(`${c.name} WILL MEMORISE ${c.prepared.length} SPELL${c.prepared.length === 1 ? '' : 'S'} ON RESTING.`, true)
    this.ui.party(this.roster.members, this.roster.selected)
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
    if (this.ui.memorise) { await this.ui.memorise(this.roster.members.indexOf(member)); return }
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
    const party = this.roster.members.map((m) => ({ member: m, label: m.character.name }))
    const targets = await this.chooseTargets(choice, party, [])
    if (!targets || targets.length === 0) return
    this.ui.print((await this.useItem(member, choice, targets)).join('\n'), true)
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
    const targets = await this.chooseTargets(choice, combat.party, combat.monstersStanding)
    if (!targets || targets.length === 0) return []
    combat.acted.add(member.character)
    return this.useItem(member, choice, targets, combat)
  }

  /** A round's casting: any caster with something ready may use it before blows fall. */
  private async castInCombat(combat: Combat, battle?: Battle): Promise<string[]> {
    const random = this.random
    // On the grid it is somebody's turn; in a quick fight anyone with a spell ready may.
    const current = battle?.current?.combatant
    const casters = combat.party.filter((c) => (current ? c === current : c.member.character.status === 'okay' && !combat.acted.has(c.member.character)) && ready(c.member.character).length > 0)
    if (casters.length === 0) return ['NOBODY HAS A SPELL READY.']
    const who = casters.length === 1 ? 0 : await this.ui.menu('WHO CASTS?', [...casters.map((c) => c.label), 'NOBODY'], 'vertical')
    const caster = casters[who]
    if (!caster) return []
    if (combat.has(caster.member.character, 'silence')) return [`${caster.label} IS SILENCED AND CANNOT CAST.`]
    const usable = ready(caster.member.character)
    const pick = await this.ui.menu('CAST:', [...usable.map((s) => s.name.toUpperCase()), 'NOTHING'], 'vertical')
    const spell = usable[pick]
    if (!spell) return []

    let targets: Character[] = []
    const from = battle?.fighterOf(caster.member.character)
    if (battle && from && (spell.area || spell.target === 'foe' || spell.target === 'ally' || spell.target === 'foes')) {
      // On the grid the spell lands somewhere: an area where it is aimed, everyone inside;
      // otherwise on fighters in range, picked on the map when the page can, from a list when not.
      let picked: Fighter[] | undefined
      if (spell.area) {
        picked = this.ui.aim ? await this.ui.aim(battle, from, spell, { kind: 'area' }) : battle.bestBlast(spell, from)?.targets
      } else {
        const own = spell.target === 'ally'
        const among = battle.fighters.filter((o) => (own ? o.side === from.side : o.side !== from.side) && ['okay', 'asleep', 'held'].includes(o.combatant.member.character.status) && battle.reaches(spell, from, o))
        if (among.length === 0) return [`NOBODY IS IN RANGE OF ${spell.name.toUpperCase()}.`]
        const count = spell.target === 'foes' ? Math.min(spell.effect.count ?? 99, among.length) : 1
        if (this.ui.aim) picked = await this.ui.aim(battle, from, spell, { kind: 'fighters', among, count })
        else if (count === 1) {
          const at = await this.ui.menu(own ? 'ON WHOM?' : 'AT WHOM?', [...among.map((o) => o.combatant.label), 'NOBODY'], 'vertical')
          picked = among[at] ? [among[at]!] : undefined
        } else picked = among.slice(0, count)
      }
      if (!picked || picked.length === 0) return []
      targets = picked.map((t) => t.combatant.member.character)
    } else switch (spell.target) {
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
    if (battle) {
      const from = battle.fighterOf(caster.member.character)
      if (from) battle.recordSpell(spell, from, targets.map((t) => battle.fighterOf(t)).filter((f): f is Fighter => f !== undefined))
    }
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
      const gold = this.roster.members.reduce((n, m) => n + goldOf(m), 0)
      // The stoned are raised the same way: the temple's stone to flesh is the same thousand.
      const dead = this.roster.members.filter((m) => m.character.status === 'dead' || m.character.status === 'stoned')
      const choice = await this.ui.menu(`THE TEMPLE. YOU HAVE ${gold} GOLD.`, ['HEAL THE PARTY', `RAISE DEAD — ${RAISE_DEAD_COST} GOLD`, 'LEAVE'], 'vertical')
      if (choice === 2) return
      if (choice === 1) {
        // Raise dead: the manual's constitution point comes off, and the raised come
        // back with a single hit point. The price is this program's, not the original's.
        if (dead.length === 0) { this.ui.print('NOBODY HERE NEEDS RAISING.', true); continue }
        const who = dead.length === 1 ? 0 : await this.ui.menu('RAISE WHOM?', dead.map((m) => m.character.name), 'vertical')
        const member = dead[who]
        if (!member) continue
        const payer = this.roster.members.find((m) => goldOf(m) >= RAISE_DEAD_COST)
        if (!payer || !pay(payer, RAISE_DEAD_COST)) { this.ui.print('YOU CANNOT PAY.', true); continue }
        member.character.status = 'okay'
        member.character.statusByte = 0
        member.character.hpCurrent = 1
        member.character.stats.con = Math.max(3, member.character.stats.con - 1)
        this.ui.print(`${member.character.name} LIVES AGAIN, A LITTLE THE WORSE FOR IT.`, true)
        this.ui.party(this.roster.members, this.roster.selected)
        continue
      }
      if (hurt.length === 0) {
        this.ui.print('NOBODY NEEDS HEALING.', true)
        continue
      }
      let paid = 0
      for (const { character } of hurt) {
        const need = character.hpMax - Math.max(0, character.hpCurrent)
        const payer = this.roster.members.find((m) => goldOf(m) >= need)
        if (!payer || !pay(payer, need)) continue
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

  get time(): { hour: number; minute: number; day: number } {
    return {
      day: this.memory.read(POOL_ADDRESSES.timeDay),
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
      get compass() {
        return session.overhead ? session.compass : DIRECTIONS.indexOf(session.party.facing) * 2
      },
      setCompass(compass) {
        session.compass = compass & 7
        // Indoors the same word is the facing doubled; keep the two in step.
        session.party = { ...session.party, facing: DIRECTIONS[(compass >> 1) & 3] as Direction }
        session.positionSetByScript = true
        session.ui.showParty(session.party)
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
      inputString: (maxLength) => ui.inputString(maxLength),
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
    this.memory.write(POOL_ADDRESSES.currentMap, ref.id)
        this.levelDirty = true
      },
      loadWallSets: async (ids) => {
        // 127 was the original's way of saying "block 0 of this area's file".
        const wanted = ids.map((id) => (id === 0x7f ? 0 : id))
        // What a DOS save must carry: the original reloads these from WALLDEF<area> on a load.
        const stored = ids[0] === 0x7f ? [0, 0xffff, 0xffff] : wanted
        stored.forEach((id, i) => this.memory.write(POOL_ADDRESSES.wallSets + i, id))
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
          case CALL_SPAR: this.sparring = true; return
          case CALL_DUEL: {
            const index = await ui.who('WHO WILL FIGHT?', this.roster.members)
            this.champion = this.roster.members[index]
            return
          }
          case CALL_TERRAIN: {
            const map = await this.overland()
            const x = this.memory.read(POOL_ADDRESSES.overlandWorkX) + windowColumn(this.blockId)
            const y = this.memory.read(POOL_ADDRESSES.overlandWorkY)
            // Off the map reads as nothing the scripts list, so the edge scripts' own checks decide.
            this.memory.write(POOL_ADDRESSES.overlandTerrain, map ? (tileAt(map, x, y) ?? 0) : 0)
            return
          }
          case CALL_PLANT: {
            const map = await this.overland()
            const x = this.memory.read(POOL_ADDRESSES.overlandWorkX) + windowColumn(this.blockId)
            const y = this.memory.read(POOL_ADDRESSES.overlandWorkY)
            if (map && tileAt(map, x, y) !== undefined) map.tiles[y * map.width + x] = this.memory.read(POOL_ADDRESSES.overlandPlant) & 0xff
            ui.showParty(this.party)
            return
          }
          default:
            if (!CALL_QUIET.has(id)) ui.note(`CALL 0x${id.toString(16)} is not implemented`)
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
          this.pool.items.push(...randomItems(treasure.items - 0x80, await this.library.itemTemplates(), this.random))
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
  usableItems(member: Member): Usable[] {
    const random = this.random
    const names = this.itemNames
    const out: Usable[] = []
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
        out.push({ index, label: `${label} (${item.plus} CHARGES)`, target: 'foe', use: (targets, combat) => {
          item.plus -= 1
          const spell = spellById(15)!
          return cast(spell, { ...member.character, levels: [0, 0, 0, 0, 0, 6, 0, 0] }, targets, random, combat).lines
        } })
      } else if (isScroll(item) && canReadScroll(member.character, item)) {
        // Each spell still on the scroll is read separately; reading it uses it up.
        for (const spell of scrollSpells(item)) {
          out.push({ index, label: `READ ${spell.name.toUpperCase()} FROM THE SCROLL`, target: spell.target, use: (targets, combat) => {
            readFromScroll(item, spell.id)
            return cast(spell, scrollReader(member.character, item), targets, random, combat).lines
          } })
        }
      }
    })
    return out
  }

  /** Reading a scroll: who it is read at, by the spell's own target. */
  private async chooseTargets(choice: Usable, party: Combatant[], foes: Combatant[]): Promise<Character[] | undefined> {
    const target = choice.target ?? 'ally'
    if (target === 'party') return party.map((c) => c.member.character)
    if (target === 'foes') return foes.map((c) => c.member.character)
    const atFoes = target === 'foe'
    const candidates = atFoes ? foes : party
    if (candidates.length === 0) return undefined
    const at = await this.ui.menu(atFoes ? 'AT WHOM?' : 'ON WHOM?', [...candidates.map((c) => c.label), 'NOBODY'], 'vertical')
    const chosen = candidates[at]
    return chosen ? [chosen.member.character] : undefined
  }

  /** At camp, a magic-user copies a scroll's spell into the book; the scroll loses it. */
  private async scribeMenu(): Promise<void> {
    await this.names()
    const choices: { member: Member; item: Item; spell: Spell }[] = []
    for (const member of this.roster.members) {
      for (const item of member.items) {
        if (!isScroll(item)) continue
        for (const spell of scrollSpells(item)) if (canScribe(member.character, spell)) choices.push({ member, item, spell })
      }
    }
    if (choices.length === 0) {
      this.ui.print('NO MAGIC-USER HERE CARRIES A SCROLL WITH A SPELL TO LEARN.', true)
      return
    }
    const pick = await this.ui.menu('SCRIBE:', [...choices.map((c) => `${c.member.character.name}: ${c.spell.name.toUpperCase()}`), 'NOTHING'], 'vertical')
    const chosen = choices[pick]
    if (!chosen) return
    scribe(chosen.member.character, chosen.item, chosen.spell)
    if (scrollSpells(chosen.item).length === 0) chosen.member.items.splice(chosen.member.items.indexOf(chosen.item), 1)
    this.ui.print(`${chosen.member.character.name} COPIES ${chosen.spell.name.toUpperCase()} INTO THE SPELLBOOK. THE SCROLL FADES.`, true)
    this.ui.party(this.roster.members, this.roster.selected)
  }

  /** Uses one thing on someone; consumes potions. Returns what happened. */
  async useItem(member: Member, choice: Usable, targets: Character[], combat?: Combat): Promise<string[]> {
    const item = member.items[choice.index]
    const lines = choice.use(targets, combat)
    const spent = item && (itemDisplayName(item, this.itemNames).toUpperCase().includes('POTION') || (isScroll(item) && scrollSpells(item).length === 0))
    if (spent) member.items.splice(choice.index, 1)
    this.ui.party(this.roster.members, this.roster.selected)
    return lines
  }
}

/** Something a member can use: a potion, a wand's charge, a spell on a scroll. */
interface Usable {
  index: number
  label: string
  /** Who it goes at, when the thing is a spell; potions go on a friend. */
  target?: SpellTarget
  use: (targets: Character[], combat?: Combat) => string[]
}

function stepFrom(row: number, col: number, facing: Direction): { row: number; col: number } {
  switch (facing) {
    case 'north': return { row: row - 1, col }
    case 'east': return { row, col: col + 1 }
    case 'south': return { row: row + 1, col }
    case 'west': return { row, col: col - 1 }
  }
}
