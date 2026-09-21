/**
 * An automated player: a new game with the pre-made party, thousands of steps of
 * exploring, menus answered by a simple policy, fights fought, camp when hurt. It
 * reports what breaks — exceptions, hangs, script notes — and what happened: areas
 * seen, fights, deaths, levels. Development only; needs a game folder.
 *
 *   npx tsx scripts/playthrough.ts /path/to/POOLRAD [steps] [seed]
 */

import { EIGHT_STEPS } from '../src/engine/battle.js'
import { directorySource } from '../src/cli/node-source.js'
import { GameLibrary } from '../src/formats/library.js'
import { GameSession, type SessionUi } from '../src/engine/session.js'

const [folder, stepsArg, seedArg] = process.argv.slice(2)
if (!folder) {
  console.error('usage: playthrough <game-folder> [steps] [seed]')
  process.exit(2)
}
const STEPS = Number(stepsArg ?? 2000)
let seed = Number(seedArg ?? 1)
const random = (max: number): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed % (max + 1)
}

const notes = new Map<string, number>()
const menuSeen = new Map<string, number>()
const texts: string[] = []
let menus = 0
let fights = 0
let wins = 0
let losses = 0
let raises = 0
let wantRest = false

const ui: SessionUi = {
  showLevel: () => {},
  showParty: () => {},
  print: (text) => {
    if (text.includes('EACH SURVIVOR GAINS')) wins++
    if (text.includes('THE PARTY HAS FALLEN')) losses++
    if (text.trim()) texts.push(text.trim().slice(0, 80))
  },
  newLine: () => {},
  menu: async (prompt, items) => {
    menus++
    const key = `${prompt ?? ''} | ${items.join(', ')}`.slice(0, 120)
    menuSeen.set(key, (menuSeen.get(key) ?? 0) + 1)
    if (menus > 200_000) throw new Error(`menu loop: ${key}`)
    const labels = items.map((i) => i.toUpperCase())
    const find = (word: string) => labels.findIndex((l) => l.includes(word))
    if (find('PRESS') >= 0) return find('PRESS')
    if (prompt?.startsWith('CAMP')) return wantRest && !prompt.includes('EVERYONE IS WELL') ? Math.max(0, find('REST')) : find('LEAVE')
    if (find('QUICK FIGHT') >= 0) { fights++; return find('QUICK FIGHT') }
    if (find('FIGHT') >= 0 && find('RUN') >= 0) return find('FIGHT')
    if (find('COMBAT') >= 0 && find('WAIT') >= 0) return random(9) < 7 ? find('COMBAT') : find('FLEE')
    if (find('SHARE') >= 0) return find('SHARE')
    if (find('LEAVE THE REST') >= 0) return find('LEAVE THE REST')
    if (find('LEAVE') >= 0 && labels.length <= 3 && find('NORTH') < 0) return find('LEAVE')
    return random(items.length - 1)
  },
  inputNumber: async () => 1,
  inputString: async () => 'BOT',
  delay: async () => {},
  picture: () => {},
  encounter: () => {},
  spriteOff: () => {},
  monsters: () => {},
  combatRound: async () => 'fight',
  battleMode: async () => { fights++; return fights % 2 === 0 ? 'tactical' : 'quick' },
  battleArt: () => {},
  battleUpdate: async (battle, lines) => {
    if (process.env.PLAY_DEBUG && battle.combat.round >= 44 && battle.combat.round <= 45) console.log(`  monsters: ${lines.join(' ') || 'nothing'}`)
    if (process.env.PLAY_DEBUG && lines[0]?.includes('FOE')) {
      // The arena as a picture: floor, rock, and who stands where.
      for (let y = 0; y < battle.height; y++) {
        let row = ''
        for (let x = 0; x < battle.width; x++) {
          const f = battle.at(x, y)
          row += f ? (f.side === 'party' ? 'P' : 'M') : battle.isSolid(x, y) ? '#' : '.'
        }
        console.log('  ' + row)
      }
    }
  },
  battleTurn: async (battle, fighter) => {
    const lines = battle.autoTurn(fighter)
    if (process.env.PLAY_DEBUG) console.log(`  round ${battle.combat.round} ${fighter.combatant.label} @${fighter.x},${fighter.y} moves ${fighter.moves}: ${lines.join(' ') || 'nothing'} | foes ${battle.fighters.filter((f) => f.side === 'monster').map((f) => `${f.combatant.label}@${f.x},${f.y} ${f.combatant.member.character.status}`).join(' ')}`)
    if (process.env.PLAY_DEBUG && battle.combat.round === 45) {
      const foes = battle.fighters.filter((f) => f.side === 'monster' && f.combatant.member.character.status === 'okay')
      const goal = foes.sort((a, b) => (Math.abs(a.x - fighter.x) + Math.abs(a.y - fighter.y)) - (Math.abs(b.x - fighter.x) + Math.abs(b.y - fighter.y)))[0]
      const step = goal && (battle as unknown as { stepToward(f: unknown, g: unknown): unknown }).stepToward(fighter, goal)
      console.log(`  DIAG ${fighter.combatant.label} reachable ${battle.reachable(fighter).size} goal ${goal?.combatant.label}@${goal?.x},${goal?.y} step ${JSON.stringify(step)} canMove ${EIGHT_STEPS.filter((st) => battle.canMove(fighter, st)).map((st) => `${st.dx},${st.dy}`).join(' ')}`)
    }
    if (battle.combat.round > 40) return 'run'
    return 'done'
  },
  battleEnd: () => {},
  party: () => {},
  who: async (_prompt, members) => random(Math.max(0, members.length - 1)),
  parlay: async () => random(4),
  saved: () => {},
  files: () => {},
  note: (message) => { notes.set(message, (notes.get(message) ?? 0) + 1) },
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const clock = new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} hung for ${ms}ms`)), ms) })
  return Promise.race([promise, clock]).finally(() => clearTimeout(timer))
}

const library = new GameLibrary(await directorySource(folder))
const saved = await library.savedGame('A')
if (!saved) throw new Error('no SAVGAMA.DAT')
const session = new GameSession(library, ui)
session.random = random
await session.resume(saved)
console.log(`${library.game.title}: ${session.roster.members.length} in the party, ${STEPS} steps, seed ${seedArg ?? 1}`)

const areas = new Map<number, number>()
const errors: string[] = []
let deaths = 0
let lastScript = -1
let stuck = 0
const commands = ['forward', 'forward', 'forward', 'forward', 'turnLeft', 'turnRight', 'back'] as const
const started = Date.now()

for (let step = 0; step < STEPS; step++) {
  if (session.scriptId !== lastScript) {
    lastScript = session.scriptId
    areas.set(lastScript, (areas.get(lastScript) ?? 0) + 1)
  }
  const members = session.roster.members
  const standing = members.filter((m) => m.character.status === 'okay')
  if (standing.length === 0) {
    deaths++
    for (const m of members) { m.character.status = 'okay'; m.character.statusByte = 0; m.character.hpCurrent = m.character.hpMax }
  }
  // A dead member would need a temple and the coins for it; the bot just raises them and counts it.
  for (const m of members) {
    if (m.character.status === 'dead' && step % 50 === 0) { raises++; m.character.status = 'okay'; m.character.statusByte = 0; m.character.hpCurrent = m.character.hpMax }
  }
  const hurt = members.some((m) => m.character.hpCurrent < m.character.hpMax / 2 || m.character.status !== 'okay')
  const noSpells = members.some((m) => m.character.prepared.length > 0 && m.character.memorised.length === 0)
  if ((hurt || noSpells) && step % 5 === 0) {
    wantRest = true
    if (process.env.PLAY_DEBUG) console.log(`camp at step ${step}`)
    try { await withTimeout(session.camp(), 20_000, `camp at step ${step}`) } catch (e) { errors.push(String(e instanceof Error ? e.message : e)) }
    wantRest = false
  }
  const before = `${session.party.row},${session.party.col},${session.scriptId}`
  const command = stuck > 6 ? (step % 2 === 0 ? 'turnRight' : 'forward') : commands[random(commands.length - 1)]!
  try {
    await withTimeout(session.move(command), 20_000, `step ${step} (${command})`)
  } catch (e) {
    errors.push(`step ${step}: ${e instanceof Error ? e.message : String(e)}`)
    if (errors.length > 20) break
  }
  const after = `${session.party.row},${session.party.col},${session.scriptId}`
  if (process.env.PLAY_DEBUG && step < 60) console.log(`step ${step} ${command}: ${before} -> ${after} busy ${session.busy}`)
  stuck = after === before ? stuck + 1 : 0
  if (session.overhead && stuck > 12) {
    // Outdoors the map is a shortcut away; take one so the run keeps seeing new places.
    const options = await session.travelOptions()
    if (options.length > 0) await session.travelTo(options[random(options.length - 1)]!.id)
    stuck = 0
  }
}

const { mapName } = await import('../src/formats/detect.js')
console.log(`\n${Date.now() - started}ms, ${menus} menus, ${fights} fights (${wins} won, ${losses} lost), ${deaths} party deaths, ${raises} raised`)
console.log('areas:', [...areas.entries()].map(([id, n]) => `${mapName(library.game.id, id)} ×${n}`).join(', '))
console.log('party:', session.roster.members.map((m) => `${m.character.name} L${Math.max(...m.character.levels)} ${m.character.hpCurrent}/${m.character.hpMax} xp${m.character.experience} ${m.character.status}`).join(' | '))
{
  const { describeCoins } = await import('../src/engine/treasure.js')
  const coins = [0, 0, 0, 0, 0, 0, 0]
  for (const m of session.roster.members) m.character.money.forEach((n, i) => { coins[i]! += n })
  console.log('coins:', describeCoins(coins) || 'none')
}
if (notes.size) console.log('notes:\n  ' + [...notes.entries()].map(([m, n]) => `${m} ×${n}`).join('\n  '))
console.log('menus seen most:\n  ' + [...menuSeen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${n}× ${k}`).join('\n  '))
if (errors.length) console.log('ERRORS:\n  ' + errors.join('\n  '))
console.log('last text:', texts.slice(-5).join(' / '))
{
  const { cellAt, DIRECTIONS, canWalk } = await import('../src/formats/geo.js')
  const map = session.map
  const cell = map && cellAt(map, session.party.row, session.party.col)
  console.log('ended at', session.party, 'script', session.scriptId, 'overhead', session.overhead, 'stuck', stuck,
    cell ? `walls ${JSON.stringify(cell.walls)} doors ${JSON.stringify(cell.doors)} exits ${DIRECTIONS.filter((d) => canWalk(map!, cell.row, cell.col, d)).join(',') || 'none'}` : 'no cell')
}
