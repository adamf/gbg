/**
 * Headless soak: loads every level, runs its scripts with a host that answers every
 * menu at random, and walks the party about. Anything a script trips over is printed.
 * Development only; needs a game folder.
 *
 *   npx tsx scripts/soak.ts /path/to/POOLRAD [steps-per-level] [seed]
 */

import { directorySource } from '../src/cli/node-source.js'
import { GameLibrary } from '../src/formats/library.js'
import { GameSession, type SessionUi } from '../src/engine/session.js'

const [folder, stepsArg, seedArg] = process.argv.slice(2)
if (!folder) {
  console.error('usage: soak <game-folder> [steps] [seed]')
  process.exit(2)
}
const STEPS = Number(stepsArg ?? 40)
let seed = Number(seedArg ?? 1)
const random = (max: number): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed % (max + 1)
}

const notes: string[] = []
const ui: SessionUi = {
  showLevel: () => {},
  showParty: () => {},
  print: () => {},
  newLine: () => {},
  menu: async (_prompt, items) => random(items.length - 1),
  inputNumber: async () => 1,
  inputString: async () => 'SOAK',
  delay: async () => {},
  picture: () => {},
  encounter: () => {},
  spriteOff: () => {},
  monsters: () => {},
  combatRound: async () => (['fight', 'cast', 'run'] as const)[random(2)]!,
  party: () => {},
  who: async (_prompt, members) => random(Math.max(0, members.length - 1)),
  parlay: async () => random(4),
  battleMode: async () => 'quick',
  battleUpdate: async () => {},
  battleTurn: async () => 'done',
  battleEnd: () => {},
  saved: () => {},
  note: (message) => { notes.push(message) },
}

const library = new GameLibrary(await directorySource(folder))
console.log(`${library.game.title}: soaking ${STEPS} steps per level`)
const saved = await library.savedGame('A')
const levels = await library.levels()
const commands = ['forward', 'forward', 'forward', 'turnLeft', 'turnRight', 'left', 'right', 'back'] as const

for (const ref of levels) {
  notes.length = 0
  const session = new GameSession(library, ui)
  if (saved) {
    session.restore(saved)
    session.roster.members = await library.party(saved)
  }
  const started = Date.now()
  let error: string | undefined
  try {
    await withTimeout(session.enterLevel(ref), 20_000, 'enterLevel')
    for (let i = 0; i < STEPS; i++) {
      await withTimeout(session.move(commands[random(commands.length - 1)]!), 20_000, `step ${i}`)
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const unique = [...new Set(notes)]
  const status = error ? `ERROR ${error}` : 'ok'
  console.log(`${ref.name.padEnd(36)} ${status}  ${Date.now() - started}ms${unique.length ? `\n    ${unique.join('\n    ')}` : ''}`)
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} hung for ${ms}ms`)), ms)),
  ])
}
