/**
 * Ties a folder of game files together: detects the game, finds the levels, and
 * assembles the wall graphics each level asks for.
 *
 * Everything goes through `FileSource`, so the same code runs against a directory
 * on disk (the CLI) and a folder the browser was handed (the web app). Nothing is
 * ever uploaded; the player's own files stay on the player's own machine.
 */

import { readDax, type DaxArchive } from './dax.js'
import { decodeEcl, memStartFor, summariseEvent, type EclProgram, type EventSummary } from './ecl.js'
import { blankRgba, recolour, type Rgba } from './ega.js'
import { readCharacter, readItems, type Character, type Item } from './character.js'
import { readItemNames, readItemTypes, type ItemType } from './items.js'
import { readSpellNames } from './spells.js'
import { detectGame, mapName, type GameInfo } from './detect.js'
import { readGeoMap, type GeoMap } from './geo.js'
import { decodeAnyImage, decodeImageBlock, isImageBlock, type DecodedImage } from './image.js'
import { readWallDefBlock, renderWallTexture, type WallDef } from './walldef.js'

export interface FileSource {
  /** Upper-cased base names of every file in the folder. */
  list(): readonly string[]
  /** Contents of one file, by upper-cased base name. */
  read(name: string): Promise<Uint8Array | undefined>
}

export interface LevelRef {
  /** GEO archive the level came from, e.g. "GEO1.DAX". */
  file: string
  /** DAX block id, which is the map number the scripts use. */
  id: number
  name: string
}

export interface LevelEvents {
  /** The decoded script the level runs. */
  program: EclProgram
  /** Event number to what that event says and does. */
  summaries: Map<number, EventSummary>
}

/**
 * A saved game's global state: what the scripts read and write between levels.
 *
 * The layout is the one the original wrote: one byte naming the area, then the
 * 2K of game globals, 2K of area and character scratch, and 1K more the scripts
 * also address. Pool of Radiance ships two of these — SAVGAMA.DAT and SAVGAMJ.DAT —
 * as the starting points of a new game with either pre-made party.
 */
export interface SavedGame {
  area: number
  globals: Uint8Array
  areaScratch: Uint8Array
  extra: Uint8Array
  /** Base names of the party's character files, e.g. "CHRDATA1". */
  party: string[]
}

export const SAVED_GAME_GLOBALS = 0x800
export const SAVED_GAME_SCRATCH = 0x800
export const SAVED_GAME_EXTRA = 0x400
/** Pool of Radiance keeps the script image after the blocks, then the party list. */
const SAVED_GAME_SCRIPT = 0x1e00
const SAVED_GAME_POSITION = 7
const SAVED_GAME_NAME_SLOT = 0x29

export function readSavedGame(data: Uint8Array): SavedGame | undefined {
  const needed = 1 + SAVED_GAME_GLOBALS + SAVED_GAME_SCRATCH + SAVED_GAME_EXTRA
  if (data.length < needed) return undefined
  let at = 1
  const take = (n: number): Uint8Array => {
    const slice = data.slice(at, at + n)
    at += n
    return slice
  }
  const saved: SavedGame = {
    area: data[0]!,
    globals: take(SAVED_GAME_GLOBALS),
    areaScratch: take(SAVED_GAME_SCRATCH),
    extra: take(SAVED_GAME_EXTRA),
    party: [],
  }

  // After the memory blocks: the script image, the position, then a count and up to
  // eight 41-byte slots each holding a length-prefixed file name.
  at += SAVED_GAME_SCRIPT + SAVED_GAME_POSITION
  const count = Math.min(8, data[at] ?? 0)
  at++
  for (let i = 0; i < count; i++) {
    const slot = at + i * SAVED_GAME_NAME_SLOT
    const length = data[slot] ?? 0
    if (slot + 1 + length > data.length || length === 0) break
    let name = ''
    for (let c = 0; c < length; c++) name += String.fromCharCode(data[slot + 1 + c]!)
    saved.party.push(name.trim().toUpperCase())
  }
  return saved
}

export interface WallSet {
  /** Textures for wall types 1..15, in order; index 0 of this array is wall type 1. */
  textures: Rgba[]
  /** Which WALLDEF blocks the textures came from. */
  sources: { file: string; blockId: number; wallCount: number }[]
}

/** A wall set is five walls; a WALLDEF block may hold up to three of them. */
const WALLSET_BYTES = 780
const UNIVERSAL_TILE_BLOCK = 203
const PLACEHOLDER_TILE = blankRgba(8, 8)

export class GameLibrary {
  private readonly archives = new Map<string, Promise<DaxArchive | undefined>>()
  private readonly wallSetCache = new Map<string, Promise<Rgba[]>>()
  private readonly eclCache = new Map<string, Promise<EclProgram[]>>()
  private names: Promise<string[]> | undefined
  private spellNameList: Promise<string[]> | undefined
  private types: Promise<ItemType[]> | undefined
  readonly game: GameInfo

  constructor(private readonly source: FileSource) {
    this.game = detectGame(source.list())
  }

  has(name: string): boolean {
    return this.source.list().includes(name.toUpperCase())
  }

  /** Parses and caches one DAX archive. */
  archive(name: string): Promise<DaxArchive | undefined> {
    const key = name.toUpperCase()
    let pending = this.archives.get(key)
    if (!pending) {
      pending = this.source.read(key).then((bytes) => (bytes ? readDax(key, bytes) : undefined))
      this.archives.set(key, pending)
    }
    return pending
  }

  /** Every GEO*.DAX in the folder. */
  geoFiles(): string[] {
    return this.source.list().filter((n) => /^GEO\d*\.DAX$/.test(n)).sort()
  }

  wallDefFiles(): string[] {
    return this.source.list().filter((n) => /^WALLDEF\d*\.DAX$/.test(n)).sort()
  }

  /** Every level in the folder, named where a name is known. */
  async levels(): Promise<LevelRef[]> {
    const levels: LevelRef[] = []
    for (const file of this.geoFiles()) {
      const archive = await this.archive(file)
      if (!archive) continue
      for (const block of archive.blocks) {
        if (block.data.length < 1026) continue
        levels.push({ file, id: block.id, name: mapName(this.game.id, block.id) })
      }
    }
    return levels
  }

  async level(ref: LevelRef): Promise<GeoMap | undefined> {
    const archive = await this.archive(ref.file)
    const block = archive?.blocks.find((b) => b.id === ref.id && b.data.length >= 1026)
    return block ? readGeoMap(block.id, block.data) : undefined
  }

  /**
   * The wall graphics a level loads.
   *
   * The level's ECL script names them, so this reads the script: opcode 0x21 loads a
   * map, opcode 0x37 loads three wall sets. Where the script cannot be read, it falls
   * back to the WALLDEF block whose id matches the map's.
   */
  async wallSetFor(ref: LevelRef): Promise<WallSet> {
    const ids = (await this.wallSetIdsFromEcl(ref)) ?? [ref.id]
    return this.wallSetFromIds(ids)
  }

  /** The wall graphics for a set of WALLDEF block ids, as a LOAD PIECES names them. */
  async wallSetFromIds(ids: readonly number[], area?: number): Promise<WallSet> {
    const blocks = await this.locateWallDefBlocks(ids.filter((id) => id !== 0xff), area)

    const textures: Rgba[] = []
    const sources: WallSet['sources'] = []
    for (const found of blocks) {
      const rendered = await this.renderWallDefBlock(found.file, found.blockId)
      sources.push({ file: found.file, blockId: found.blockId, wallCount: rendered.length })
      textures.push(...rendered)
    }

    return { textures, sources }
  }

  /** Renders every wall in one WALLDEF block to a flat texture. */
  renderWallDefBlock(file: string, blockId: number): Promise<Rgba[]> {
    const key = `${file}#${blockId}`
    let pending = this.wallSetCache.get(key)
    if (!pending) {
      pending = this.renderWallDefBlockUncached(file, blockId)
      this.wallSetCache.set(key, pending)
    }
    return pending
  }

  private async renderWallDefBlockUncached(file: string, blockId: number): Promise<Rgba[]> {
    const archive = await this.archive(file)
    const block = archive?.blocks.find((b) => b.id === blockId)
    if (!block) return []

    const walls: WallDef[] = readWallDefBlock(block.data)
    const tiles = await this.tileSetFor(file, blockId, block.data.length)
    return walls.map((wall) => renderWallTexture(wall, tiles))
  }

  /**
   * Builds the 8x8 tile list a wall set indexes into, reproducing the order the
   * original loader left in memory: a placeholder at 0, then the universal tiles,
   * then the tiles belonging to this wall set.
   */
  private async tileSetFor(wallDefFile: string, blockId: number, blockLength: number): Promise<Rgba[]> {
    const tileFile = wallDefFile.replace('WALLDEF', '8X8D')
    let tiles: Rgba[] = [PLACEHOLDER_TILE]

    const ownCount = await this.countTiles(tileFile, blockId)
    if (ownCount >= 255) {
      // Some games keep a whole 256-entry tile page in one block.
      if (ownCount === 256) tiles = []
      tiles.push(...(await this.tilesIn(tileFile, blockId)))
    } else {
      const universalFile = (await this.countTiles('8X8D1.DAX', UNIVERSAL_TILE_BLOCK)) > 0 ? '8X8D1.DAX' : '8X8D.DAX'
      tiles.push(...(await this.tilesIn(universalFile, UNIVERSAL_TILE_BLOCK)))

      const wallSetCount = Math.floor(blockLength / WALLSET_BYTES)
      if (wallSetCount >= 1) tiles.push(...(await this.tilesIn(tileFile, blockId)))

      if (tiles.length < 255 && wallSetCount > 1) {
        // Two or three wall sets in one block keep their tiles in sibling blocks.
        const base = blockId === 0 ? 100 : blockId * 10
        tiles.push(...(await this.tilesIn(tileFile, base + 1)))
        tiles.push(...(await this.tilesIn(tileFile, base + 2)))
        if (wallSetCount >= 3) tiles.push(...(await this.tilesIn(tileFile, base + 3)))
      }
    }

    tiles[0] = PLACEHOLDER_TILE
    return tiles
  }

  private async tilesIn(file: string, blockId: number): Promise<Rgba[]> {
    const archive = await this.archive(file)
    if (!archive) return []
    const frames: Rgba[] = []
    for (const block of archive.blocks) {
      if (block.id !== blockId || !isImageBlock(block.data)) continue
      frames.push(...decodeImageBlock(block.data, file).frames)
    }
    return frames
  }

  private async countTiles(file: string, blockId: number): Promise<number> {
    return (await this.tilesIn(file, blockId)).length
  }

  /** Finds which WALLDEF file holds each requested block id. */
  private async locateWallDefBlocks(ids: readonly number[], area?: number): Promise<{ file: string; blockId: number }[]> {
    const found: { file: string; blockId: number }[] = []
    const files = this.wallDefFiles()
    if (area !== undefined) {
      const own = `WALLDEF${area}.DAX`
      files.sort((a, b) => (a === own ? -1 : b === own ? 1 : 0))
    }
    for (const id of ids) {
      for (const file of files) {
        const archive = await this.archive(file)
        if (archive?.blocks.some((b) => b.id === id)) {
          found.push({ file, blockId: id })
          break
        }
      }
    }
    return found
  }

  /** A level by the map id the scripts use, looking in the given area's GEO file first. */
  async levelById(id: number, area?: number): Promise<LevelRef | undefined> {
    const files = this.geoFiles()
    if (area !== undefined) {
      const own = `GEO${area}.DAX`
      files.sort((a, b) => (a === own ? -1 : b === own ? 1 : 0))
    }
    for (const file of files) {
      const archive = await this.archive(file)
      const block = archive?.blocks.find((b) => b.id === id && b.data.length >= 1026)
      if (block) return { file, id, name: mapName(this.game.id, id) }
    }
    return undefined
  }

  /** The raw script block with a given id, and which area file it came from. */
  async eclBlock(id: number, area?: number): Promise<{ file: string; area: number; data: Uint8Array } | undefined> {
    const files = this.source.list().filter((n) => /^ECL\d*\.DAX$/.test(n)).sort()
    if (area !== undefined) {
      const own = `ECL${area}.DAX`
      files.sort((a, b) => (a === own ? -1 : b === own ? 1 : 0))
    }
    for (const file of files) {
      const archive = await this.archive(file)
      const block = archive?.blocks.find((b) => b.id === id)
      if (block) return { file, area: Number(file.match(/\d+/)?.[0] ?? 0), data: block.data }
    }
    return undefined
  }

  /** The first frame of a picture block in an area's PIC file, for the PICTURE command. */
  async picture(area: number, id: number): Promise<Rgba | undefined> {
    return (await this.artBlock(`PIC${area}.DAX`, id))?.frames[0]
  }

  /**
   * A monster group seen down the corridor: the area's SPRIT block, whose frames are
   * the group drawn at three distances, nearest first.
   */
  async sprite(area: number, id: number): Promise<DecodedImage | undefined> {
    return this.artBlock(`SPRIT${area}.DAX`, id)
  }

  /** A monster's combat icon: the area's CPIC block the script named. */
  async combatIcon(area: number, id: number): Promise<Rgba | undefined> {
    return (await this.artBlock(`CPIC${area}.DAX`, id))?.frames[0]
  }

  /** A party member's combat icon: their ICON block, recoloured in their colours. */
  async partyIcon(character: Character): Promise<Rgba | undefined> {
    const frame = (await this.artBlock('ICON.DAX', character.icon))?.frames[0]
      ?? (await this.artBlock('COMSPR.DAX', character.icon))?.frames[0]
    return frame ? recolour(frame, character.iconColours) : undefined
  }

  private async artBlock(file: string, id: number): Promise<DecodedImage | undefined> {
    const archive = await this.archive(file)
    for (const block of archive?.blocks ?? []) {
      if (block.id !== id) continue
      const decoded = decodeAnyImage(block.data, file)
      if (decoded) return decoded
    }
    return undefined
  }

  /** A character and their inventory, by the base name a saved game lists. */
  async character(baseName: string): Promise<{ character: Character; items: Item[] } | undefined> {
    const record = await this.source.read(`${baseName}.SAV`)
    if (!record) return undefined
    const inventory = await this.source.read(`${baseName}.ITM`)
    return { character: readCharacter(record), items: inventory ? readItems(inventory) : [] }
  }

  /**
   * A monster by record id: the area's MON*CHA.DAX holds character records, its
   * MON*ITM.DAX their gear, one block per monster.
   */
  /** The item name list, scanned from START.EXE; empty when the folder lacks it. */
  itemNames(): Promise<string[]> {
    this.names ??= this.source.read('START.EXE').then((exe) => (exe ? readItemNames(exe) : []))
    return this.names
  }

  /** The spell name list, scanned from START.EXE; empty when the folder lacks it. */
  spellNames(): Promise<string[]> {
    this.spellNameList ??= this.source.read('START.EXE').then((exe) => (exe ? readSpellNames(exe) : []))
    return this.spellNameList
  }

  /** The item type table from ITEMS. */
  itemTypes(): Promise<ItemType[]> {
    this.types ??= this.source.read('ITEMS').then((data) => (data ? readItemTypes(data) : []))
    return this.types
  }

  /** The items in one block of an area's ITEM file: a shop's stock, or a hoard. */
  async itemBlock(area: number, id: number): Promise<Item[]> {
    const archive = await this.archive(`ITEM${area}.DAX`)
    const block = archive?.blocks.find((b) => b.id === id)
    return block ? readItems(block.data) : []
  }

  async monster(area: number, id: number): Promise<{ character: Character; items: Item[] } | undefined> {
    const records = await this.archive(`MON${area}CHA.DAX`)
    const record = records?.blocks.find((b) => b.id === id && b.data.length >= 0x11d)
    if (!record) return undefined
    const gear = await this.archive(`MON${area}ITM.DAX`)
    const own = gear?.blocks.find((b) => b.id === id)
    return { character: readCharacter(record.data), items: own ? readItems(own.data) : [] }
  }

  /** Every member of a saved game's party that has a character file. */
  async party(saved: SavedGame): Promise<{ character: Character; items: Item[] }[]> {
    const members: { character: Character; items: Item[] }[] = []
    for (const name of saved.party) {
      const member = await this.character(name)
      if (member) members.push(member)
    }
    return members
  }

  /** The saved game a new game starts from: SAVGAMA.DAT, or whichever letter is asked for. */
  async savedGame(letter = 'A'): Promise<SavedGame | undefined> {
    const data = await this.source.read(`SAVGAM${letter.toUpperCase()}.DAT`)
    return data ? readSavedGame(data) : undefined
  }

  /** Every decoded script in one ECL archive. */
  eclPrograms(file: string): Promise<EclProgram[]> {
    const key = file.toUpperCase()
    let pending = this.eclCache.get(key)
    if (!pending) {
      pending = this.archive(key).then((archive) => {
        if (!archive) return []
        const memStart = memStartFor(this.game.id)
        return archive.blocks.map((block) => decodeEcl(block.id, block.data, memStart))
      })
      this.eclCache.set(key, pending)
    }
    return pending
  }

  /**
   * The script that runs a level.
   *
   * GEO1.DAX pairs with ECL1.DAX; within it, the script for this level is the block
   * whose LOAD FILES command names this map.
   */
  async eclForLevel(ref: LevelRef): Promise<EclProgram | undefined> {
    const suffix = ref.file.match(/^GEO(\d*)\.DAX$/)?.[1] ?? ''
    const programs = await this.eclPrograms(`ECL${suffix}.DAX`)
    return programs.find((program) => program.loadsMaps.includes(ref.id))
  }

  /**
   * What each event on the level does.
   *
   * A cell's event number indexes the script's event jump table. The summaries say
   * what an event can print and whether it can start a fight — what it *will* do
   * depends on game state this decoder does not have.
   */
  async eventsFor(ref: LevelRef): Promise<LevelEvents | undefined> {
    const program = await this.eclForLevel(ref)
    if (!program) return undefined

    const summaries = new Map<number, EventSummary>()
    for (let event = 0; event < program.events.length; event++) {
      const summary = summariseEvent(program, event)
      if (summary) summaries.set(event, summary)
    }
    return { program, summaries }
  }

  /** The wall set ids the level's script loads, if it can be found. */
  private async wallSetIdsFromEcl(ref: LevelRef): Promise<number[] | undefined> {
    const program = await this.eclForLevel(ref)
    return program?.loadsWallSets[0]
  }
}

/** A FileSource over an in-memory map, for tests and for the browser's file picker. */
export function memorySource(files: Map<string, Uint8Array>): FileSource {
  const upper = new Map<string, Uint8Array>()
  for (const [name, bytes] of files) upper.set(name.toUpperCase(), bytes)
  return {
    list: () => [...upper.keys()],
    read: async (name) => upper.get(name.toUpperCase()),
  }
}
