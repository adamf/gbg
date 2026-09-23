/**
 * Writes a saved game with a seasoned party, for testing the parts of the game a
 * first-level party never reaches: the pre-made six trained to a level, in plate and
 * chain with a few enchanted things, three thousand gold each, books full of every
 * spell they can cast and the night's spells memorised.
 *
 *   npx tsx scripts/make-save.ts /path/to/POOLRAD [letter] [level] [out-folder]
 *
 * Defaults: letter C, level 6, written into the game folder as SAVGAMC.DAT and
 * CHRDATC1–6. Then `PLAY_PARTY=C` starts the bot from it, and the page's NEW GAME
 * offers LOAD GAME C. Nothing here is game data: the party is the shipped one,
 * advanced by the same rules the training halls apply.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { GameLibrary } from '../src/formats/library.js'
import { directorySource } from '../src/cli/node-source.js'
import { CLASS_TRACKS, type Item } from '../src/formats/character.js'
import { spellLevelOf } from '../src/formats/spells.js'
import { GameSession, type SessionUi } from '../src/engine/session.js'
import { levelLimit, nextLevelAt, train, type Track } from '../src/engine/training.js'
import { autoPrepare, refresh, slots } from '../src/engine/casting.js'
import { ready, recompute } from '../src/engine/equipment.js'

const [folder, letterArg, levelArg, outArg] = process.argv.slice(2)
if (!folder) {
  console.error('usage: make-save <game-folder> [letter] [level] [out-folder]')
  process.exit(2)
}
const letter = (letterArg ?? 'C').toUpperCase()
const level = Number(levelArg ?? 6)
const out = outArg ?? folder

let seed = 12345
const random = (max: number): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return Math.floor(((seed >>> 8) / 0x1000000) * (max + 1))
}

// A silent host: the start script runs on resume and may print or ask.
const ui = new Proxy({}, { get: (_, key) => (key === 'menu' ? async () => 0 : key === 'inputString' ? async () => '' : key === 'inputNumber' ? async () => 0 : key === 'battleMode' ? async () => 'quick' : () => {}) }) as unknown as SessionUi

const library = new GameLibrary(await directorySource(folder))
const saved = await library.savedGame('A')
if (!saved) throw new Error('no SAVGAMA.DAT in that folder')
const session = new GameSession(library, ui)
session.random = random
await session.resume(saved)

const templates = await library.itemTemplates()
const types = await library.itemTypes()
const PLATE = 58, CHAIN = 55, LEATHER = 50, SHIELD = 59, LONG_SWORD = 36, MACE = 23, DAGGER = 8, SHORT_SWORD = 37
const gear = (type: number, plus: number): Item | undefined => {
  const t = templates.get(type)
  return t && { ...t, names: [...t.names] as [number, number, number], affects: [...t.affects], plus, readied: false }
}

for (const member of session.roster.members) {
  const c = member.character
  const tracks = CLASS_TRACKS.filter((t, i) => (c.levels[i] ?? 0) > 0) as Track[]
  // Every class the character has, to the level asked for, within the race's limit as the halls would hold it.
  // ...and within the game's own cap, where the table of thresholds ends.
  for (const track of tracks) {
    while ((c.levels[CLASS_TRACKS.indexOf(track)] ?? 0) < Math.min(level, levelLimit(c.race, track)) && Number.isFinite(nextLevelAt(track, c.levels[CLASS_TRACKS.indexOf(track)] ?? 0))) train(c, track, random)
  }
  c.experience = Math.max(...tracks.map((t) => nextLevelAt(t, (c.levels[CLASS_TRACKS.indexOf(t)] ?? 1) - 1))) * tracks.length
  c.hpCurrent = c.hpMax
  c.money = [0, 0, 0, 3000, 0, 0, 0]
  // The book: every spell of each class at the levels the slots allow.
  for (const cls of ['cleric', 'magic-user'] as const) {
    const have = slots(c, cls)
    for (let id = 1; id < 64; id++) {
      const at = spellLevelOf(id)
      if (at && at.class === cls && (have[at.level - 1] ?? 0) > 0 && !c.spellbook.includes(id)) c.spellbook.push(id)
    }
  }
  c.spellbook.sort((a, b) => a - b)
  autoPrepare(c)
  refresh(c)
  // Gear by class: the fighting classes in plate with a shield and a long sword +2,
  // clerics in chain with a mace +1, thieves in leather with a short sword +1, and
  // magic-users with a dagger +1. What they had goes in the pack.
  const fighter = tracks.some((t) => t === 'fighter' || t === 'paladin' || t === 'ranger')
  const cleric = tracks.includes('cleric')
  const thief = tracks.includes('thief')
  const wanted = fighter ? [gear(PLATE, 1), gear(SHIELD, 1), gear(LONG_SWORD, 2)]
    : cleric ? [gear(CHAIN, 1), gear(SHIELD, 1), gear(MACE, 1)]
    : thief ? [gear(LEATHER, 1), gear(SHORT_SWORD, 1)]
    : [gear(DAGGER, 1)]
  for (const item of member.items) item.readied = false
  for (const item of wanted) if (item) { member.items.push(item); ready(c, member.items, member.items.length - 1, types) }
  recompute(c, member.items, types)
  console.log(`${c.name.padEnd(16)} ${tracks.map((t) => `${t} ${c.levels[CLASS_TRACKS.indexOf(t)]}`).join('/')}  hp ${c.hpMax}  thac0 ${c.thac0}  ac ${c.ac}  xp ${c.experience}  spells ${c.memorised.length}`)
}

const files = await session.dosSave(letter)
mkdirSync(out, { recursive: true })
for (const f of files) writeFileSync(join(out, f.name), f.bytes)
console.log(`wrote ${files.map((f) => f.name).join(', ')} to ${out}`)
