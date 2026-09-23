/**
 * The game as a JSON-lines conversation: one command a line on stdin, one state
 * a line on stdout. Anything can drive it at any speed — a script, a test, a
 * person with a terminal.
 *
 *   npm run headless -- /path/to/game
 *
 * Commands (JSON objects):
 *   {"cmd":"new","save":"A"}         start from a saved game letter (A and J ship with the game)
 *   {"cmd":"state"}                  the state, with everything printed since the last state
 *   {"cmd":"move","dir":"forward"}   forward | back | left | right | turnLeft | turnRight | turnAround
 *   {"cmd":"ride","dir":0}           outdoors: 0 north, clockwise to 7 north-west
 *   {"cmd":"choose","index":0}       answer a menu, a party-member prompt or a parlay by index (or "text": by label)
 *   {"cmd":"answer","text":"..."}    answer a number or a name
 *   {"cmd":"camp"} {"cmd":"search"} {"cmd":"look"}
 *   {"cmd":"snapshot"}               keeps the game in memory; {"cmd":"restore"} brings it back
 *   {"cmd":"enter","level":20,"area":2}   testing: straight to a level
 *   {"cmd":"battle","mode":"quick"}  quick (the computer fights) or auto (the grid, played by the computer)
 *   {"cmd":"quit"}
 */

import { createInterface } from 'node:readline'
import { directorySource } from '../src/cli/node-source.js'
import { GameLibrary } from '../src/formats/library.js'
import { HeadlessGame } from '../src/headless/driver.js'
import type { MoveCommand, Snapshot } from '../src/engine/session.js'

const [folder] = process.argv.slice(2)
if (!folder) {
  console.error('usage: headless <game-folder>')
  process.exit(2)
}

const library = new GameLibrary(await directorySource(folder))
const game = new HeadlessGame(library)
let kept: Snapshot | undefined

const out = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n')

async function handle(line: string): Promise<void> {
  let command: Record<string, unknown>
  try { command = JSON.parse(line) as Record<string, unknown> } catch { out({ error: 'not JSON' }); return }
  try {
    switch (command.cmd) {
      case 'new': await game.newGame(String(command.save ?? 'A')); break
      case 'state': break
      case 'move': await game.move(String(command.dir) as MoveCommand); break
      case 'ride': await game.ride(Number(command.dir)); break
      case 'choose': await game.reply(command.index !== undefined ? Number(command.index) : String(command.text)); break
      case 'answer': await game.reply(String(command.text ?? command.index ?? '')); break
      case 'camp': await game.camp(); break
      case 'search': await game.search(); break
      case 'look': await game.look(); break
      case 'snapshot': kept = game.snapshot(); break
      case 'restore': if (kept) await game.restore(kept); else throw new Error('nothing kept'); break
      case 'enter': {
        const ref = await library.levelById(Number(command.level), command.area === undefined ? undefined : Number(command.area))
        if (!ref) throw new Error('no such level')
        await game.enter(ref)
        break
      }
      case 'battle': game.battleMode = command.mode === 'auto' ? 'auto' : 'quick'; break
      case 'quit': process.exit(0)
      default: throw new Error(`unknown command ${String(command.cmd)}`)
    }
    out(game.state())
  } catch (e) {
    out({ error: e instanceof Error ? e.message : String(e), ...game.state() })
  }
}

const lines = createInterface({ input: process.stdin })
let chain = Promise.resolve()
lines.on('line', (line) => { if (line.trim()) chain = chain.then(() => handle(line)) })
lines.on('close', () => { void chain.then(() => process.exit(0)) })
