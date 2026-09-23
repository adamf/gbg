/**
 * The game without a page: a session whose prompts queue up for a caller to
 * answer, and whose state is a plain object. The JSON-lines CLI and the MCP
 * server are thin skins over this; a test can drive it the same way.
 *
 * Every action returns as soon as it is done or as soon as the game needs an
 * answer — a menu, a number, a name, a party member — which `state()` reports as
 * `pending`. The caller answers with `choose` or `answer` and the action goes on.
 */

import type { GameLibrary, LevelRef } from '../formats/library.js'
import { GameSession, type MoveCommand, type SessionUi, type Snapshot } from '../engine/session.js'
import type { Member } from '../engine/roster.js'
import type { Battle, Fighter } from '../engine/battle.js'
import type { Rgba } from '../formats/ega.js'

export type Pending =
  | { kind: 'menu'; prompt: string; items: string[] }
  | { kind: 'number'; prompt: string }
  | { kind: 'string'; prompt: string; maxLength: number }
  | { kind: 'who'; prompt: string; items: string[] }
  | { kind: 'parlay'; prompt: string; items: string[] }

export interface HeadlessState {
  started: boolean
  busy: boolean
  script: number
  map: number | undefined
  area: number
  outdoors: boolean
  party: { row: number; col: number; facing: string }
  overland: { x: number; y: number; worldX: number; facing: number }
  time: { hour: number; minute: number }
  searching: boolean
  members: { name: string; class: string; level: number; hp: number; hpMax: number; ac: number; status: string; gold: number }[]
  /** Everything printed since the last state call. */
  lines: string[]
  pending: Pending | undefined
  /** Set once the ending has been shown. */
  won: boolean
}

const PARLAY = ['HAUGHTY', 'SLY', 'MEEK', 'NICE', 'ABUSIVE']

export class HeadlessGame {
  session: GameSession | undefined
  private lines: string[] = []
  private pending: Pending | undefined
  private answer: ((value: number | string) => void) | undefined
  private promptSeen: (() => void) | undefined
  private running: Promise<void> | undefined
  private won = false
  /** 'quick': the computer fights; 'auto': the grid battle, each turn played by the computer's tactics. */
  battleMode: 'quick' | 'auto' = 'quick'

  constructor(readonly library: GameLibrary) {}

  private wait<T extends number | string>(pending: Pending): Promise<T> {
    this.pending = pending
    return new Promise<T>((resolve) => {
      this.answer = (value) => { this.pending = undefined; this.answer = undefined; resolve(value as T) }
      this.promptSeen?.()
    })
  }

  private ui(): SessionUi {
    const game = this
    return {
      showLevel: () => {},
      showParty: () => {},
      print: (text) => { if (text.trim()) game.lines.push(text.trim()); if (text.includes('TYRANTHRAXUS HAS FINALLY BEEN DEFEATED')) game.won = true },
      newLine: () => {},
      menu: (prompt, items) => game.wait<number>({ kind: 'menu', prompt: prompt ?? '', items: [...items] }),
      inputNumber: () => game.wait<number>({ kind: 'number', prompt: game.lines[game.lines.length - 1] ?? '' }),
      inputString: (maxLength) => game.wait<string>({ kind: 'string', prompt: game.lines[game.lines.length - 1] ?? '', maxLength: maxLength ?? 15 }),
      delay: async () => {},
      picture: () => {},
      encounter: () => {},
      spriteOff: () => {},
      monsters: () => {},
      combatRound: async () => 'fight',
      battleMode: async () => (game.battleMode === 'quick' ? 'quick' : 'tactical'),
      battleArt: () => {},
      battleUpdate: async (_battle: Battle, lines: readonly string[]) => { game.lines.push(...lines.filter((l) => l.trim())) },
      battleTurn: async (battle: Battle, fighter: Fighter) => {
        game.lines.push(...battle.autoTurn(fighter))
        return battle.combat.round > 60 ? 'run' : 'done'
      },
      battleEnd: () => {},
      party: () => {},
      who: (prompt, members: readonly Member[]) => game.wait<number>({ kind: 'who', prompt, items: members.map((m) => m.character.name) }),
      saved: () => {},
      files: () => {},
      combat: async () => 'won',
      parlay: () => game.wait<number>({ kind: 'parlay', prompt: 'PARLAY:', items: [...PARLAY] }),
      note: (message) => { game.lines.push(`(note: ${message})`) },
    }
  }

  /** Starts from a shipped or exported saved game: A and J ship with the game. */
  async newGame(letter = 'A'): Promise<void> {
    const saved = await this.library.savedGame(letter)
    if (!saved) throw new Error(`no saved game ${letter}`)
    this.session = new GameSession(this.library, this.ui())
    await this.run(() => this.session!.resume(saved))
  }

  /**
   * Runs an action until it finishes or the game asks something. A second action
   * while one is waiting for an answer is refused: answer first.
   */
  private async run(action: () => Promise<unknown>): Promise<void> {
    if (this.pending) throw new Error('the game is waiting for an answer')
    if (this.running) throw new Error('an action is still running')
    const done = (async () => { await action() })().finally(() => { this.running = undefined })
    this.running = done
    const asked = new Promise<void>((resolve) => { this.promptSeen = resolve })
    await Promise.race([done, asked])
    this.promptSeen = undefined
  }

  /** Answers a pending prompt by index or text, then lets the action go on until the next one. */
  async reply(value: number | string): Promise<void> {
    if (!this.pending || !this.answer) throw new Error('nothing is waiting for an answer')
    const running = this.running
    const asked = new Promise<void>((resolve) => { this.promptSeen = resolve })
    if (this.pending.kind === 'string') this.answer(String(value))
    else {
      const index = typeof value === 'number' ? value : this.pending.kind === 'number' ? Number(value) : this.pending.items.findIndex((i) => i.toUpperCase() === String(value).toUpperCase())
      if (!Number.isFinite(index) || index < 0) throw new Error(`no such choice: ${value}`)
      this.answer(index)
    }
    await Promise.race([running ?? Promise.resolve(), asked])
    this.promptSeen = undefined
  }

  private need(): GameSession {
    if (!this.session) throw new Error('no game started')
    return this.session
  }

  move(command: MoveCommand): Promise<void> { return this.run(() => this.need().move(command)) }
  /** Outdoors: 0 north, clockwise to 7 north-west. */
  ride(direction: number): Promise<void> { return this.run(() => this.need().moveOverland(direction)) }
  camp(): Promise<void> { return this.run(() => this.need().camp()) }
  search(): Promise<void> { return this.run(() => this.need().toggleSearch()) }
  look(): Promise<void> { return this.run(() => this.need().look()) }
  /** For testing: straight to a level, as arriving there would. */
  enter(ref: LevelRef): Promise<void> { return this.run(() => this.need().enterLevel(ref)) }
  snapshot(): Snapshot { return this.need().snapshot() }
  restore(snapshot: Snapshot): Promise<void> { return this.run(() => this.need().load(snapshot)) }

  state(): HeadlessState {
    const s = this.session
    const lines = this.lines.splice(0)
    if (!s) return { started: false, busy: false, script: 0, map: undefined, area: 0, outdoors: false, party: { row: 0, col: 0, facing: 'north' }, overland: { x: 0, y: 0, worldX: 0, facing: 0 }, time: { hour: 0, minute: 0 }, searching: false, members: [], lines, pending: this.pending, won: this.won }
    return {
      started: true,
      busy: s.busy,
      script: s.scriptId,
      map: s.map?.id,
      area: s.areaId,
      outdoors: s.overhead,
      party: { ...s.party },
      overland: s.overlandPosition,
      time: s.time,
      searching: s.searching,
      members: s.roster.members.map((m) => ({
        name: m.character.name,
        class: classLabel(m.character.class),
        level: Math.max(...m.character.levels),
        hp: m.character.hpCurrent,
        hpMax: m.character.hpMax,
        ac: m.character.ac,
        status: m.character.status,
        gold: m.character.money[3] ?? 0,
      })),
      lines,
      pending: this.pending,
      won: this.won,
    }
  }
}

function classLabel(id: number): string {
  return CLASS_NAMES[id] ?? `class ${id}`
}
const CLASS_NAMES: Record<number, string> = {
  0: 'Cleric', 1: 'Druid', 2: 'Fighter', 3: 'Paladin', 4: 'Ranger', 5: 'Magic User', 6: 'Thief', 7: 'Monk',
  8: 'Cleric/Fighter', 9: 'Cleric/Fighter/Magic User', 10: 'Cleric/Ranger', 11: 'Cleric/Magic User', 12: 'Cleric/Thief',
  13: 'Fighter/Magic User', 14: 'Fighter/Thief', 15: 'Fighter/Magic User/Thief', 16: 'Magic User/Thief',
}

export type { Rgba }
