/**
 * An automated player: a new game with the pre-made party, thousands of steps of
 * exploring, menus answered by a simple policy, fights fought, camp when hurt. It
 * reports what breaks — exceptions, hangs, script notes — and what happened: areas
 * seen, fights, deaths, levels. Development only; needs a game folder.
 *
 *   npx tsx scripts/playthrough.ts /path/to/POOLRAD [steps] [seed]
 */

import { EIGHT_STEPS } from '../src/engine/battle.js'
import { canWalk, cellAt, DIRECTIONS, step as stepOf, type Direction, type GeoMap } from '../src/formats/geo.js'
import { readyToTrain } from '../src/engine/training.js'
import { goldOf } from '../src/engine/treasure.js'
import { mapName } from '../src/formats/detect.js'
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
  // The high bits of the generator: its low bits cycle, and dice cut from them miss forever.
  seed = (seed * 1664525 + 1013904223) >>> 0
  return Math.floor(((seed >>> 8) / 0x1000000) * (max + 1))
}

const notes = new Map<string, number>()
const menuSeen = new Map<string, number>()
const texts: string[] = []
let menus = 0
let fights = 0
let wins = 0
let losses = 0
let raises = 0
let trainTries = 0
let wantRest = false

let trained = 0
let lastStatus = ''
let seller = 0
let sold = 0
const sellable = () => session.roster.members.some((m) => m.items.some((i) => !i.readied))
let dueled = false
let reloads = 0

const ui: SessionUi = {
  showLevel: () => {},
  showParty: () => {},
  print: (text) => {
    if (text.includes('EACH SURVIVOR GAINS')) wins++
    if (text.includes('THE PARTY HAS FALLEN')) losses++
    if (text.includes('IS NOW A LEVEL')) trained++
    if (text.includes('THE SHOPKEEPER PAYS')) sold++
    if (text.includes('WINS THE BOUT') || text.includes('YIELDS')) dueled = true
    if (process.env.PLAY_TEXTS && text.trim()) console.log(`  text: ${text.trim().slice(0, 100)}`)
    else if (process.env.PLAY_DEBUG && lastStatus.startsWith('in the') && text.trim()) console.log(`  text: ${text.trim().slice(0, 100)}`)
    if (text.trim()) texts.push(text.trim().slice(0, 80))
  },
  newLine: () => {},
  menu: async (prompt, items) => {
    menus++
    if (process.env.PLAY_TEXTS) console.log(`  menu: ${prompt ?? ''} [${items.join(', ')}]`)
    const key = `${prompt ?? ''} | ${items.join(', ')}`.slice(0, 120)
    menuSeen.set(key, (menuSeen.get(key) ?? 0) + 1)
    if (menus > 200_000) throw new Error(`menu loop: ${key}`)
    const labels = items.map((i) => i.toUpperCase())
    const find = (word: string) => labels.findIndex((l) => l.includes(word))
    if (find('PRESS') >= 0) return find('PRESS')
    if (labels.length === 2 && find('YES') === 0 && /TRAIN|DUEL/.test(texts[texts.length - 1] ?? '')) { trainTries = 0; return 0 }
    if (prompt === 'TRAIN:') {
      // Train the first candidate once; if the hall asks again the last one could not pay.
      trainTries++
      return trainTries === 1 ? 0 : find('LEAVE')
    }
    trainTries = 0
    if (prompt?.startsWith('CAMP')) return wantRest && !prompt.includes('EVERYONE IS WELL') ? Math.max(0, find('REST')) : find('LEAVE')
    if (find('QUICK FIGHT') >= 0) { fights++; return find('QUICK FIGHT') }
    if (find('FIGHT') >= 0 && find('RUN') >= 0) return find('FIGHT')
    if (find('COMBAT') >= 0 && find('WAIT') >= 0) return random(9) < 7 ? find('COMBAT') : find('FLEE')
    if (find('SHARE') >= 0) return find('SHARE')
    if (find('LEAVE THE REST') >= 0) {
      // Take what can be sold, up to a pack each; the shops turn it into training gold.
      const carried = session.roster.members.reduce((n, m) => n + m.items.length, 0)
      const take = labels.findIndex((l) => l.startsWith('TAKE '))
      return take >= 0 && carried < session.roster.members.length * 8 ? take : find('LEAVE THE REST')
    }
    if (prompt?.startsWith('THE TEMPLE.')) {
      const dead = session.roster.members.some((m) => m.character.status === 'dead')
      const purse = session.roster.members.reduce((n, m) => n + goldOf(m), 0)
      if (dead && purse >= 1000) return find('RAISE')
      return session.roster.members.some((m) => m.character.hpCurrent < m.character.hpMax) && purse > 20 ? find('HEAL') : find('LEAVE')
    }
    if (prompt === 'THE SHOP.') return sellable() ? find('SELL') : session.roster.members.some((m) => (m.character.money[5] ?? 0) + (m.character.money[6] ?? 0) > 0) ? find('APPRAISE') : find('LEAVE')
    if (prompt === 'WHOSE?') return session.roster.members.findIndex((m) => (m.character.money[5] ?? 0) + (m.character.money[6] ?? 0) > 0)
    if (prompt === 'SELL WHAT?') { const at = session.roster.members[seller]?.items.findIndex((i) => !i.readied) ?? -1; return at >= 0 ? at : labels.length - 1 }
    // Leave small menus alone the first few times; after that try the other answers,
    // or a door that puts the party back outside is entered forever.
    if (find('LEAVE') >= 0 && labels.length <= 3 && find('NORTH') < 0 && (menuSeen.get(key) ?? 0) <= 3) return find('LEAVE')
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
  battleMode: async () => { fights++; return process.env.PLAY_MODE === 'tactical' || (process.env.PLAY_MODE !== 'quick' && fights % 2 === 0) ? 'tactical' : 'quick' },
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
  who: async (prompt, members) => {
    if (prompt === 'WHO SELLS?') { seller = members.findIndex((m) => m.items.some((i) => !i.readied)); return Math.max(0, seller) }
    if (prompt === 'WHO TAKES IT?') return members.reduce((best, m, i) => (m.items.length < members[best]!.items.length ? i : best), 0)
    return random(Math.max(0, members.length - 1))
  },
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
if (process.env.PLAY_RICH) {
  // A party with the experience and the gold to train, dropped in the city, to
  // exercise the halls at once.
  for (const m of session.roster.members) { m.character.experience = 20_000; m.character.money[3] = 2000 }
  await session.enterLevel((await library.levelById(0, 3))!)
}
console.log(`${library.game.title}: ${session.roster.members.length} in the party, ${STEPS} steps, seed ${seedArg ?? 1}`)

const areas = new Map<number, number>()
const errors: string[] = []
let deaths = 0
let lastScript = -1
let stuck = 0
const commands = ['forward', 'forward', 'forward', 'forward', 'turnLeft', 'turnRight', 'back'] as const

/**
 * Where the bot wants to go, when it wants something: the training halls when
 * somebody has the experience and the party the coins. New Phlan's halls are the
 * city's events 10 and 17; inside (script 11, same map) the school doors are the
 * cells whose event bytes are 12, 13, 16 and 17 — the hall script subtracts ten.
 */
const HALL_DOORS = new Map<string, number[]>([['city', [10, 17]], ['hall', [12, 13, 16, 17]], ['shop', [19, 21, 22, 23]]])
/** Which school teaches which class, by the city's event byte on its door. */
const SCHOOL_OF: Record<string, number> = { cleric: 12, 'magic-user': 13, fighter: 16, thief: 17 }
const TRAINING_COST = 1000

function wantsTraining(): 'city' | 'hall' | 'shop' | undefined {
  const name = mapName(library.game.id, session.scriptId)
  const where = name === 'Civilized Area, New Phlan' ? 'city' : session.scriptId === 11 ? 'hall' : undefined
  if (!where) return undefined
  const ready = session.roster.members.filter((m) => readyToTrain(m.character, 0x7f).length > 0)
  const purse = session.roster.members.reduce((n, m) => n + goldOf(m), 0)
  const status = `in the ${where}: ready ${ready.map((m) => m.character.name).join(',') || 'nobody'}, purse ${purse}`
  if (process.env.PLAY_DEBUG && status !== lastStatus) console.log(`  ${status}`)
  lastStatus = status
  if (ready.length === 0) return undefined
  // Short of the fee but carrying loot: the city's shops first.
  if (purse < TRAINING_COST) return where === 'city' && sellable() ? 'shop' : undefined
  // The party pools its gold on whoever is training, the way a player would.
  const payer = ready[0]!
  if (goldOf(payer) < TRAINING_COST) {
    for (const m of session.roster.members) {
      if (m === payer) continue
      for (let kind = 0; kind < 5; kind++) {
        payer.character.money[kind]! += m.character.money[kind] ?? 0
        m.character.money[kind] = 0
      }
    }
  }
  return where
}

/** The cell the bot is walking to, kept until it gets there, so two doors cannot pull it back and forth. */
let target: { row: number; col: number; events: string; until: number } | undefined

/** The first command of a shortest walk to any cell with one of the events, or nothing. */
function routeTo(map: GeoMap, from: { row: number; col: number; facing: Direction }, events: readonly number[], step: number): 'forward' | 'turnLeft' | 'turnRight' | undefined {
  const key = (row: number, col: number) => `${row},${col}`
  const wanted = events.join(',')
  if (target && (target.events !== wanted || target.until < step || (target.row === from.row && target.col === from.col))) target = undefined
  const isGoal = (row: number, col: number, event: number) =>
    target ? row === target.row && col === target.col : events.includes(event)
  const prev = new Map<string, { row: number; col: number; dir: Direction } | null>([[key(from.row, from.col), null]])
  const queue = [{ row: from.row, col: from.col }]
  while (queue.length > 0) {
    const here = queue.shift()!
    const cell = cellAt(map, here.row, here.col)
    if (cell && isGoal(here.row, here.col, cell.event) && !(here.row === from.row && here.col === from.col)) {
      if (!target) target = { row: here.row, col: here.col, events: wanted, until: step + 60 }
      // Walk back to the first step.
      let cursor = here
      let first: Direction | undefined
      for (;;) {
        const p = prev.get(key(cursor.row, cursor.col))
        if (!p) break
        first = p.dir
        cursor = { row: p.row, col: p.col }
      }
      if (!first) return undefined
      if (first === from.facing) return 'forward'
      const turn = (DIRECTIONS.indexOf(first) - DIRECTIONS.indexOf(from.facing) + 4) % 4
      return turn === 1 ? 'turnRight' : 'turnLeft'
    }
    for (const dir of DIRECTIONS) {
      if (!canWalk(map, here.row, here.col, dir)) continue
      const d = stepOf(dir)
      const row = here.row + d.dRow
      const col = here.col + d.dCol
      if (prev.has(key(row, col))) continue
      prev.set(key(row, col), { row: here.row, col: here.col, dir })
      queue.push({ row, col })
    }
  }
  return undefined
}
const started = Date.now()
let checkpoint: ReturnType<typeof session.snapshot> | undefined

for (let step = 0; step < STEPS; step++) {
  if (session.scriptId !== lastScript) {
    lastScript = session.scriptId
    areas.set(lastScript, (areas.get(lastScript) ?? 0) + 1)
  }
  const members = session.roster.members
  const standing = members.filter((m) => m.character.status === 'okay')
  if (standing.length === 0) {
    deaths++
    if (checkpoint && reloads < 200) {
      // What a player does after a wipe: reload the last save.
      reloads++
      await session.load(checkpoint)
      for (const m of session.roster.members) { m.character.hpCurrent = m.character.hpMax }
      continue
    }
    for (const m of members) { m.character.status = 'okay'; m.character.statusByte = 0; m.character.hpCurrent = m.character.hpMax }
  }
  if (step % 250 === 0 && standing.length === members.length && !session.busy) checkpoint = session.snapshot()
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
  const goal = wantsTraining()
  const doors = goal === 'hall'
    ? [...new Set(session.roster.members.flatMap((m) => readyToTrain(m.character, 0x7f).map((track) => SCHOOL_OF[track] ?? 0))), ...(dueled ? [] : [14])].filter(Boolean)
    : HALL_DOORS.get(goal ?? '') ?? []
  const routed = goal && session.map && doors.length > 0 ? routeTo(session.map, session.party, doors, step) : undefined
  if (process.env.PLAY_DEBUG && goal) {
    const cell = session.map && cellAt(session.map, session.party.row, session.party.col)
    console.log(`step ${step}: seeking the ${goal} in script ${session.scriptId}, ${routed ?? 'no route'} from ${session.party.row},${session.party.col} ${session.party.facing} walls ${JSON.stringify(cell?.walls)} doors ${JSON.stringify(cell?.doors)} event ${cell?.event}`)
  }
  const command = routed ?? (stuck > 6 ? (step % 2 === 0 ? 'turnRight' : 'forward') : commands[random(commands.length - 1)]!)
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

console.log(`\n${Date.now() - started}ms, ${menus} menus, ${fights} fights (${wins} won, ${losses} lost), ${deaths} party deaths, ${raises} raised, ${reloads} reloads, ${sold} items sold, ${trained} levels trained`)
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
