/**
 * Wires the page together: pick a folder, choose a level, walk around in it.
 */

import { GameLibrary, type FileSource, type LevelEvents, type LevelRef } from '../formats/library.js'
import type { GeoMap } from '../formats/geo.js'
import { DungeonViewer } from '../render/viewer.js'
import type { PartyState } from '../engine/party.js'
import { pickDirectory, sourceFromFiles, supportsDirectoryPicker } from './files.js'
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
const levelName = el('levelName')
const dropZone = el('drop')
const eventPanel = el('event')
const eventTitle = el('eventTitle')
const eventText = el('eventText')
const eventTags = el('eventTags')

let library: GameLibrary | undefined
let levels: LevelRef[] = []
let viewer: DungeonViewer | undefined
let currentMap: GeoMap | undefined
let currentEvents: LevelEvents | undefined

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
  } catch (error) {
    setStatus(`Could not read that folder: ${error instanceof Error ? error.message : String(error)}`, true)
  }
}

async function enterLevel(): Promise<void> {
  const lib = library
  const ref = levels[Number(levelSelect.value)]
  if (!lib || !ref) return

  setStatus('Building the level…')
  const map = await lib.level(ref)
  if (!map) {
    setStatus('That level would not load.', true)
    return
  }

  const wallSet = await lib.wallSetFor(ref)
  if (wallSet.textures.length === 0) {
    warnings.textContent =
      'No wall graphics were found for this level, so the walls are plain stone. ' +
      'The layout is still exactly what the data says.'
  }

  currentEvents = await lib.eventsFor(ref)
  currentMap = map
  levelName.textContent = ref.name
  startScreen.style.display = 'none'
  playScreen.style.display = 'block'

  viewer?.dispose()
  viewer = new DungeonViewer(viewCanvas, {
    onMove: (state) => refreshHud(state),
    onBlocked: (state) => refreshHud(state),
  })
  viewer.resize()
  viewer.load(map, wallSet.textures)
  viewer.start()
  refreshHud(viewer.state)
}

function refreshHud(state: PartyState): void {
  if (!currentMap) return
  drawMinimap(mapCanvas, currentMap, state)

  const cell = currentMap.cells[state.row * 16 + state.col]
  whereLine.textContent =
    `${state.row},${state.col} · ${state.facing}` +
    (cell && cell.event !== 0 ? ` · event ${cell.event}` : '')

  showEvent(cell?.event ?? 0)
}

/**
 * What the level's script has to say about the square the party is standing on.
 *
 * The script is read, not run, so this is what the event *can* say — every branch of
 * it. Running it would need the party, the clock and the flags it tests against.
 */
function showEvent(event: number): void {
  const summary = event === 0 ? undefined : currentEvents?.summaries.get(event)
  if (!summary || (summary.text.length === 0 && !summary.fights)) {
    eventPanel.classList.remove('shown')
    return
  }

  eventTitle.textContent = `Event ${event}`
  eventText.textContent = summary.text.join('\n')

  // Words rather than a glyph: symbols like a crossed-swords emoji fall back to
  // whatever the machine has, and "can start a fight" always renders.
  const tags: string[] = []
  if (summary.fights) tags.push('can start a fight')
  if (summary.text.length > 1) tags.push('every branch shown')
  eventTags.textContent = tags.join(' · ')

  eventPanel.classList.add('shown')
}

function leaveLevel(): void {
  eventPanel.classList.remove('shown')
  viewer?.stop()
  playScreen.style.display = 'none'
  startScreen.style.display = 'grid'
}

// ---- input ---------------------------------------------------------------

const KEY_COMMANDS: Record<string, Parameters<DungeonViewer['command']>[0]> = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', KeyD: 'right',
  KeyQ: 'turnLeft', ArrowLeft: 'turnLeft',
  KeyE: 'turnRight', ArrowRight: 'turnRight',
  KeyX: 'turnAround',
}

window.addEventListener('keydown', (event) => {
  if (playScreen.style.display !== 'block') return
  const command = KEY_COMMANDS[event.code]
  if (!command) return
  event.preventDefault()
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
el('back').addEventListener('click', leaveLevel)
