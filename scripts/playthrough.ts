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
import { goldOf, worth } from '../src/engine/treasure.js'
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
/**
 * PLAY_QUEST: play the commissions instead of wandering — hunt in the Slums until
 * the block is cleared (global 0x4ABB reaches 254), walk to the city hall (city
 * event 27) and find the clerk, take the boat to Sokal Keep, then the clerk's other
 * areas in TARGETS, collecting from her between each. The party saves every 25
 * steps and reloads after a wipe, as a Gold Box player does; a square it has wiped
 * on twice, or that keeps throwing it back, is routed round from then on; an area
 * it cannot finish in three laps is given up. When somebody has the experience and
 * the party the fee it detours to town to train. Prints every text along the way.
 */
type Phase = 'slums' | 'city' | 'hall' | 'dock' | 'pier' | 'sokal' | 'sail' | 'city2' | 'hall2' | 'area' | 'collect' | 'train' | 'done'
/**
 * The clerk's other commissions, each an area to clear and the flag its script sets
 * to 254 when it is. The walk there is a harness shortcut; the area is played.
 */
const TARGETS = [
  { name: "Kuto's Well", script: 29, area: 8, flag: 0x4aa6 },
  { name: 'Podal Plaza', script: 18, area: 1, flag: 0x4ab0 },
  { name: "Mendor's Library", script: 15, area: 2, flag: 0x4aaa },
  { name: 'Kovel Mansion', script: 14, area: 3, flag: 0x4ab2 },
  { name: 'Temple of Bane', script: 24, area: 1, flag: 0x4aa8 },
  { name: 'Stojanow Gate', script: 9, area: 2, flag: 0x4ab9 },
  { name: 'Map 10', script: 10, area: 4, flag: 0x4ab1 },
]
const quest = process.env.PLAY_QUEST ? { phase: 'slums' as Phase, log: [] as string[], started: 0, visited: new Set<string>(), deadly: new Set<string>(), wipes: new Map<string, number>(), detour: undefined as Phase | undefined, retries: 0, wrong: 0, anteroom: false, target: 0, laps: 0, rewards: 0 } : undefined
const mem = () => (session as unknown as { memory: { read(a: number): number } }).memory
let seller = 0
let sold = 0
const sellable = () => session.roster.members.some((m) => m.items.some((i) => !i.readied))
/** What the shops would pay for everything not readied. */
const lootWorth = () => session.roster.members.reduce((n, m) => n + m.items.filter((i) => !i.readied).reduce((k, i) => k + Math.floor(worth(i, templates) / 2), 0), 0)
let dueled = false
let reloads = 0

const ui: SessionUi = {
  showLevel: () => {},
  showParty: () => {},
  print: (text) => {
    if (text.includes('EACH SURVIVOR GAINS')) wins++
    if (text.includes('THE PARTY HAS FALLEN')) losses++
    if (text.includes('THE PARTY RESTS')) rests++
    if (text.includes('IS NOW A LEVEL')) trained++
    if (text.includes('THE SHOPKEEPER PAYS')) sold++
    if (text.includes('WINS THE BOUT') || text.includes('YIELDS')) dueled = true
    if (quest && text.trim()) quest.log.push(`${quest.phase}: ${text.trim().slice(0, 110)}`)
    if (quest && text.includes('WRONG WORD')) quest.wrong++
    if (process.env.PLAY_TEXTS && text.trim()) console.log(`  text: ${text.trim().slice(0, 100)}`)
    else if (process.env.PLAY_DEBUG && lastStatus.startsWith('in the') && text.trim()) console.log(`  text: ${text.trim().slice(0, 100)}`)
    // The question is at the end of a long paragraph; keep the tail, not the head.
    if (text.trim()) texts.push(text.trim().slice(-120))
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
    if (quest && find('GO') >= 0 && find('FIGHT') >= 0 && labels.length === 2) return find('GO')
    if (quest && find('SURRENDER') >= 0 && find('FIGHT') >= 0) return find('FIGHT')
    if (find('FIGHT') >= 0 && find('RUN') >= 0) return find('FIGHT')
    if (find('COMBAT') >= 0 && find('WAIT') >= 0) {
      // In town on a quest the party talks its way past or leaves; it fights where the fights count.
      if (quest && (session.scriptId === 0 || session.scriptId === 8)) return find('PARLAY') >= 0 ? find('PARLAY') : find('FLEE')
      // Sokal Keep's undead ask for the journal's word when spoken to, and leave on hearing it.
      if (quest && find('PARLAY') >= 0 && /UNDEAD/.test(texts.slice(-2).join(' '))) return find('PARLAY')
      return quest ? find('COMBAT') : random(9) < 7 ? find('COMBAT') : find('FLEE')
    }
    if (find('SHARE') >= 0) return find('SHARE')
    if (find('LEAVE THE REST') >= 0) {
      // Take what can be sold, up to a pack each; the shops turn it into training gold.
      const carried = session.roster.members.reduce((n, m) => n + m.items.length, 0)
      const take = labels.findIndex((l) => l.startsWith('TAKE '))
      return take >= 0 && carried < session.roster.members.length * 8 ? take : find('LEAVE THE REST')
    }
    // Nobody forces their way past temple guards or stays for the city watch on a commission.
    if (quest && find('FORCE') >= 0 && find('LEAVE') >= 0) return find('LEAVE')
    // STAY is always the fight: the city watch's GO or RUN is the other answer.
    if (quest && find('STAY') >= 0 && labels.length === 2) return 1 - find('STAY')
    if (quest && find('ATTACK') >= 0 && labels.length <= 3) return find('TALK') >= 0 ? find('TALK') : find('ATTACK')
    if (quest && find('YES') === 0 && labels.length === 2) {
      const last = texts.slice(-3).join(' ')
      // No to the boat while the keep is unfinished, and never a wager or another round of dice.
      if (quest.phase === 'sokal' && /BOAT BACK/.test(last)) return 1
      if (/WAGER|AGAIN|ANOTHER|BET|DICE|GAMBL|REST HERE|STAY\?|CLIMB UP|BREAK IN/.test(last)) return 1
      return 0
    }
    if (prompt?.startsWith('THE TEMPLE.')) {
      if ((menuSeen.get(key) ?? 0) > 4) return find('LEAVE')
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
  inputNumber: async () => (/WAGER|BET/.test(texts[texts.length - 1] ?? '') ? 0 : 1),
  inputString: async (maxLength) => {
    // Sokal Keep's undead want the journal's words: seven letters is SAMOSUD or
    // SHESTNI, three is LUX. A wrong word switches the guess.
    if (!quest) return 'BOT'
    if (maxLength === 3) return 'LUX'
    // The keep's script keeps which of the two words is current at 0x4A26.
    return mem().read(0x4a26) === 255 ? 'SAMOSUD' : 'SHESTNI'
  },
  delay: async () => {},
  picture: () => {},
  encounter: () => {},
  spriteOff: () => {},
  monsters: () => {},
  combatRound: async () => 'fight',
  battleMode: async () => { fights++; return process.env.PLAY_MODE === 'tactical' || (process.env.PLAY_MODE !== 'quick' && fights % 2 === 0) ? 'tactical' : 'quick' },
  battleArt: () => {},
  battleUpdate: async (battle, lines) => {
    if (process.env.PLAY_FIGHTS || (process.env.PLAY_DEBUG && battle.combat.round >= 44 && battle.combat.round <= 45)) console.log(`  monsters r${battle.combat.round}: ${lines.join(' ') || 'nothing'}`)
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
  // On a quest the party is polite: the haughty and abusive answers start fights it cannot win yet.
  parlay: async () => (quest ? 3 : random(4)),
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
const templates = await library.itemTemplates()
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
/** The city hall's ways out: stepping on one puts the party back in the street. */
const EXITS = new Set([26])
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
  // Short of the fee: the shops, if what the party carries would make it up; otherwise it is not worth the walk.
  if (purse < TRAINING_COST) return where === 'city' && sellable() && purse + lootWorth() >= TRAINING_COST ? 'shop' : undefined
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

let bounces = 0
/** The last quest step's squares: where the party stood and where it tried to go. A wipe is charged to the second. */
let lastStep: { from: string; to: string } | undefined
/**
 * One step of a quest walk. A square that keeps putting the party back where it
 * was — temple guards, a locked door, a room that throws the party out — joins the
 * deadly set after three tries, so the route goes round it.
 */
async function go(command: 'forward' | 'turnLeft' | 'turnRight', step: number): Promise<void> {
  const before = `${session.scriptId}/${session.map?.id}:${session.party.row},${session.party.col}`
  const ahead = stepOf(session.party.facing)
  const target = `${session.scriptId}/${session.map?.id}:${session.party.row + ahead.dRow},${session.party.col + ahead.dCol}`
  if (command === 'forward') lastStep = { from: before, to: target }
  try { await withTimeout(session.move(command), 20_000, `quest step ${step}`) } catch (e) { errors.push(String(e)) }
  const after = `${session.scriptId}/${session.map?.id}:${session.party.row},${session.party.col}`
  bounces = command === 'forward' && after === before ? bounces + 1 : 0
  if (bounces >= 3 && quest) { quest.deadly.add(target); bounces = 0; if (process.env.PLAY_DEBUG) console.log(`quest step ${step}: ${target} bounces the party; routing round it`) }
}

/** The squares of the current map the party has been wiped on, as row,col keys. */
function deadlyHere(): ReadonlySet<string> {
  if (!quest || !session.map) return new Set()
  const prefix = `${session.scriptId}/${session.map.id}:`
  return new Set([...quest.deadly].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)))
}

/** The cell the bot is walking to, kept until it gets there, so two doors cannot pull it back and forth. */
let target: { row: number; col: number; events: string; until: number } | undefined

/** The first command of a shortest walk to any cell with one of the events, or nothing. */
function routeTo(map: GeoMap, from: { row: number; col: number; facing: Direction }, events: readonly number[] | ReadonlySet<string>, step: number, avoid?: ReadonlySet<number>, blocked: ReadonlySet<string> = deadlyHere()): 'forward' | 'turnLeft' | 'turnRight' | undefined {
  const key = (row: number, col: number) => `${row},${col}`
  const cells = events instanceof Set ? events : undefined
  const wanted = cells ? [...cells].join(';') : (events as readonly number[]).join(',')
  if (target && (target.events !== wanted || target.until < step || (target.row === from.row && target.col === from.col))) target = undefined
  const isGoal = (row: number, col: number, event: number) =>
    target ? row === target.row && col === target.col : cells ? cells.has(key(row, col)) : (events as readonly number[]).includes(event)
  const prev = new Map<string, { row: number; col: number; dir: Direction } | null>([[key(from.row, from.col), null]])
  const queue = [{ row: from.row, col: from.col }]
  while (queue.length > 0) {
    const here = queue.shift()!
    const cell = cellAt(map, here.row, here.col)
    if (cell && isGoal(here.row, here.col, cell.event) && !(here.row === from.row && here.col === from.col) && !blocked.has(key(here.row, here.col))) {
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
      // Squares whose events throw the party out are not on the way to anywhere.
      if (avoid && avoid.has(cellAt(map, row, col)?.event ?? 0)) continue
      // Nor are the squares the party has died on: not as a goal, not on the way.
      if (blocked.has(key(row, col))) continue
      prev.set(key(row, col), { row: here.row, col: here.col, dir })
      queue.push({ row, col })
    }
  }
  return undefined
}
const started = Date.now()
let noCampUntil = 0
let rests = 0
let checkpoint: ReturnType<typeof session.snapshot> | undefined
/** The quest's own state at the checkpoint: a reload takes the memory back, so the bot's view of it goes back too. */
let questCheckpoint: { phase: Phase; target: number; laps: number; rewards: number; anteroom: boolean; wrong: number; log: string[] } | undefined

for (let step = 0; step < STEPS; step++) {
  if (session.scriptId !== lastScript) {
    lastScript = session.scriptId
    areas.set(lastScript, (areas.get(lastScript) ?? 0) + 1)
  }
  const members = session.roster.members
  const standing = members.filter((m) => m.character.status === 'okay')
  if (process.env.PLAY_DEBUG && step % 100 === 0) console.log(`step ${step}: at ${session.scriptId}:${session.party.row},${session.party.col} ${session.party.facing}; busy ${session.busy}; standing ${standing.length}; stuck ${stuck}`)
  if (standing.length === 0) {
    deaths++
    if (quest && reloads >= 200) { console.log(`step ${step}: OUT OF RELOADS`); break }
    if (checkpoint && reloads < 200) {
      // What a player does after a wipe: reload the last save, and steer clear of
      // the square that did it — a building with thirty guards is not a commission.
      // A second wipe on the same square marks it: one may be a wandering pack, two is the building's own fight.
      // Charged to the square the party stepped into, not where the script moved it before the fight.
      if (quest && session.map && lastStep) {
        const at = lastStep.to
        quest.wipes.set(at, (quest.wipes.get(at) ?? 0) + 1)
        if (quest.wipes.get(at)! >= 2) quest.deadly.add(at)
        if (process.env.PLAY_DEBUG) console.log(`step ${step}: wiped at ${at} (${quest.wipes.get(at)} times)`)
      }
      reloads++
      if (process.env.PLAY_DEBUG) console.log(`step ${step}: WIPED (${members.map((m) => `${m.character.name} ${m.character.status} ${m.character.hpCurrent}`).join(', ')}); reloading`)
      await session.load(checkpoint)
      if (quest && questCheckpoint) Object.assign(quest, { ...questCheckpoint, log: [...questCheckpoint.log], visited: new Set<string>() })
      for (const m of session.roster.members) { m.character.hpCurrent = m.character.hpMax }
      continue
    }
    for (const m of members) { m.character.status = 'okay'; m.character.statusByte = 0; m.character.hpCurrent = m.character.hpMax }
  }
  // Saved the way Gold Box players save: often, whenever everyone is on their feet.
  if (step % 25 === 0 && standing.length === members.length && !session.busy) {
    checkpoint = session.snapshot()
    if (quest) questCheckpoint = { phase: quest.phase, target: quest.target, laps: quest.laps, rewards: quest.rewards, anteroom: quest.anteroom, wrong: quest.wrong, log: [...quest.log] }
  }
  // A dead member would need a temple and the coins for it; the bot just raises them and counts it.
  for (const m of members) {
    if ((m.character.status === 'dead' || m.character.status === 'stoned') && step % 50 === 0) { raises++; m.character.status = 'okay'; m.character.statusByte = 0; m.character.hpCurrent = m.character.hpMax }
  }
  // On a quest the party rests whenever anyone is scratched or a spell is spent — the
  // Slums are lost by fighting worn down, not by fighting.
  const hurt = members.some((m) => (quest ? m.character.hpCurrent < m.character.hpMax : m.character.hpCurrent < m.character.hpMax / 2) || m.character.status !== 'okay')
  const noSpells = members.some((m) => m.character.prepared.length > 0 && m.character.memorised.length === 0)
  // A camp that was broken up before anyone rested — the council guard, the city
  // watch — is not tried again on the spot; the party walks on first.
  if ((hurt || noSpells) && (quest || step % 5 === 0) && step >= noCampUntil) {
    wantRest = true
    const restsBefore = rests
    if (process.env.PLAY_DEBUG) console.log(`camp at step ${step}`)
    try { await withTimeout(session.camp(), 20_000, `camp at step ${step}`) } catch (e) { errors.push(String(e instanceof Error ? e.message : e)) }
    wantRest = false
    if (rests === restsBefore) noCampUntil = step + 30
  }
  const before = `${session.party.row},${session.party.col},${session.scriptId}`
  if (quest) {
    if (process.env.PLAY_DEBUG && quest.phase !== 'slums') console.log(`q${step} ${quest.phase} s${session.scriptId} @${session.party.row},${session.party.col} ${session.party.facing} anteroom ${quest.anteroom} event ${session.map ? cellAt(session.map, session.party.row, session.party.col)?.event : '-'}`)
    const cleared = mem().read(0x4abb) >= 254
    if (quest.phase === 'slums' && cleared) { quest.phase = 'city'; console.log(`step ${step}: THE SLUMS ARE CLEARED (kills counted ${mem().read(0x4a80)})`) }
    if (quest.phase === 'slums' && session.scriptId !== 20 && !session.busy) {
      // Strayed out of the block: back to its gate.
      await session.enterLevel((await library.levelById(20, 2))!)
      continue
    }
    if (quest.phase === 'city' && session.scriptId !== 0 && session.scriptId !== 8 && !session.busy) {
      await session.enterLevel((await library.levelById(0, 3))!)
      continue
    }
    if (quest.phase === 'city' && session.scriptId === 8) { quest.phase = 'hall'; console.log(`step ${step}: IN THE CITY HALL`) }
    if (quest.phase === 'hall' && quest.log.some((l) => /HERE IS YOUR REWARD/.test(l))) { quest.phase = 'dock'; console.log(`step ${step}: THE CLERK HAS PAID; TO THE DOCK`) }
    if (quest.phase === 'hall2' && quest.log.filter((l) => /HERE IS YOUR REWARD/.test(l)).length >= 2) { quest.phase = 'area'; quest.rewards = 2; quest.visited.clear(); quest.laps = 0; console.log(`step ${step}: THE CLERK HAS PAID FOR SOKAL KEEP; NEXT ${TARGETS[0]!.name}`) }
    if (quest.phase === 'area' || quest.phase === 'collect') {
      const target = TARGETS[quest.target]
      if (!target) { quest.phase = 'done'; console.log(`step ${step}: EVERY TARGET TRIED`); break }
      if (quest.phase === 'area' && (mem().read(target.flag) >= 254 || quest.laps >= (target.script === 15 ? 8 : 3))) {
        console.log(`step ${step}: ${target.name} ${mem().read(target.flag) >= 254 ? 'IS CLEARED' : `GIVEN UP AFTER ${quest.laps} LAPS`} (flag ${mem().read(target.flag)})`)
        quest.phase = 'collect'; quest.anteroom = false
      }
      let paid = false
      if (quest.phase === 'collect' && quest.log.filter((l) => /HERE IS YOUR REWARD/.test(l)).length > quest.rewards) {
        quest.rewards = quest.log.filter((l) => /HERE IS YOUR REWARD/.test(l)).length
        paid = true
        console.log(`step ${step}: THE CLERK HAS PAID FOR ${target.name}`)
      }
      if (quest.phase === 'collect' && (paid || quest.log.slice(-40).some((l) => /THESE ARE ALL OF THE COMMISSIONS/.test(l)) && mem().read(target.flag) !== 254)) {
        quest.target++; quest.visited.clear(); quest.laps = 0; quest.phase = 'area'
        console.log(`step ${step}: NEXT ${TARGETS[quest.target]?.name ?? 'nothing'}`)
        continue
      }
      if (quest.phase === 'area' && session.scriptId !== target.script && !session.busy) { await session.enterLevel((await library.levelById(target.script, target.area))!); continue }
      if (quest.phase === 'area' && session.map && !session.busy) {
        // Mendor's books turn up only while searching the stacks; searching anywhere
        // else is slow going and wakes more wandering monsters.
        if (session.searching !== (target.script === 15)) session.toggleSearch()
        // Keyed by map as well as script: Kuto's Well is two maps under one script.
        const where = `${session.scriptId}/${session.map.id}`
        quest.visited.add(`${where}:${session.party.row},${session.party.col}`)
        // The square ahead counts as seen once the party tries to enter it: a room that
        // throws the party out would otherwise be tried forever.
        const ahead = stepOf(session.party.facing)
        quest.visited.add(`${where}:${session.party.row + ahead.dRow},${session.party.col + ahead.dCol}`)
        const unvisited = new Set(session.map.cells.filter((c) => c.event > 0 && !quest.visited.has(`${where}:${c.row},${c.col}`) && !quest.deadly.has(`${where}:${c.row},${c.col}`)).map((c) => `${c.row},${c.col}`))
        if (unvisited.size === 0) { quest.visited.clear(); quest.laps++; continue }
        const routed = routeTo(session.map, session.party, unvisited, step)
        if (routed) { await go(routed, step); continue }
        quest.visited.add(`${where}:${[...unvisited][0]}`)
        continue
      }
      if (quest.phase === 'collect' && session.scriptId !== 0 && session.scriptId !== 8 && !(session.scriptId === 11 && wantsTraining()) && !session.busy) { await session.enterLevel((await library.levelById(0, 3))!); continue }
      if (quest.phase === 'collect' && session.scriptId === 0 && session.map && !session.busy && !wantsTraining()) {
        const routed = routeTo(session.map, session.party, [27], step)
        if (routed) { await go(routed, step); continue }
      }
    }
    if ((quest.phase === 'dock' || quest.phase === 'pier') && session.scriptId === 8 && !session.busy) { await session.enterLevel((await library.levelById(0, 3))!); continue }
    if (quest.phase === 'dock' && quest.log.some((l) => /CATCH THE BOAT|ONLY BOAT OUT/.test(l))) { quest.phase = 'pier'; console.log(`step ${step}: THE HARBOUR MASTER HAS SPOKEN`) }
    // Somebody has the experience and the party the fee: back to town to train, then
    // back to where the work was (the boat and the walk stand in for by teleport).
    const trainable = () => session.roster.members.some((m) => readyToTrain(m.character, 0x7f).length > 0) && session.roster.members.reduce((n, m) => n + goldOf(m), 0) >= TRAINING_COST
    if ((quest.phase === 'sokal' || quest.phase === 'area') && trainable() && !session.busy) {
      quest.detour = quest.phase; quest.phase = 'train'
      console.log(`step ${step}: TO TOWN TO TRAIN (${session.roster.members.filter((m) => readyToTrain(m.character, 0x7f).length > 0).map((m) => m.character.name).join(', ')})`)
      await session.enterLevel((await library.levelById(0, 3))!)
      continue
    }
    if (quest.phase === 'train' && !session.busy && (session.scriptId === 0 || session.scriptId === 11) && !wantsTraining()) {
      const back = quest.detour ?? 'area'
      quest.phase = back; quest.detour = undefined
      console.log(`step ${step}: TRAINED; BACK TO ${back === 'sokal' ? 'SOKAL KEEP' : TARGETS[quest.target]?.name ?? 'the area'}`)
      if (back === 'sokal') await session.enterLevel((await library.levelById(21, 4))!)
      else if (TARGETS[quest.target]) await session.enterLevel((await library.levelById(TARGETS[quest.target]!.script, TARGETS[quest.target]!.area))!)
      continue
    }
    if (quest.phase === 'train' && !session.busy && session.scriptId !== 0 && session.scriptId !== 11) { await session.enterLevel((await library.levelById(0, 3))!); continue }
    if (quest.phase === 'pier' && session.scriptId === 21) { quest.phase = 'sokal'; console.log(`step ${step}: AT SOKAL KEEP`) }
    if (quest.phase === 'sokal' && mem().read(0x4aa7) >= 254) { quest.phase = 'sail'; console.log(`step ${step}: SOKAL KEEP IS CLEARED`) }
    if (quest.phase === 'sail' && session.scriptId === 0) { quest.phase = 'city2'; quest.anteroom = false; console.log(`step ${step}: BACK IN PHLAN`) }
    if (quest.phase === 'city2' && session.scriptId === 8) { quest.phase = 'hall2'; console.log(`step ${step}: IN THE CITY HALL AGAIN`) }
    if (quest.phase === 'dock' && session.scriptId === 0 && session.map && !session.busy) {
      // The harbour master only speaks to a party facing north: come at him from the dock sign.
      if (session.party.row === 2 && session.party.col === 11) {
        const cmd = session.party.facing === 'north' ? 'forward' : session.party.facing === 'east' ? 'turnLeft' : 'turnRight'
        try { await withTimeout(session.move(cmd), 20_000, `quest step ${step}`) } catch (e) { errors.push(String(e)) }
        continue
      }
      const routed = routeTo(session.map, session.party, [3], step)
      if (routed) { await go(routed, step); continue }
    }
    if (quest.phase === 'pier' && session.scriptId === 0 && session.map && !session.busy) {
      const routed = routeTo(session.map, session.party, [1], step)
      if (routed) { await go(routed, step); continue }
    }
    if ((quest.phase === 'city2') && session.scriptId !== 0 && session.scriptId !== 8 && !session.busy) { await session.enterLevel((await library.levelById(0, 3))!); continue }
    if (quest.phase === 'city2' && session.scriptId === 0 && session.map && !session.busy) {
      const routed = routeTo(session.map, session.party, [27], step)
      if (routed) { await go(routed, step); continue }
    }
    if (quest.phase === 'sail' && session.scriptId === 21 && session.map && !session.busy) {
      // Off any open edge: the keep's script offers the boat back.
      const { row, col, facing } = session.party
      const map = session.map
      const outward = (c: { row: number; col: number; walls: Record<string, number>; doors: Record<string, number> }): Direction | undefined =>
        c.row === 0 && (c.walls.north === 0 || c.doors.north) ? 'north' : c.row === 15 && (c.walls.south === 0 || c.doors.south) ? 'south'
        : c.col === 0 && (c.walls.west === 0 || c.doors.west) ? 'west' : c.col === 15 && (c.walls.east === 0 || c.doors.east) ? 'east' : undefined
      const here = cellAt(map, row, col)
      const edge = here && outward(here)
      if (edge) {
        const cmd = facing === edge ? 'forward' : 'turnRight'
        try { await withTimeout(session.move(cmd), 20_000, `quest step ${step}`) } catch (e) { errors.push(String(e)) }
        continue
      }
      const edges = new Set(map.cells.filter((c) => outward(c)).map((c) => `${c.row},${c.col}`))
      const routed = routeTo(map, session.party, edges, step)
      if (routed) { await go(routed, step); continue }
    }
    if (quest.phase === 'area' && quest.log.length > 0 && session.scriptId === TARGETS[quest.target]?.script) { /* played above */ }
    if (quest.phase === 'sokal' && session.scriptId !== 21 && !session.busy) {
      // Fell off the keep (the boat prompt answered wrong): back in.
      if (session.scriptId === 0) { const routed = session.map ? routeTo(session.map, session.party, [1], step) : undefined; if (routed) { await go(routed, step); continue } }
    }
    if (quest.phase === 'city' && session.map && !session.busy) {
      const routed = routeTo(session.map, session.party, [27], step)
      if (routed) { await go(routed, step); continue }
    }
    if ((quest.phase === 'hall' || quest.phase === 'hall2') && session.scriptId !== 8 && !session.busy) {
      // Thrown out, or reloaded into the street: back to the hall's door.
      if (session.scriptId !== 0) { await session.enterLevel((await library.levelById(0, 3))!); continue }
      const routed = session.map ? routeTo(session.map, session.party, [27], step) : undefined
      if (routed) { await go(routed, step); continue }
    }
    if ((quest.phase === 'hall' || quest.phase === 'hall2' || quest.phase === 'collect') && session.scriptId === 8 && session.map && !session.busy) {
      // The clerk is the hall's event 29, and she only speaks after the party has
      // passed her anteroom, event 28; 26 is the way out.
      const here = cellAt(session.map, session.party.row, session.party.col)?.event
      if (here === 28) quest.anteroom = true
      // Her door faces south into the room below (event 31 at 6,5): come up from there,
      // since the hall turns away a party arriving at her cell facing east or south.
      let routed: ReturnType<typeof routeTo>
      if (!quest.anteroom) routed = routeTo(session.map, session.party, [28], step, EXITS)
      else if (session.party.row === 6 && session.party.col === 5) routed = session.party.facing === 'north' ? 'forward' : session.party.facing === 'east' ? 'turnLeft' : 'turnRight'
      else routed = routeTo(session.map, session.party, new Set(['6,5']), step, EXITS)
      if (routed) { await go(routed, step); continue }
    }
    if (quest.phase === 'sokal' && session.scriptId === 21 && session.map && !session.busy) {
      const here = `${session.scriptId}:${session.party.row},${session.party.col}`
      quest.visited.add(here)
      const unvisited = new Set(session.map.cells.filter((c) => c.event > 0 && !quest.visited.has(`${session.scriptId}:${c.row},${c.col}`) && !quest.deadly.has(`${session.scriptId}/${session.map.id}:${c.row},${c.col}`)).map((c) => `${c.row},${c.col}`))
      const routed = unvisited.size > 0 ? routeTo(session.map, session.party, unvisited, step) : undefined
      if (routed) { await go(routed, step); continue }
      if (unvisited.size === 0) { quest.visited.clear(); quest.laps++ }
      else quest.visited.add(`${session.scriptId}:${[...unvisited][0]}`)
      // The keep's last fight is beyond a first-level party; the other commissions are not all.
      if (quest.laps >= 3) { quest.phase = 'area'; quest.target = 0; quest.laps = 0; quest.rewards = quest.log.filter((l) => /HERE IS YOUR REWARD/.test(l)).length; console.log(`step ${step}: SOKAL KEEP GIVEN UP AFTER 3 LAPS; NEXT ${TARGETS[0]!.name}`) }
      continue
    }
    if (quest.phase === 'slums' && session.map && !session.busy) {
      // The block's buildings hold the fights the wandering ones stop short of: walk
      // to every event square once, nearest first.
      const here = `${session.scriptId}:${session.party.row},${session.party.col}`
      quest.visited.add(here)
      const unvisited = new Set(session.map.cells.filter((c) => c.event > 0 && !quest.visited.has(`${session.scriptId}:${c.row},${c.col}`) && !quest.deadly.has(`${session.scriptId}/${session.map.id}:${c.row},${c.col}`)).map((c) => `${c.row},${c.col}`))
      const routed = unvisited.size > 0 ? routeTo(session.map, session.party, unvisited, step) : undefined
      if (process.env.PLAY_DEBUG && step < 60) console.log(`quest step ${step}: at ${here} ${session.party.facing} -> ${routed ?? 'no route'} (target ${target ? `${target.row},${target.col}` : '-'}; ${unvisited.size} cells left)`)
      if (routed) { await go(routed, step); continue }
      // No way there that keeps clear of the deadly squares: give the cell up rather
      // than wander, which walks into them.
      if (process.env.PLAY_DEBUG && unvisited.size > 0 && step % 100 === 0) console.log(`quest step ${step}: no route from ${here} ${session.party.facing} to ${unvisited.size} cells; deadly ${[...quest.deadly].join(' ')}`)
      if (unvisited.size > 0) { quest.visited.add(`${session.scriptId}:${[...unvisited][0]}`); continue }
      quest.visited.clear()
      quest.laps++
      // Three laps with the block still uncleared: the fights left are the ones it wiped
      // on, so try them once more with the party as it is now; after that, move on.
      if (quest.laps >= 3) {
        quest.laps = 0
        quest.retries = (quest.retries ?? 0) + 1
        if (quest.retries <= 2) {
          for (const k of [...quest.deadly]) if (k.startsWith(`${session.scriptId}/`)) quest.deadly.delete(k)
          quest.wipes.clear()
          console.log(`step ${step}: THE SLUMS ARE NOT CLEARED (flag ${mem().read(0x4abb)}); TRYING THE DEADLY SQUARES AGAIN`)
        } else {
          quest.phase = 'area'; quest.target = 0; quest.rewards = 0
          console.log(`step ${step}: THE SLUMS GIVEN UP (flag ${mem().read(0x4abb)}); NEXT ${TARGETS[0]!.name}`)
        }
      }
      continue
    }
  }
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
  if (quest) { await go(command === 'back' ? 'turnLeft' : command, step); continue }
  try {
    await withTimeout(session.move(command), 20_000, `step ${step} (${command})`)
  } catch (e) {
    errors.push(`step ${step}: ${e instanceof Error ? e.message : String(e)}`)
    if (errors.length > 20) break
  }
  const after = `${session.party.row},${session.party.col},${session.scriptId}`
  if (process.env.PLAY_DEBUG && step < 60) console.log(`step ${step} ${command}: ${before} -> ${after} busy ${session.busy}`)
  stuck = after === before ? stuck + 1 : 0
  if (process.env.PLAY_DEBUG && stuck > 0 && stuck % 50 === 0) console.log(`step ${step}: stuck ${stuck} at ${after} facing ${session.party.facing} after ${command}; busy ${session.busy}`)
  if (session.overhead && stuck > 12) {
    // Outdoors the map is a shortcut away; take one so the run keeps seeing new places.
    const options = await session.travelOptions()
    if (options.length > 0) await session.travelTo(options[random(options.length - 1)]!.id)
    stuck = 0
  }
}

console.log(`\n${Date.now() - started}ms, ${menus} menus, ${fights} fights (${wins} won, ${losses} lost), ${deaths} party deaths, ${raises} raised, ${reloads} reloads, ${sold} items sold, ${trained} levels trained`)
if (quest) {
  console.log(`quest: ended in phase ${quest.phase}; slums flag ${mem().read(0x4abb)}, kills ${mem().read(0x4a80)}`)
  console.log('quest texts:\n  ' + [...new Set(quest.log)].slice(-60).join('\n  '))
}
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
