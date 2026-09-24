/**
 * The game as an MCP server over stdio, so an agent can play it: the same
 * headless driver the JSON-lines CLI wraps, one tool a command.
 *
 *   npm run mcp -- /path/to/game
 *
 * Point an MCP client at it with the folder as the argument. Every tool returns
 * the state as JSON text: where the party is, who is standing, what was printed
 * since the last call, and what the game is waiting for (`pending`), if anything.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { directorySource } from '../src/cli/node-source.js'
import { GameLibrary } from '../src/formats/library.js'
import { HeadlessGame } from '../src/headless/driver.js'
import type { MoveCommand, Snapshot } from '../src/engine/session.js'

const [folder] = process.argv.slice(2)
if (!folder) {
  console.error('usage: mcp-server <game-folder>')
  process.exit(2)
}

const library = new GameLibrary(await directorySource(folder))
const game = new HeadlessGame(library)
const kept = new Map<string, Snapshot>()

const server = new McpServer({ name: 'gold-box-web', version: '0.1.0' })

// One call at a time, in the order they came: the game is a single conversation.
let queue: Promise<unknown> = Promise.resolve()
const reply = (work: () => Promise<unknown> | unknown) => {
  const turn = queue.then(async () => {
    try {
      await work()
      return { content: [{ type: 'text' as const, text: JSON.stringify(game.state()) }] }
    } catch (e) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e instanceof Error ? e.message : String(e), ...game.state() }) }], isError: true }
    }
  })
  queue = turn.catch(() => {})
  return turn
}

server.registerTool('new_game', {
  description: 'Start a game: "new" begins on the dock with the pre-made party and the guide’s tour of Phlan; a letter loads that saved game (A and J ship with the game; others are saves in the folder).',
  inputSchema: { save: z.string().default('new') },
}, ({ save }) => reply(() => game.newGame(save)))

server.registerTool('state', {
  description: 'The state of the game: position, party, the lines printed since the last call, and what it is waiting for.',
  inputSchema: {},
}, () => reply(() => {}))

server.registerTool('move', {
  description: 'A step or a turn indoors. Outdoors the same commands ride: turns swing the compass an eighth.',
  inputSchema: { command: z.enum(['forward', 'back', 'left', 'right', 'turnLeft', 'turnRight', 'turnAround']) },
}, ({ command }) => reply(() => game.move(command as MoveCommand)))

server.registerTool('ride', {
  description: 'Outdoors: ride one square in a compass direction, 0 north, clockwise to 7 north-west. An hour passes a square.',
  inputSchema: { direction: z.number().int().min(0).max(7) },
}, ({ direction }) => reply(() => game.ride(direction)))

server.registerTool('choose', {
  description: 'Answer what the game is waiting for: a menu, a party member, a parlay stance — by index or by label; a number or a name as text.',
  inputSchema: { index: z.number().int().optional(), text: z.string().optional() },
}, ({ index, text }) => reply(() => game.reply(index !== undefined ? index : (text ?? ''))))

server.registerTool('camp', { description: 'Make camp: rest, memorise, cast, use, save, export a DOS save.', inputSchema: {} }, () => reply(() => game.camp()))
server.registerTool('search', { description: 'Toggle searching: slower going, and the square’s script runs at once.', inputSchema: {} }, () => reply(() => game.search()))
server.registerTool('look', { description: 'Look at the square: its script runs again with the looking bit set.', inputSchema: {} }, () => reply(() => game.look()))

server.registerTool('snapshot', {
  description: 'Keep the whole game under a name, to restore later.',
  inputSchema: { name: z.string().default('default') },
}, ({ name }) => reply(() => { kept.set(name, game.snapshot()) }))

server.registerTool('restore', {
  description: 'Bring back a kept game.',
  inputSchema: { name: z.string().default('default') },
}, ({ name }) => reply(async () => { const snap = kept.get(name); if (!snap) throw new Error(`nothing kept as ${name}`); await game.restore(snap) }))

server.registerTool('enter_level', {
  description: 'Testing: go straight to a level by its map number, as arriving there would.',
  inputSchema: { level: z.number().int(), area: z.number().int().optional() },
}, ({ level, area }) => reply(async () => { const ref = await library.levelById(level, area); if (!ref) throw new Error('no such level'); await game.enter(ref) }))

server.registerTool('sheet', {
  description: 'A party member’s sheet as data: numbers, the pack (index, label, readied), spells memorised and prepared.',
  inputSchema: { member: z.number().int().min(0) },
}, async ({ member }) => {
  try { return { content: [{ type: 'text' as const, text: JSON.stringify(await game.sheet(member)) }] } }
  catch (e) { return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }], isError: true } }
})

server.registerTool('toggle_item', {
  description: 'Ready an item in a member’s pack, or put it down, by its index in the sheet.',
  inputSchema: { member: z.number().int().min(0), item: z.number().int().min(0) },
}, ({ member, item }) => reply(async () => { const problem = await game.toggleItem(member, item); if (problem) throw new Error(problem) }))

server.registerTool('spell_choices', {
  description: 'What a caster may prepare: for each class and spell level, the slots and the spells known (ids and names), and what is chosen now.',
  inputSchema: { member: z.number().int().min(0) },
}, async ({ member }) => {
  try { return { content: [{ type: 'text' as const, text: JSON.stringify(await game.spellChoices(member)) }] } }
  catch (e) { return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }], isError: true } }
})

server.registerTool('prepare', {
  description: 'What a caster will have after the next rest: spell ids, one per slot to fill (repeat an id to prepare it twice).',
  inputSchema: { member: z.number().int().min(0), ids: z.array(z.number().int()) },
}, ({ member, ids }) => reply(() => game.setPrepared(member, ids)))

server.registerTool('battle_mode', {
  description: 'How fights are played: quick (the computer fights) or auto (the grid battle, each turn by the computer’s tactics).',
  inputSchema: { mode: z.enum(['quick', 'auto']) },
}, ({ mode }) => reply(() => { game.battleMode = mode }))

await server.connect(new StdioServerTransport())
