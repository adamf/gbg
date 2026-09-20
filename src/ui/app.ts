/**
 * Wires the page together: pick a folder, choose a level, walk around in it, and
 * let the level's script talk back.
 */

import { GameLibrary, type FileSource, type LevelRef } from '../formats/library.js'
import type { Rgba } from '../formats/ega.js'
import type { GeoMap } from '../formats/geo.js'
import { DungeonViewer } from '../render/viewer.js'
import type { PartyState } from '../engine/party.js'
import { GameSession, type MoveCommand, type SessionUi, type Snapshot } from '../engine/session.js'
import type { CombatOutcome, EncounterView, MonsterGroup } from '../engine/ecl-vm.js'
import type { Member } from '../engine/roster.js'
import type { Combatant } from '../engine/combat.js'
import { BATTLE_STEPS, type Battle, type Fighter } from '../engine/battle.js'
import { drawBattle } from './battle-view.js'
import { className, characterLevel } from '../formats/character.js'
import { devDataSource, pickDirectory, sourceFromFiles, supportsDirectoryPicker } from './files.js'
import { drawMinimap } from './minimap.js'

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
const battleCanvas = el<HTMLCanvasElement>('battleMap')
const battleActions = el('battleActions')

/** The player's turn in a battle, so keys can move the fighter. */
let openTurn: { battle: Battle; fighter: Fighter; refresh(): void } | undefined
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
    // The original appended text to the same line; a printed number is part of a sentence.
    textLog.textContent += text
    textPanel.classList.add('shown')
    textLog.scrollTop = textLog.scrollHeight
  },

  newLine() {
    textLog.textContent += '\n'
  },

  menu(prompt, items, layout) {
    return new Promise((resolve) => {
      clearMenu()
      textPanel.classList.add('shown')
      menuPrompt.textContent = prompt ?? ''
      menuBox.className = layout
      const choose = (index: number): void => {
        clearMenu()
        resolve(index)
      }
      items.forEach((item, index) => {
        const button = document.createElement('button')
        const key = document.createElement('kbd')
        key.textContent = items.length === 1 ? '⏎' : String(index + 1)
        button.append(key, item)
        button.addEventListener('click', () => choose(index))
        menuBox.append(button)
      })
      openMenu = { items, choose }
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

  async battleUpdate(battle, lines) {
    battlePanel.classList.add('shown')
    battleActions.replaceChildren()
    drawBattle(battleCanvas, battle, battle.current)
    if (lines.length > 0) {
      pageUi.print(lines.join('\n'), true)
      await wait(Math.min(1200, 250 + lines.length * 250))
    }
  },

  battleTurn(battle, fighter, cast) {
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
        drawBattle(battleCanvas, battle, fighter)
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
        button('X', 'SHOOT', far.length > 0 && !fighter.acted, () => void pick('AT WHOM?', far))
        button('C', 'CAST', fighter.combatant.member.character.memorised.length > 0 && !fighter.acted, () => {
          void cast().then((lines) => {
            if (lines.length > 0) pageUi.print(lines.join('\n'), true)
            refresh()
          })
        })
        button('E', 'END TURN', true, () => finish('done'))
        button('R', 'RUN', true, () => finish('run'))
        pageUi.print(`${label}'S TURN. ${fighter.moves} MOVE${fighter.moves === 1 ? '' : 'S'} LEFT. ARROWS MOVE, F ATTACK, X SHOOT, C CAST, E END.`, true)
      }
      const pick = async (prompt: string, targets: Fighter[]): Promise<void> => {
        const at = targets.length === 1 ? 0 : await pageUi.menu(prompt, targets.map((t) => t.combatant.label), 'vertical')
        const target = targets[at]
        if (!target) return
        const lines = battle.attack(fighter, target)
        pageUi.print(lines.join('\n'), true)
        drawBattle(battleCanvas, battle, fighter)
        pageUi.party([], 0)
        if (battle.over) finish('done')
        else refresh()
      }
      openTurn = { battle, fighter, refresh }
      refresh()
    })
  },

  battleEnd() {
    openTurn = undefined
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
    const table = document.createElement('table')
    members.forEach(({ character: c }, index) => {
      const row = document.createElement('tr')
      if (index === selected) row.classList.add('picked')
      if (c.status !== 'okay') row.classList.add('down')
      else if (c.hpCurrent < c.hpMax) row.classList.add('hurt')
      const cells: [string, string][] = [
        ['n', c.name],
        ['r', `${className(c).split('/').map((part) => part.slice(0, 2).toUpperCase()).join('/')} ${characterLevel(c)}`],
        ['r hp', c.status === 'okay' ? `${c.hpCurrent}/${c.hpMax}` : c.status.toUpperCase()],
        ['r', c.memorised.length > 0 ? `${c.memorised.length}✦ AC ${c.ac}` : `AC ${c.ac}`],
      ]
      for (const [cls, text] of cells) {
        const cell = document.createElement('td')
        cell.className = cls
        cell.textContent = text
        row.append(cell)
      }
      table.append(row)
    })
    partyPanel.replaceChildren(table)
    partyPanel.classList.add('shown')
  },

  who(prompt: string, members: readonly Member[]) {
    return pageUi.menu(prompt || 'WHO?', members.map((m) => m.character.name), 'vertical')
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
  const how = await pageUi.menu('A NEW GAME.', ['USE THE PRE-MADE PARTY', 'CREATE A PARTY'], 'horizontal')
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
  playScreen.style.display = 'block'
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

  session = new GameSession(lib, pageUi)
  // Reachable from the console in development, for poking at the running game.
  if (import.meta.env.DEV) (window as unknown as { gbg?: unknown }).gbg = { session, library: lib }
  return session
}

function refreshHud(state: PartyState): void {
  if (!currentMap) return
  drawMinimap(mapCanvas, currentMap, state)

  const cell = currentMap.cells[state.row * 16 + state.col]
  whereLine.textContent =
    `${state.row},${state.col} · ${state.facing}` +
    (cell && cell.event !== 0 ? ` · event ${cell.event}` : '')

  if (session) {
    const { hour, minute } = session.time
    const gold = session.roster.members.reduce((n, m) => n + (m.character.money[3] ?? 0), 0)
    clockLine.textContent = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}${session.searching ? ' · SEARCHING' : ''} · ${gold} gold`
  }
}

function leaveLevel(): void {
  viewer?.stop()
  session = undefined
  continueButton.hidden = storedSnapshot() === undefined
  playScreen.style.display = 'none'
  startScreen.style.display = 'grid'
}

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
  if (playScreen.style.display !== 'block') return

  if (openTurn && !openMenu) {
    const { battle, fighter, refresh } = openTurn
    const steps: Record<string, { dx: number; dy: number }> = {
      ArrowUp: BATTLE_STEPS.north, ArrowDown: BATTLE_STEPS.south, ArrowLeft: BATTLE_STEPS.west, ArrowRight: BATTLE_STEPS.east,
      KeyW: BATTLE_STEPS.north, KeyS: BATTLE_STEPS.south, KeyA: BATTLE_STEPS.west, KeyD: BATTLE_STEPS.east,
    }
    const step = steps[event.code]
    if (step) {
      event.preventDefault()
      if (battle.move(fighter, step)) refresh()
      return
    }
    const hotkeys: Record<string, string> = { KeyF: 'ATTACK', KeyX: 'SHOOT', KeyC: 'CAST', KeyE: 'END TURN', KeyR: 'RUN' }
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
    void pageUi.who('VIEW WHO?', current.roster.members).then(async (index) => {
      pageUi.print(await current.sheet(index), true)
      const next = await pageUi.menu(undefined, ['EQUIP', 'DONE'], 'horizontal')
      if (next === 0) await current.equip(index)
    })
    return
  }

  if (event.code === 'KeyF' && session && !session.busy) {
    event.preventDefault()
    session.toggleSearch()
    refreshHud(session.party)
    return
  }

  if (event.code === 'KeyL' && session && !session.busy) {
    event.preventDefault()
    void session.look()
    return
  }

  if (event.code === 'KeyC' && session && !session.busy) {
    event.preventDefault()
    void session.camp()
    return
  }

  const command = KEY_COMMANDS[event.code]
  if (!command || !session || session.busy) return
  event.preventDefault()
  // One step at a time: the viewer animates each, and the session stays in step with it.
  if (viewer?.isMoving) return

  // The session moves the party and runs the script; the viewer animates the same step.
  void session.move(command)
  viewer?.command(command)
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
