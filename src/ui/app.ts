/**
 * Wires the page together: pick a folder, choose a level, walk around in it, and
 * let the level's script talk back.
 */

import { GameLibrary, type FileSource, type LevelRef } from '../formats/library.js'
import type { Rgba } from '../formats/ega.js'
import { DIRECTIONS, type GeoMap } from '../formats/geo.js'
import { DungeonViewer } from '../render/viewer.js'
import type { PartyState } from '../engine/party.js'
import { GameSession, type MoveCommand, type SessionUi, type Snapshot } from '../engine/session.js'
import type { CombatOutcome, EncounterView, MonsterGroup } from '../engine/ecl-vm.js'
import type { Member } from '../engine/roster.js'
import type { Combatant } from '../engine/combat.js'
import { BATTLE_STEPS, type Battle, type Fighter } from '../engine/battle.js'
import { drawBattle, playEffects, SQUARE, viewport, type BattleArt } from './battle-view.js'
import { className, characterLevel } from '../formats/character.js'
import { devDataSource, pickDirectory, sourceFromFiles, supportsDirectoryPicker } from './files.js'
import { mapName } from '../formats/detect.js'
import { drawMinimap } from './minimap.js'
import { drawOverland } from './overland-view.js'
import type { OverlandMap } from '../formats/overland.js'

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id)
  if (!found) throw new Error(`missing element #${id}`)
  return found as T
}

const startScreen = el('start')
const playScreen = el('play')
const statusLine = el('status')
const levelsPanel = el('levels')
const levelSelect = el<HTMLSelectElement>('levelSelect')
const warnings = el('warnings')
const mapCanvas = el<HTMLCanvasElement>('map')
const viewCanvas = el<HTMLCanvasElement>('view')
const whereLine = el('where')
const clockLine = el('clock')
const levelName = el('levelName')
const dropZone = el('drop')
const textPanel = el('text')
const textLog = el('textLog')
const menuPrompt = el('menuPrompt')
const menuBox = el('menu')
const picCanvas = el<HTMLCanvasElement>('pic')
const spriteCanvas = el<HTMLCanvasElement>('sprite')

function hideSprite(): void {
  spriteCanvas.classList.remove('shown')
}
const partyPanel = el('party')
const battlePanel = el('battle')
const overheadCanvas = el<HTMLCanvasElement>('overhead')
const battleCanvas = el<HTMLCanvasElement>('battleMap')
const battleActions = el('battleActions')

/** The player's turn in a battle, so keys can move the fighter. */
let openTurn: { battle: Battle; fighter: Fighter; refresh(): void; finish(how: 'done' | 'run'): void } | undefined
let battleArt: BattleArt | undefined
/** The original's own abbreviations for the party panel. */
const STATUS_SHORT: Record<string, string> = { unconscious: 'UNCON', dying: 'DYING', dead: 'DEAD', asleep: 'SLEEP', held: 'HELD', stoned: 'STONE', running: 'FLED', animated: 'ANIM', gone: 'GONE', 'temporarily gone': 'GONE' }
const battleInfo = el('battleInfo')
const needle = el('needle')
const sheetOverlay = el('sheet')
const sheetText = el('sheetText')
const logOverlay = el('log')
const logText = el('logText')
const keysOverlay = el('keys')
const searchButton = el('searchButton')
/** Whichever overlay is up, so the keys go to it. */
let openOverlay: HTMLElement | undefined
function showOverlay(which: HTMLElement): void { closeOverlays(); which.classList.add('shown'); openOverlay = which }
function closeOverlays(): void { for (const o of [sheetOverlay, logOverlay, keysOverlay]) o.classList.remove('shown'); openOverlay = undefined }
/** Everything the game has said, for the log. */
const history: string[] = []
const HISTORY = 300

/** The side panel the original kept: who is up, their hit points, armour and weapon. */
function showFighter(f: Fighter | undefined): void {
  if (!f) {
    battleInfo.textContent = ''
    return
  }
  const c = f.combatant.member.character
  const weapon = f.combatant.member.items.find((item) => item.readied && item.type < 48)
  battleInfo.textContent = [
    f.combatant.label,
    `HITPOINTS ${c.hpCurrent}`,
    `AC ${c.ac}`,
    weapon ? weapon.name.toUpperCase() : c.attacks.range ? 'MISSILES' : 'HANDS',
  ].join('\n')
}
const continueButton = el<HTMLButtonElement>('continue')

const SAVE_KEY = 'goldbox-web:save'

function storedSnapshot(): Snapshot | undefined {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Snapshot
    return parsed.version === 1 ? parsed : undefined
  } catch {
    return undefined
  }
}
const notes = el('notes')

let library: GameLibrary | undefined
let levels: LevelRef[] = []
let viewer: DungeonViewer | undefined
let session: GameSession | undefined
let currentMap: GeoMap | undefined

function setStatus(message: string, isError = false): void {
  statusLine.textContent = message
  statusLine.classList.toggle('error', isError)
}

async function useSource(source: FileSource): Promise<void> {
  try {
    setStatus('Reading…')
    library = new GameLibrary(source)

    if (library.game.id === 'unknown') {
      setStatus(
        'That folder does not look like a Gold Box game — no recognised .CFG file in it. ' +
        'Pick the folder that holds POOL.CFG and the .DAX files.',
        true,
      )
      levelsPanel.style.display = 'none'
      return
    }

    levels = await library.levels()
    if (levels.length === 0) {
      setStatus(`Found ${library.game.title}, but no GEO*.DAX levels in that folder.`, true)
      levelsPanel.style.display = 'none'
      return
    }

    setStatus(`${library.game.title} — ${levels.length} level${levels.length === 1 ? '' : 's'}.`)
    levelSelect.replaceChildren(
      ...levels.map((level, index) => {
        const option = document.createElement('option')
        option.value = String(index)
        option.textContent = `${level.name}  ·  ${level.file} #${level.id}`
        return option
      }),
    )
    levelsPanel.style.display = 'block'
    warnings.textContent = ''
    continueButton.hidden = storedSnapshot() === undefined
  } catch (error) {
    setStatus(`Could not read that folder: ${error instanceof Error ? error.message : String(error)}`, true)
  }
}

// ---- the page as the script sees it -------------------------------------------

/** A menu waiting for the player, so keys can answer it. */
let openMenu: { items: readonly string[]; choose(index: number): void } | undefined

function clearMenu(): void {
  menuBox.replaceChildren()
  menuPrompt.textContent = ''
  openMenu = undefined
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function drawPixels(canvas: HTMLCanvasElement, image: Rgba): void {
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d')
  if (!context) return
  context.putImageData(new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height), 0, 0)
}

const pageUi: SessionUi = {
  showLevel(map, textures, name) {
    currentMap = map
    levelName.textContent = name
    if (textures.length === 0) {
      note('No wall graphics were found for this level, so the walls are plain stone.')
    }
    viewer?.load(map, textures)
  },

  showParty(state) {
    const current = viewer?.state
    if (viewer && current && (current.row !== state.row || current.col !== state.col || current.facing !== state.facing)) {
      viewer.setParty(state)
    }
    refreshHud(state)
  },

  print(text, clear) {
    if (clear) textLog.textContent = ''
    if (clear || history.length === 0) history.push(text); else history[history.length - 1] += text
    if (history.length > HISTORY) history.splice(0, history.length - HISTORY)
    // The original appended text to the same line; a printed number is part of a sentence.
    textLog.textContent += text
    textPanel.classList.add('shown')
    textLog.scrollTop = textLog.scrollHeight
  },

  newLine() {
    textLog.textContent += '\n'
  },

  menu(prompt, items, layout) {
    // A long list comes a page at a time, as the original's Next and Prev did, so the
    // number keys always reach every entry and the box never runs off the screen.
    const PAGE = 8
    const paged = items.length > PAGE + 2
    return new Promise((resolve) => {
      let start = 0
      const show = (): void => {
        clearMenu()
        textPanel.classList.add('shown')
        menuPrompt.textContent = prompt ?? ''
        menuBox.className = layout
        const slice = paged ? items.slice(start, start + PAGE) : items
        const labels = paged ? [...slice, 'NEXT PAGE', 'PREV PAGE'] : [...slice]
        const choose = (index: number): void => {
          if (paged && index === slice.length) { start = start + PAGE < items.length ? start + PAGE : 0; show(); return }
          if (paged && index === slice.length + 1) { start = start - PAGE >= 0 ? start - PAGE : Math.floor((items.length - 1) / PAGE) * PAGE; show(); return }
          clearMenu()
          resolve(start + index)
        }
        labels.forEach((item, index) => {
          const button = document.createElement('button')
          const key = document.createElement('kbd')
          key.textContent = labels.length === 1 ? '⏎' : index === slice.length && paged ? 'N' : index === slice.length + 1 && paged ? 'P' : String(index + 1)
          button.append(key, item)
          button.addEventListener('click', () => choose(index))
          menuBox.append(button)
        })
        if (paged) menuPrompt.textContent = `${prompt ?? ''} (${start / PAGE + 1}/${Math.ceil(items.length / PAGE)})`
        openMenu = { items: labels, choose }
      }
      show()
    })
  },

  inputNumber() {
    return askText('number').then((text) => Number.parseInt(text, 10) || 0)
  },

  inputString() {
    return askText('text')
  },

  delay: () => wait(600),

  picture(image) {
    if (!image) {
      picCanvas.classList.remove('shown')
      hideSprite()
      return
    }
    drawPixels(picCanvas, image)
    picCanvas.classList.add('shown')
  },

  encounter(view: EncounterView, image) {
    if (!image) return
    if (view.distance === 0) {
      // Up close the original showed the portrait; the sprite comes down.
      hideSprite()
      drawPixels(picCanvas, image)
      picCanvas.classList.add('shown')
      return
    }
    // Further off, the group stands in the view, drawn at the size the art gives
    // that distance and magnified whole.
    drawPixels(spriteCanvas, image)
    // The original drew these into an 88-pixel-tall view; scale to ours the same way.
    const scale = Math.max(3, Math.round(viewCanvas.clientHeight / 110))
    spriteCanvas.style.width = `${image.width * scale}px`
    spriteCanvas.style.height = `${image.height * scale}px`
    spriteCanvas.classList.add('shown')
  },

  spriteOff() {
    hideSprite()
  },

  monsters(groups: readonly MonsterGroup[]) {
    if (groups.length === 0) return
    note(`monsters: ${groups.map((g) => `${g.count} × #${g.id}`).join(', ')}`)
  },

  async combat(monsters): Promise<CombatOutcome> {
    // Only reached when the monsters could not be read from the area's files.
    pageUi.print(`${monsters.reduce((n, g) => n + g.count, 0)} MONSTERS FACE YOU, BUT THEIR RECORDS ARE MISSING.`, true)
    const chosen = await pageUi.menu('How does it go?', ['THE PARTY WINS', 'THE PARTY FLEES'], 'horizontal')
    return chosen === 0 ? 'won' : 'fled'
  },

  async combatRound(round, lines, party, monsters: readonly Combatant[]) {
    const standing = monsters.filter((m) => ['okay', 'asleep', 'held'].includes(m.member.character.status) && m.member.character.hpCurrent > 0)
    const helpless = standing.filter((m) => m.member.character.status !== 'okay').length
    const summary = standing.length === 0
      ? 'THE ENEMY IS DEFEATED.'
      : `${standing.length} FOE${standing.length === 1 ? ' STILL STANDS' : 'S STILL STAND'}${helpless > 0 ? `, ${helpless} HELPLESS` : ''}.`
    pageUi.print(`${round > 0 ? `ROUND ${round}\n` : ''}${lines.join('\n')}\n${summary}`, true)
    if (standing.length === 0 || party.every((p) => p.member.character.status !== 'okay')) {
      await pageUi.menu(undefined, ['PRESS <RETURN> OR BUTTON TO CONTINUE'], 'horizontal')
      return 'fight'
    }
    const chosen = await pageUi.menu(undefined, ['FIGHT', 'CAST', 'RUN'], 'horizontal')
    return (['fight', 'cast', 'run'] as const)[chosen] ?? 'fight'
  },

  parlay() {
    return pageUi.menu(undefined, ['HAUGHTY', 'SLY', 'NICE', 'MEEK', 'ABUSIVE'], 'horizontal')
  },

  async battleMode(monsters) {
    hideSprite()
    pageUi.print(`${monsters.length} FOE${monsters.length === 1 ? '' : 'S'} FACE YOU.`, true)
    const chosen = await pageUi.menu(undefined, ['FIGHT ON THE MAP', 'QUICK FIGHT'], 'horizontal')
    return chosen === 0 ? 'tactical' : 'quick'
  },

  battleArt(tiles, decorations, outdoors, sprites) {
    battleArt = { tiles: [...tiles], decorations: [...decorations], outdoors, sprites }
  },

  async battleUpdate(battle, lines) {
    if (import.meta.env.DEV) (window as unknown as { gbg?: { battle?: unknown } }).gbg!.battle = battle
    notes.textContent = ''
    battlePanel.classList.add('shown')
    battleActions.replaceChildren()
    drawBattle(battleCanvas, battle, battle.current, battleArt)
    showFighter(battle.current)
    await playEffects(battleCanvas, battle, battle.current, battleArt)
    if (lines.length > 0) {
      pageUi.print(lines.join('\n'), true)
      await wait(Math.min(1200, 250 + lines.length * 250))
    }
  },

  battleTurn(battle, fighter, cast, use) {
    return new Promise<'done' | 'run'>((resolve) => {
      battlePanel.classList.add('shown')
      const label = fighter.combatant.label
      let finished = false
      const finish = (how: 'done' | 'run'): void => {
        if (finished) return
        finished = true
        openTurn = undefined
        battleActions.replaceChildren()
        clearMenu()
        resolve(how)
      }
      const refresh = (): void => {
        drawBattle(battleCanvas, battle, fighter, battleArt)
        showFighter(fighter)
        battleActions.replaceChildren()
        const button = (key: string, text: string, enabled: boolean, onClick: () => void): void => {
          const b = document.createElement('button')
          const k = document.createElement('kbd')
          k.textContent = key
          b.append(k, text)
          b.disabled = !enabled
          b.addEventListener('click', onClick)
          battleActions.append(b)
        }
        const near = battle.neighbours(fighter)
        const far = battle.inRange(fighter)
        button('F', 'ATTACK', near.length > 0 && !fighter.acted, () => void pick('WHOM?', near))
        button('⇧X', 'SHOOT', far.length > 0 && !fighter.acted, () => void pick('AT WHOM?', far))
        button('C', 'CAST', fighter.combatant.member.character.memorised.length > 0 && !fighter.acted, () => {
          void cast().then(async (lines) => {
            await playEffects(battleCanvas, battle, fighter, battleArt)
            if (lines.length > 0) pageUi.print(lines.join('\n'), true)
            refresh()
          })
        })
        button('U', 'USE', !fighter.acted, () => {
          void use().then((lines) => {
            if (lines.length > 0) pageUi.print(lines.join('\n'), true)
            if (battle.over) finish('done')
            else refresh()
          })
        })
        button('T', 'TURN', !fighter.acted && (fighter.combatant.member.character.levels[0] ?? 0) > 0 && battle.undead().length > 0, () => {
          const lines = battle.turnUndead(fighter)
          pageUi.print(lines.join('\n'), true)
          if (battle.over) finish('done')
          else refresh()
        })
        const bleeding = battle.dyingNeighbours(fighter)
        button('B', 'BANDAGE', bleeding.length > 0 && !fighter.acted, () => {
          void (async () => {
            const at = bleeding.length === 1 ? 0 : await pageUi.menu('WHOM?', bleeding.map((t) => t.combatant.label), 'vertical')
            const target = bleeding[at]
            if (!target) return
            pageUi.print(battle.bandage(fighter, target).join('\n'), true)
            refresh()
          })()
        })
        button('E', 'END TURN', true, () => (openTurn?.finish ?? finish)('done'))
        button('R', 'RUN', true, () => (openTurn?.finish ?? finish)('run'))
        pageUi.print(`${label}'S TURN. ${fighter.moves} MOVE${fighter.moves === 1 ? '' : 'S'} LEFT. CLICK A SQUARE OR USE THE ARROWS AND Q E Z X TO MOVE, F ATTACK, C CAST, E END.`, true)
      }
      const pick = async (prompt: string, targets: Fighter[]): Promise<void> => {
        const at = targets.length === 1 ? 0 : await pageUi.menu(prompt, targets.map((t) => t.combatant.label), 'vertical')
        const target = targets[at]
        if (!target) return
        const lines = battle.attack(fighter, target)
        await playEffects(battleCanvas, battle, fighter, battleArt)
        pageUi.print(lines.join('\n'), true)
        drawBattle(battleCanvas, battle, fighter, battleArt)
        pageUi.party([], 0)
        if (battle.over) finish('done')
        else refresh()
      }
      const onClick = (event: MouseEvent): void => {
        if (finished || openMenu) return
        const rect = battleCanvas.getBoundingClientRect()
        const scaleX = battleCanvas.width / rect.width
        const scaleY = battleCanvas.height / rect.height
        const view = viewport(battle, fighter)
        const x = view.x + Math.floor(((event.clientX - rect.left) * scaleX) / SQUARE)
        const y = view.y + Math.floor(((event.clientY - rect.top) * scaleY) / SQUARE)
        const foe = battle.at(x, y)
        if (foe && foe.side !== fighter.side) {
          if (battle.neighbours(fighter).includes(foe)) void pick('WHOM?', [foe])
          else if (battle.inRange(fighter).includes(foe)) void pick('AT WHOM?', [foe])
          return
        }
        const path = battle.reachable(fighter).get(`${x},${y}`)
        if (path) {
          battle.walk(fighter, path)
          refresh()
        }
      }
      battleCanvas.addEventListener('click', onClick)
      const finishWas = finish
      const finishAndDetach = (how: 'done' | 'run'): void => {
        battleCanvas.removeEventListener('click', onClick)
        finishWas(how)
      }
      openTurn = { battle, fighter, refresh, finish: finishAndDetach }
      refresh()
    })
  },

  battleEnd() {
    openTurn = undefined
    battleArt = undefined
    battlePanel.classList.remove('shown')
  },

  party(members: readonly Member[], selected: number) {
    if (members.length === 0) {
      if (session) members = session.roster.members
      if (members.length === 0) {
        partyPanel.classList.remove('shown')
        return
      }
    }
    const rows = members.map(({ character: c }, index) => {
      const row = document.createElement('div')
      row.className = 'member'
      if (index === selected) row.classList.add('picked')
      if (c.status !== 'okay') row.classList.add('down')
      else if (c.hpCurrent < c.hpMax) row.classList.add('hurt')
      const name = document.createElement('div'); name.className = 'name'; name.textContent = c.name
      const cls = document.createElement('div'); cls.className = 'cls'
      cls.textContent = `${className(c).split('/').map((part) => part.slice(0, 2).toUpperCase()).join('/')} ${characterLevel(c)}`
      const bar = document.createElement('div'); bar.className = 'bar'
      const fill = document.createElement('i'); fill.style.width = `${Math.max(0, Math.min(100, (100 * c.hpCurrent) / Math.max(1, c.hpMax)))}%`
      bar.append(fill)
      const hp = document.createElement('div'); hp.className = 'hp'
      hp.textContent = `${c.hpCurrent}/${c.hpMax}`
      if (c.status !== 'okay') { const badge = document.createElement('span'); badge.className = 'badge bad'; badge.textContent = STATUS_SHORT[c.status] ?? c.status.toUpperCase(); hp.append(badge) }
      const tags = document.createElement('div'); tags.className = 'tags'
      tags.textContent = `AC ${c.ac}${c.memorised.length > 0 ? ` · ${c.memorised.length}✦` : ''}`
      row.append(name, cls, bar, hp, tags)
      row.title = 'View this character'
      row.addEventListener('click', () => { void openSheet(index) })
      return row
    })
    partyPanel.replaceChildren(...rows)
    partyPanel.classList.add('shown')
  },

  who(prompt: string, members: readonly Member[]) {
    return pageUi.menu(prompt || 'WHO?', members.map((m) => m.character.name), 'vertical')
  },

  files(files) {
    // One download per file: the browser's own save dialog, nothing leaves the machine.
    for (const file of files) {
      const url = URL.createObjectURL(new Blob([file.bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' }))
      const link = document.createElement('a')
      link.href = url
      link.download = file.name
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    }
  },

  saved() {
    if (!session) return
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(session.snapshot()))
      continueButton.hidden = false
      pageUi.print('THE GAME IS SAVED IN THIS BROWSER.', true)
    } catch (error) {
      pageUi.print('THE GAME COULD NOT BE SAVED HERE.', true)
      note(`save failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  },

  note,
}

function note(message: string): void {
  notes.textContent = message
  console.info('[script]', message)
}

function askText(kind: 'number' | 'text'): Promise<string> {
  return new Promise((resolve) => {
    clearMenu()
    textPanel.classList.add('shown')
    const input = document.createElement('input')
    input.type = kind === 'number' ? 'number' : 'text'
    input.maxLength = kind === 'number' ? 5 : 40
    const done = document.createElement('button')
    done.textContent = 'OK'
    const finish = (): void => {
      const value = input.value
      clearMenu()
      resolve(value)
    }
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') finish()
      event.stopPropagation()
    })
    done.addEventListener('click', finish)
    menuBox.replaceChildren(input, done)
    input.focus()
  })
}

// ---- entering and walking -----------------------------------------------------

async function enterLevel(): Promise<void> {
  const lib = library
  const ref = levels[Number(levelSelect.value)]
  if (!lib || !ref) return
  const session = await openPlayScreen(lib)
  await session.enterLevel(ref)
}

/** Starts from the saved game the original shipped: the party's first square in the Slums. */
async function newGame(): Promise<void> {
  const lib = library
  if (!lib) return
  const saved = await lib.savedGame('A')
  if (!saved) {
    setStatus('No SAVGAMA.DAT in that folder, so there is no starting game to load. Explore a level instead.', true)
    return
  }
  const session = await openPlayScreen(lib)
  // Any other DOS save in the folder — the original's, or one this program exported.
  const others = lib.savedGameLetters().filter((l) => l !== 'A')
  const how = await pageUi.menu('A NEW GAME.', ['USE THE PRE-MADE PARTY', 'CREATE A PARTY', ...others.map((l) => `LOAD GAME ${l}`)], 'horizontal')
  if (how >= 2) {
    const other = await lib.savedGame(others[how - 2]!)
    if (other) { await session.resume(other); return }
  }
  const members = how === 1 ? await session.createParty() : undefined
  await session.resume(saved, members && members.length > 0 ? members : undefined)
}

async function continueGame(): Promise<void> {
  const lib = library
  const snapshot = storedSnapshot()
  if (!lib || !snapshot) return
  const session = await openPlayScreen(lib)
  await session.load(snapshot)
}

async function openPlayScreen(lib: GameLibrary): Promise<GameSession> {
  setStatus('Building the level…')
  startScreen.style.display = 'none'
  playScreen.classList.add('shown')
  textLog.textContent = ''
  clearMenu()
  textPanel.classList.remove('shown')
  picCanvas.classList.remove('shown')
  hideSprite()
  partyPanel.classList.remove('shown')
  notes.textContent = ''

  viewer?.dispose()
  viewer = new DungeonViewer(viewCanvas, {
    onMove: (state) => refreshHud(state),
    onBlocked: (state) => refreshHud(state),
  })
  viewer.resize()
  viewer.start()

  overlandArt = undefined
  // Nothing of the last game shows while the new one is chosen.
  partyPanel.classList.remove('shown')
  levelName.textContent = ''
  whereLine.textContent = ''
  clockLine.textContent = ''
  mapCanvas.getContext('2d')?.clearRect(0, 0, mapCanvas.width, mapCanvas.height)
  session = new GameSession(lib, pageUi)
  // Reachable from the console in development, for poking at the running game.
  if (import.meta.env.DEV) (window as unknown as { gbg?: unknown }).gbg = { session, library: lib }
  return session
}

/** The wilderness art, loaded once per folder. */
let overlandArt: { map: OverlandMap | undefined; tiles: readonly Rgba[]; rider: Rgba | undefined } | undefined
async function loadOverlandArt(current: GameSession): Promise<void> {
  const lib = library
  if (!lib || overlandArt) return
  const [map, tiles, rider] = await Promise.all([current.overland(), lib.overlandTiles(), lib.ridingIcon(0)])
  overlandArt = { map, tiles, rider }
  if (session === current) refreshHud(current.party)
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

function refreshHud(state: PartyState): void {
  if (!currentMap) return
  drawMinimap(mapCanvas, currentMap, state)
  // Outdoors the map itself is the view.
  if (session?.overhead) {
    if (!overlandArt) void loadOverlandArt(session)
    const { worldX, y } = session.overlandPosition
    if (overlandArt?.map) drawOverland(overheadCanvas, overlandArt.map, overlandArt.tiles, overlandArt.rider, worldX, y)
    overheadCanvas.classList.add('shown')
  } else {
    overheadCanvas.classList.remove('shown')
  }
  // Outdoors there is no dungeon to look down or to map.
  viewCanvas.style.visibility = session?.overhead ? 'hidden' : ''
  mapCanvas.style.visibility = session?.overhead ? 'hidden' : ''

  const cell = currentMap.cells[state.row * 16 + state.col]
  if (session?.overhead) {
    const { worldX, y, facing } = session.overlandPosition
    whereLine.textContent = `${worldX},${y} · ${COMPASS[facing]}`
    levelName.textContent = 'The Wilderness'
  } else {
    if (levelName.textContent === 'The Wilderness' && currentMap) levelName.textContent = mapName(library?.game.id ?? 'unknown', currentMap.id)

    whereLine.textContent =
      `${state.row},${state.col} · ${state.facing}` +
      (cell && cell.event !== 0 ? ` · event ${cell.event}` : '')
  }

  if (session) {
    const { day, hour, minute } = session.time
    const gold = session.roster.members.reduce((n, m) => n + (m.character.money[3] ?? 0), 0)
    clockLine.textContent = `Day ${day} · ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} · ${gold} gold`
    const eighth = session.overhead ? session.overlandPosition.facing : DIRECTIONS.indexOf(state.facing) * 2
    needle.style.transform = `rotate(${eighth * 45}deg)`
    playScreen.classList.toggle('outdoors', session.overhead)
    searchButton.classList.toggle('on', session.searching)
  }
}

function leaveLevel(): void {
  viewer?.stop()
  session = undefined
  continueButton.hidden = storedSnapshot() === undefined
  playScreen.classList.remove('shown')
  startScreen.style.display = 'grid'
}

/** A character's sheet in an overlay, with the way to the equipment menu. */
async function openSheet(index: number): Promise<void> {
  const current = session
  if (!current || current.busy || openMenu) return
  sheetText.textContent = await current.sheet(index)
  showOverlay(sheetOverlay)
  el('sheetEquip').onclick = () => { closeOverlays(); void current.equip(index) }
}

/** A movement command from a key or a pad button. */
function doMove(command: MoveCommand): void {
  if (!session || session.busy || openMenu || openOverlay) return
  // Outdoors the same commands ride: turns swing the compass, steps take an hour a square.
  if (session.overhead) { void session.move(command); return }
  // One step at a time: the viewer animates each, and the session stays in step with it.
  if (viewer?.isMoving) return
  // The session moves the party and runs the script; the viewer animates the same step.
  void session.move(command)
  viewer?.command(command)
}

function doAction(action: string): void {
  if (action === 'log') { logText.textContent = history.join('\n\n'); showOverlay(logOverlay); logText.parentElement!.scrollTop = 1e9; return }
  if (action === 'keys') { showOverlay(keysOverlay); return }
  if (!session || session.busy || openMenu || openOverlay) return
  const current = session
  if (action === 'camp') void current.camp()
  else if (action === 'view') void pageUi.who('VIEW WHO?', current.roster.members).then((index) => openSheet(index))
  else if (action === 'search') { void current.toggleSearch().then(() => refreshHud(current.party)) }
  else if (action === 'look') void current.look()
}

for (const button of document.querySelectorAll<HTMLButtonElement>('#pad4 button[data-cmd]')) {
  button.addEventListener('click', () => doMove(button.dataset.cmd as MoveCommand))
}
for (const button of document.querySelectorAll<HTMLButtonElement>('#pad8 button[data-dir]')) {
  button.addEventListener('click', () => { if (session && !session.busy && !openMenu && session.overhead) void session.moveOverland(Number(button.dataset.dir)) })
}
for (const button of document.querySelectorAll<HTMLButtonElement>('#actions button[data-act]')) {
  button.addEventListener('click', () => doAction(button.dataset.act!))
}
for (const id of ['sheetDone', 'logDone', 'keysDone']) el(id).addEventListener('click', closeOverlays)
for (const overlay of [sheetOverlay, logOverlay, keysOverlay]) overlay.addEventListener('click', (event) => { if (event.target === overlay) closeOverlays() })
// The stage changes size as the text box grows; the view keeps up.
new ResizeObserver(() => viewer?.resize()).observe(el('stage'))

// ---- input ---------------------------------------------------------------

const KEY_COMMANDS: Record<string, MoveCommand> = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', KeyD: 'right',
  KeyQ: 'turnLeft', ArrowLeft: 'turnLeft',
  KeyE: 'turnRight', ArrowRight: 'turnRight',
  KeyX: 'turnAround',
}

window.addEventListener('keydown', (event) => {
  if (openMenu && (event.code === 'KeyN' || event.code === 'KeyP') && openMenu.items.includes('NEXT PAGE')) {
    openMenu.choose(openMenu.items.indexOf(event.code === 'KeyN' ? 'NEXT PAGE' : 'PREV PAGE'))
    event.preventDefault()
    return
  }
  if (!playScreen.classList.contains('shown')) return
  // An overlay swallows the keys but Escape and Enter.
  if (openOverlay) { if (event.key === 'Escape' || event.key === 'Enter') { event.preventDefault(); closeOverlays() } return }

  if (openTurn && !openMenu) {
    const { battle, fighter, refresh } = openTurn
    const steps: Record<string, { dx: number; dy: number }> = {
      ArrowUp: BATTLE_STEPS.north, ArrowDown: BATTLE_STEPS.south, ArrowLeft: BATTLE_STEPS.west, ArrowRight: BATTLE_STEPS.east,
      KeyW: BATTLE_STEPS.north, KeyS: BATTLE_STEPS.south, KeyA: BATTLE_STEPS.west, KeyD: BATTLE_STEPS.east,
      KeyQ: { dx: -1, dy: -1 }, KeyZ: { dx: -1, dy: 1 }, Numpad7: { dx: -1, dy: -1 }, Numpad9: { dx: 1, dy: -1 },
      Numpad1: { dx: -1, dy: 1 }, Numpad3: { dx: 1, dy: 1 }, PageUp: { dx: 1, dy: -1 }, PageDown: { dx: 1, dy: 1 },
    }
    const step = steps[event.code]
    if (step) {
      event.preventDefault()
      if (battle.move(fighter, step)) refresh()
      return
    }
    const hotkeys: Record<string, string> = { KeyF: 'ATTACK', KeyX: 'SHOOT', KeyC: 'CAST', KeyU: 'USE', KeyT: 'TURN', KeyB: 'BANDAGE', KeyE: 'END TURN', KeyR: 'RUN' }
    if (event.code === 'KeyX' && !event.shiftKey) {
      // X is a diagonal step down-right; shift-X shoots.
      event.preventDefault()
      if (battle.move(fighter, { dx: 1, dy: 1 })) refresh()
      return
    }
    const wanted = hotkeys[event.code]
    if (wanted) {
      event.preventDefault()
      const button = [...battleActions.querySelectorAll('button')].find((b) => b.textContent?.endsWith(wanted))
      if (button && !button.disabled) button.click()
      return
    }
  }

  if (openMenu) {
    const menu = openMenu
    if (event.key === 'Enter' && menu.items.length === 1) {
      event.preventDefault()
      menu.choose(0)
    } else if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1
      if (index < menu.items.length) {
        event.preventDefault()
        menu.choose(index)
      }
    }
    return
  }

  if (event.code === 'KeyV' && session && !session.busy) {
    event.preventDefault()
    const current = session
    void pageUi.who('VIEW WHO?', current.roster.members).then((index) => openSheet(index))
    return
  }

  const action = ({ KeyF: 'search', KeyL: 'look', KeyC: 'camp', Slash: 'keys' } as Record<string, string>)[event.code]
  if (action && session && !session.busy) {
    event.preventDefault()
    doAction(action)
    return
  }

  const command = KEY_COMMANDS[event.code]
  if (!command || !session || session.busy) return
  event.preventDefault()
  doMove(command)
})

window.addEventListener('resize', () => viewer?.resize())

// ---- folder choosing -----------------------------------------------------

el('pick').addEventListener('click', async () => {
  if (supportsDirectoryPicker()) {
    try {
      const source = await pickDirectory()
      if (source) await useSource(source)
    } catch (error) {
      // An abort is the player changing their mind, not a failure worth reporting.
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setStatus(`Could not open that folder: ${error instanceof Error ? error.message : String(error)}`, true)
      }
    }
  } else {
    el<HTMLInputElement>('fileInput').click()
  }
})

el('pickFallback').addEventListener('click', () => el<HTMLInputElement>('filesInput').click())

for (const id of ['fileInput', 'filesInput']) {
  el<HTMLInputElement>(id).addEventListener('change', async (event) => {
    const input = event.target as HTMLInputElement
    const files = [...(input.files ?? [])]
    if (files.length > 0) await useSource(sourceFromFiles(files))
  })
}

dropZone.addEventListener('dragover', (event) => {
  event.preventDefault()
  dropZone.classList.add('over')
})
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'))
dropZone.addEventListener('drop', async (event) => {
  event.preventDefault()
  dropZone.classList.remove('over')
  const files = await filesFromDrop(event)
  if (files.length > 0) await useSource(sourceFromFiles(files))
})

/** Walks a dropped folder, since a drop gives entries rather than a file list. */
async function filesFromDrop(event: DragEvent): Promise<File[]> {
  const items = [...(event.dataTransfer?.items ?? [])]
  const entries = items
    .map((item) => (item as DataTransferItem & { webkitGetAsEntry?(): FileSystemEntry | null }).webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => Boolean(entry))

  if (entries.length === 0) return [...(event.dataTransfer?.files ?? [])]

  const files: File[] = []
  for (const entry of entries) await collectEntry(entry, files)
  return files
}

async function collectEntry(entry: FileSystemEntry, into: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File | undefined>((resolve) =>
      (entry as FileSystemFileEntry).file(resolve, () => resolve(undefined)))
    if (file) into.push(file)
    return
  }
  if (!entry.isDirectory) return

  const reader = (entry as FileSystemDirectoryEntry).createReader()
  // readEntries returns at most 100 at a time, so keep asking until it stops.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) =>
      reader.readEntries((results) => resolve(results), () => resolve([])))
    if (batch.length === 0) break
    for (const child of batch) await collectEntry(child, into)
  }
}

el('enter').addEventListener('click', () => void enterLevel())
el('newGame').addEventListener('click', () => void newGame())
continueButton.addEventListener('click', () => void continueGame())
el('back').addEventListener('click', leaveLevel)

// Dev server with GOLDBOX_DATA set: load that folder straight away.
void devDataSource().then(async (dev) => {
  if (!dev) return
  await useSource(dev.source)
  if (library && library.game.id !== 'unknown') {
    setStatus(`${statusLine.textContent}  (dev folder: ${dev.folder})`)
  }
})
