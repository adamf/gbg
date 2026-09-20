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
import { blankRgba, type Rgba } from './ega.js'
import { detectGame, mapName, type GameInfo } from './detect.js'
import { readGeoMap, type GeoMap } from './geo.js'
import { decodeImageBlock, isImageBlock } from './image.js'
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
    const blocks = await this.locateWallDefBlocks(ids)

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
  private async locateWallDefBlocks(ids: readonly number[]): Promise<{ file: string; blockId: number }[]> {
    const found: { file: string; blockId: number }[] = []
    for (const id of ids) {
      for (const file of this.wallDefFiles()) {
        const archive = await this.archive(file)
        if (archive?.blocks.some((b) => b.id === id)) {
          found.push({ file, blockId: id })
          break
        }
      }
    }
    return found
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
