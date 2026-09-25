import '@fontsource/cinzel/400.css'
import '@fontsource/cinzel/500.css'
import '@fontsource/cinzel-decorative/400.css'
import '@fontsource/im-fell-english/400.css'
import '@fontsource/im-fell-english/400-italic.css'
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
import { type Overlay, drawBattle, playEffects, SQUARE, viewport, type BattleArt } from './battle-view.js'
import { className, characterLevel } from '../formats/character.js'
import { devDataSource, pickDirectory, sourceFromFiles, supportsDirectoryPicker } from './files.js'
import { mapName } from '../formats/detect.js'
import { drawMinimap } from './minimap.js'
import { deleteSlot, listSlots, readSlot, writeSlot, type SlotMeta } from './saves.js'
import { play, setSound, soundOn } from './sound.js'
import type { CreateKey, CreateView } from '../engine/session.js'
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
/** True while a spell is being aimed on the field, so the turn's own clicks wait. */
let aiming = false
/** The original's own abbreviations for the party panel. */
const STATUS_SHORT: Record<string, string> = { unconscious: 'UNCON', dying: 'DYING', dead: 'DEAD', asleep: 'SLEEP', held: 'HELD', stoned: 'STONE', running: 'FLED', animated: 'ANIM', gone: 'GONE', 'temporarily gone': 'GONE' }
const battleInfo = el('battleInfo')
const needle = el('needle')
const sheetOverlay = el('sheet')
const sheetBody = el('sheetBody')
const bookOverlay = el('book')
const bookBody = el('bookBody')
const tip = el('tip')
const turns = el('turns')
const shopOverlay = el('shop')
const hallOverlay = el('hall')
const campOverlay = el('camp')
const createOverlay = el('create')
const savesOverlay = el('saves')
const endingOverlay = el('ending')
const soundButton = el('soundButton')
soundButton.classList.toggle('on', soundOn())
const logOverlay = el('log')
const logText = el('logText')
const keysOverlay = el('keys')
const searchButton = el('searchButton')
/** Whichever overlay is up, so the keys go to it. */
let openOverlay: HTMLElement | undefined
const ALL_OVERLAYS = (): HTMLElement[] => [sheetOverlay, bookOverlay, logOverlay, keysOverlay, shopOverlay, hallOverlay, campOverlay, createOverlay, savesOverlay, endingOverlay]
/** Shows one overlay in place of any other, without telling the others they were closed. */
function showOverlay(which: HTMLElement): void { for (const o of ALL_OVERLAYS()) o.classList.remove('shown'); which.classList.add('shown'); openOverlay = which }
/** Closes whatever is up and tells its panel so. */
function closeOverlays(): void { for (const o of ALL_OVERLAYS()) o.classList.remove('shown'); openOverlay = undefined; const closers = [bookClosed, shopClosed, hallClosed, campClosed, createClosed, savesClosed, endingClosed]; bookClosed = shopClosed = hallClosed = campClosed = createClosed = savesClosed = endingClosed = undefined; for (const closer of closers) closer?.() }
let createClosed: (() => void) | undefined
let savesClosed: (() => void) | undefined
let endingClosed: (() => void) | undefined
let hallClosed: (() => void) | undefined
let campClosed: (() => void) | undefined
/** Resolves the shop panel's promise when it closes. */
let shopClosed: (() => void) | undefined
/** Resolves the memorisation panel's promise when it closes. */
let bookClosed: (() => void) | undefined
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


function storedSnapshot(): Snapshot | undefined {
  const [latest] = listSlots()
  return latest ? readSlot(latest.id) : undefined
}

/** What a save of the game now would say about itself, with the map as a small picture. */
function slotMetaNow(): Omit<SlotMeta, 'id' | 'savedAt'> {
  const current = session
  const time = current?.time ?? { day: 0, hour: 0, minute: 0 }
  let thumb: string | undefined
  try {
    const source = current?.overhead ? overheadCanvas : mapCanvas
    const small = document.createElement('canvas'); small.width = 96; small.height = 96
    const g = small.getContext('2d')!; g.imageSmoothingEnabled = false
    g.drawImage(source, 0, 0, source.width, source.height, 0, 0, 96, 96)
    thumb = small.toDataURL('image/png')
  } catch { thumb = undefined }
  return { where: levelName.textContent || 'Somewhere', day: time.day, hour: time.hour, minute: time.minute, party: current?.roster.members.map((m) => m.character.name) ?? [], thumb }
}

/**
 * The slot panel: every save with its picture, where it stands and who is in it.
 * In save mode a slot can be overwritten or a new one made; in load mode one is chosen.
 */
function openSaves(mode: 'save' | 'load'): Promise<Snapshot | undefined> {
  return new Promise((resolve) => {
    const words = el('savesWords')
    let done = false
    const finish = (value: Snapshot | undefined): void => { if (done) return; done = true; savesClosed = undefined; closeOverlays(); resolve(value) }
    const render = (): void => {
      const slots = listSlots()
      el('savesTitle').textContent = mode === 'save' ? 'SAVE THE GAME' : 'SAVED GAMES'
      el('savesNew').hidden = mode !== 'save'
      el('slots').replaceChildren(...(slots.length === 0 ? [Object.assign(document.createElement('span'), { className: 'spellLine', textContent: 'NO SAVED GAMES YET.' })] : slots.map((slot) => {
        const card = document.createElement('div'); card.className = 'slot'
        if (slot.thumb) { const img = document.createElement('img'); img.src = slot.thumb; img.alt = ''; card.append(img) } else card.append(Object.assign(document.createElement('div'), { className: 'blank' }))
        const body = document.createElement('div')
        const t = document.createElement('div'); t.className = 't'; t.textContent = `${slot.id}. ${slot.where}`
        const d = document.createElement('div'); d.className = 'd'
        d.textContent = `Day ${slot.day}, ${String(slot.hour).padStart(2, '0')}:${String(slot.minute).padStart(2, '0')} · ${slot.party.join(', ')}\nSaved ${new Date(slot.savedAt).toLocaleString()}`
        d.style.whiteSpace = 'pre-line'
        const acts = document.createElement('div'); acts.className = 'acts'
        const main = document.createElement('button'); main.className = 'primary'
        main.textContent = mode === 'save' ? 'Save here' : 'Load'
        main.addEventListener('click', () => {
          if (mode === 'load') { finish(readSlot(slot.id)); return }
          const written = session && writeSlot(slotMetaNow(), slot.id, session.snapshot())
          words.textContent = written ? `SAVED IN SLOT ${slot.id}.` : 'THE GAME COULD NOT BE SAVED HERE.'
          render()
        })
        const del = document.createElement('button'); del.textContent = 'Delete'
        del.addEventListener('click', () => { deleteSlot(slot.id); words.textContent = `SLOT ${slot.id} DELETED.`; render() })
        acts.append(main, del)
        body.append(t, d, acts)
        card.append(body)
        return card
      })))
      continueButton.hidden = slots.length === 0
    }
    el('savesNew').onclick = () => {
      const written = session && writeSlot(slotMetaNow(), undefined, session.snapshot())
      words.textContent = written ? `SAVED IN SLOT ${written.id}.` : 'THE GAME COULD NOT BE SAVED HERE.'
      render()
    }
    el('savesDone').onclick = () => finish(undefined)
    words.textContent = ''
    savesClosed = () => finish(undefined)
    render()
    showOverlay(savesOverlay)
  })
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
    if (/ IS DEAD| DIES!|THE PARTY HAS FALLEN/.test(text)) play('fall')
    else if (/THE PARTY RESTS/.test(text)) play('rest')
    else if (/SHOPKEEPER PAYS|SHARES? .*(GOLD|COPPER|SILVER|PLATINUM)|HERE IS YOUR REWARD/.test(text)) play('coins')
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
          play('menu')
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
    renderTurnStrip(battle)
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
        playScreen.classList.remove('turn')
        battleActions.replaceChildren()
        clearMenu()
        resolve(how)
      }
      const refresh = (keepText = false): void => {
        drawBattle(battleCanvas, battle, fighter, battleArt)
        renderTurnStrip(battle)
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
            refresh(lines.length > 0)
          })
        })
        button('U', 'USE', !fighter.acted, () => {
          void use().then((lines) => {
            if (lines.length > 0) pageUi.print(lines.join('\n'), true)
            if (battle.over) finish('done')
            else refresh(lines.length > 0)
          })
        })
        button('T', 'TURN', !fighter.acted && (fighter.combatant.member.character.levels[0] ?? 0) > 0 && battle.undead().length > 0, () => {
          const lines = battle.turnUndead(fighter)
          pageUi.print(lines.join('\n'), true)
          if (battle.over) finish('done')
          else refresh(true)
        })
        const bleeding = battle.dyingNeighbours(fighter)
        button('B', 'BANDAGE', bleeding.length > 0 && !fighter.acted, () => {
          void (async () => {
            const at = bleeding.length === 1 ? 0 : await pageUi.menu('WHOM?', bleeding.map((t) => t.combatant.label), 'vertical')
            const target = bleeding[at]
            if (!target) return
            pageUi.print(battle.bandage(fighter, target).join('\n'), true)
            refresh(true)
          })()
        })
        button('E', 'END TURN', true, () => (openTurn?.finish ?? finish)('done'))
        button('R', 'RUN', true, () => (openTurn?.finish ?? finish)('run'))
        if (!keepText) pageUi.print(`${label}'S TURN. ${fighter.moves} MOVE${fighter.moves === 1 ? '' : 'S'} LEFT. CLICK A SQUARE OR A FOE, OR USE THE PAD. F ATTACK, C CAST, E END.`, true)
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
        else refresh(true)
      }
      const onClick = (event: MouseEvent): void => {
        if (finished || openMenu || aiming) return
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
      playScreen.classList.add('turn')
      refresh()
    })
  },

  equip: (index) => openSheet(index),

  /** The closing pictures, each filling the screen, the words beneath, Next between them. */
  ending(pictures, words) {
    return new Promise<void>((resolve) => {
      const canvas = el<HTMLCanvasElement>('endingPic')
      const caption = el('endingWords')
      let at = 0
      // The original built its closing scene in layers: each block over the last, the
      // magenta key transparent, so the dragon lands in the frame and the walls close in.
      const show = (): void => {
        const first = pictures[0]
        if (!first) return
        if (at === 0) { canvas.width = first.width; canvas.height = first.height }
        const g = canvas.getContext('2d')
        const picture = pictures[at]
        if (g && picture) {
          const layer = document.createElement('canvas'); layer.width = picture.width; layer.height = picture.height
          const pixels = new Uint8ClampedArray(picture.pixels)
          for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 255 && pixels[i + 1] === 85 && pixels[i + 2] === 255) pixels[i + 3] = 0
          layer.getContext('2d')!.putImageData(new ImageData(pixels, picture.width, picture.height), 0, 0)
          if (at === 0) g.drawImage(layer, 0, 0)
          else g.drawImage(layer, Math.floor((canvas.width - picture.width) / 2), Math.floor((canvas.height - picture.height) / 2))
        }
        caption.textContent = at === 0 ? words[0] ?? '' : at >= pictures.length - 1 ? words[1] ?? '' : ''
        el('endingNext').textContent = at >= pictures.length - 1 ? 'The end' : 'Next'
      }
      el('endingNext').onclick = () => { if (at >= pictures.length - 1) { closeOverlays(); resolve(); return } at++; show() }
      endingClosed = resolve
      play('rest')
      show()
      showOverlay(endingOverlay)
    })
  },

  train(view) {
    return new Promise<void>((resolve) => {
      const words = el('hallWords')
      const render = (): void => {
        const purse = view.purse()
        el('hallRoster').replaceChildren(...view.members().map((m, who) => {
          const row = document.createElement('div'); row.className = 'who'
          const name = document.createElement('div'); name.className = 'n'; name.textContent = `${m.name} · ${m.gold} gold`
          const acts = document.createElement('div'); acts.className = 'acts'
          const detail = document.createElement('div'); detail.className = 'd'
          detail.textContent = m.tracks.map((t) => `${t.track.toUpperCase()} ${t.level}${t.level >= t.limit ? ' (AT THE RACE’S LIMIT)' : t.ready ? ' — READY' : Number.isFinite(t.needed) ? ` — ${t.needed} XP TO ${t.level + 1}` : ' (AT THE TOP OF THE TABLE)'}`).join(' · ')
          for (const t of m.tracks) {
            if (!t.ready) continue
            const b = document.createElement('button'); b.className = 'go'
            const alone = m.gold >= view.cost
            b.textContent = alone ? `Train as ${t.track} — ${view.cost} gold` : purse >= view.cost ? `Pool coins & train as ${t.track}` : `Train as ${t.track} — cannot pay`
            b.disabled = !alone && purse < view.cost
            b.addEventListener('click', () => { void view.train(who, t.track, !alone).then((said) => { words.textContent = said; render() }) })
            acts.append(b)
          }
          row.append(name, acts, detail)
          return row
        }))
      }
      el('hallDone').onclick = closeOverlays
      words.textContent = ''
      hallClosed = resolve
      render()
      showOverlay(hallOverlay)
    })
  },

  camp(view) {
    return new Promise<void>((resolve) => {
      const words = el('campWords')
      let open = true
      // An action that talks through the text box takes the panel down and puts it back after.
      const run = (work: () => Promise<'stay' | 'leave'>): void => {
        campOverlay.classList.remove('shown'); openOverlay = undefined
        void work().then((next) => {
          if (!open) return
          if (next === 'leave') { open = false; resolve(); return }
          render(); campOverlay.classList.add('shown'); openOverlay = campOverlay
        })
      }
      const render = (): void => {
        const state = view.state()
        el('campRoster').replaceChildren(...state.members.map((m, who) => {
          const row = document.createElement('div'); row.className = `who${m.status !== 'okay' ? ' down' : m.hp < m.hpMax ? ' hurt' : ''}`
          const name = document.createElement('div'); name.className = 'n'; name.textContent = m.name
          const acts = document.createElement('div'); acts.className = 'acts'
          if (m.caster) { const b = document.createElement('button'); b.textContent = `Memorise (${m.prepared}/${m.slots} chosen)`; b.addEventListener('click', () => run(() => view.memorise(who))); acts.append(b) }
          const pool = document.createElement('button'); pool.textContent = 'Pool coins here'; pool.addEventListener('click', () => run(() => view.pool(who))); acts.append(pool)
          const bar = document.createElement('div'); bar.className = 'bar'; const fill = document.createElement('i'); fill.style.width = `${Math.max(0, Math.min(100, (100 * m.hp) / Math.max(1, m.hpMax)))}%`; bar.append(fill)
          const detail = document.createElement('div'); detail.className = 'd'
          detail.textContent = `HP ${m.hp}/${m.hpMax} · ${m.status.toUpperCase()} · ${m.gold} gold${m.caster ? ` · ${m.memorised} of ${m.slots} spells memorised` : ''}`
          row.append(name, acts, bar, detail)
          return row
        }))
        const acts = el('campActs'); acts.replaceChildren()
        const button = (label: string, cls: string, work: () => Promise<'stay' | 'leave'>): void => { const b = document.createElement('button'); b.textContent = label; b.className = cls; b.addEventListener('click', () => run(work)); acts.append(b) }
        const days = Math.floor(state.hours / 24)
        button(`Rest ${days > 0 ? `${days} day${days === 1 ? '' : 's'}` : `${state.hours} hour${state.hours === 1 ? '' : 's'}`}`, 'primary', () => view.rest())
        button('Cast', '', () => view.cast())
        button('Use', '', () => view.use())
        button('Scribe', '', () => view.scribe())
        button('Save game', '', () => view.save())
        button('Export DOS save', '', () => view.exportDos())
      }
      el('campDone').onclick = () => { open = false; closeOverlays(); resolve() }
      words.textContent = ''
      campClosed = () => { if (open) { open = false; resolve() } }
      render()
      showOverlay(campOverlay)
    })
  },

  shop(view) {
    return new Promise<void>((resolve) => {
      const words = el('shopWords')
      let buyer = 0
      const render = async (): Promise<void> => {
        const [wares, members] = await Promise.all([view.wares(), view.members()])
        if (buyer >= members.length) buyer = 0
        el('buyers').replaceChildren(...members.map((m, i) => {
          const b = document.createElement('button')
          b.textContent = `${m.name} · ${m.gold} gold`
          if (i === buyer) b.classList.add('picked')
          b.addEventListener('click', () => { buyer = i; void render() })
          return b
        }))
        el('wares').replaceChildren(...(wares.length === 0 ? [Object.assign(document.createElement('span'), { textContent: 'NOTHING FOR SALE.', className: 'spellLine' })] : wares.map((w, i) => {
          const b = document.createElement('button')
          const price = document.createElement('b'); price.textContent = `${w.price} gold`
          b.append(w.label, price)
          b.addEventListener('click', () => { void view.buy(i, buyer).then((said) => { words.textContent = said; void render() }) })
          return b
        })))
        const me = members[buyer]
        el('packTitle').textContent = me ? `${me.name.toUpperCase()}'S PACK — CLICK TO SELL` : 'THE PACK'
        el('sellables').replaceChildren(...(!me || me.items.length === 0 ? [Object.assign(document.createElement('span'), { textContent: 'NOTHING TO SELL.', className: 'spellLine' })] : me.items.map((item, i) => {
          const b = document.createElement('button')
          if (item.readied) b.classList.add('readied')
          const price = document.createElement('b'); price.textContent = `${item.price} gold`
          b.append(`${item.readied ? '● ' : ''}${item.label}`, price)
          b.title = item.readied ? 'Readied; selling puts it down first' : 'Sell'
          b.addEventListener('click', () => { void view.sell(buyer, i).then((said) => { words.textContent = said; void render() }) })
          return b
        })))
      }
      el('shopAppraise').onclick = () => { void view.appraise(buyer).then((said) => { words.textContent = said; void render() }) }
      el('shopDone').onclick = closeOverlays
      words.textContent = ''
      shopClosed = resolve
      void render().then(() => showOverlay(shopOverlay))
    })
  },
  memorise: (index) => openBook(index),

  battleEnd() {
    openTurn = undefined
    battleArt = undefined
    battlePanel.classList.remove('shown')
  },

  /**
   * Aiming with the mouse: the blast follows the pointer over the field, squares out
   * of range are dimmed, and a click lands it; for a spell that picks fighters, each
   * click picks one. Escape, a right click or CANCEL gives the spell up.
   */
  aim(battle, caster, spell, choice) {
    return new Promise<Fighter[] | undefined>((resolve) => {
      const range = battle.reach(spell, caster)
      const picked: Fighter[] = []
      let hover: { x: number; y: number } | undefined
      const name = spell.name.toUpperCase()
      const squareAt = (event: MouseEvent): { x: number; y: number } => {
        const rect = battleCanvas.getBoundingClientRect()
        const view = viewport(battle, caster)
        return {
          x: view.x + Math.floor(((event.clientX - rect.left) * battleCanvas.width) / rect.width / SQUARE),
          y: view.y + Math.floor(((event.clientY - rect.top) * battleCanvas.height) / rect.height / SQUARE),
        }
      }
      const draw = (): void => {
        const overlays: Overlay[] = []
        if (range !== undefined && range < 12) {
          const reachable: { x: number; y: number }[] = []
          for (let y = Math.max(0, caster.y - range); y <= Math.min(battle.height - 1, caster.y + range); y++) {
            for (let x = Math.max(0, caster.x - range); x <= Math.min(battle.width - 1, caster.x + range); x++) reachable.push({ x, y })
          }
          overlays.push({ squares: reachable, fill: 'rgba(201, 162, 39, 0.10)' })
        }
        if (choice.kind === 'area' && hover) {
          const ok = battle.reaches(spell, caster, hover)
          overlays.push({ squares: battle.blast(spell, caster, hover), fill: ok ? 'rgba(255, 120, 30, 0.45)' : 'rgba(120, 120, 120, 0.4)', edge: ok ? '#ffb347' : '#777' })
        }
        if (choice.kind === 'fighters') {
          overlays.push({ squares: choice.among.map((f) => ({ x: f.x, y: f.y })), fill: 'rgba(255, 255, 255, 0.12)', edge: '#ffffff88' })
          if (hover) {
            const under = battle.at(hover.x, hover.y)
            if (under && choice.among.includes(under)) overlays.push({ squares: [hover], fill: 'rgba(255, 120, 30, 0.35)', edge: '#ffb347' })
          }
          overlays.push({ squares: picked.map((f) => ({ x: f.x, y: f.y })), fill: 'rgba(255, 80, 30, 0.45)', edge: '#ff5533' })
        }
        drawBattle(battleCanvas, battle, caster, battleArt, overlays)
      }
      const finish = (result: Fighter[] | undefined): void => {
        battleCanvas.removeEventListener('mousemove', onMove)
        battleCanvas.removeEventListener('click', onClick)
        battleCanvas.removeEventListener('contextmenu', onCancel)
        window.removeEventListener('keydown', onKey, true)
        battleCanvas.style.cursor = 'crosshair'
        aiming = false
        drawBattle(battleCanvas, battle, caster, battleArt)
        resolve(result)
      }
      const onMove = (event: MouseEvent): void => { hover = squareAt(event); draw() }
      const onClick = (event: MouseEvent): void => {
        const at = squareAt(event)
        if (choice.kind === 'area') {
          if (!battle.reaches(spell, caster, at)) { pageUi.print(`OUT OF RANGE: ${name} REACHES ${range} SQUARES.`, true); return }
          finish(battle.fightersIn(battle.blast(spell, caster, at)))
          return
        }
        const under = battle.at(at.x, at.y)
        if (!under || !choice.among.includes(under)) return
        if (picked.includes(under)) picked.splice(picked.indexOf(under), 1)
        else picked.push(under)
        if (picked.length >= choice.count) { finish(picked); return }
        pageUi.print(`${name}: ${picked.length} OF ${choice.count} PICKED. CLICK MORE, OR DONE.`, true)
        draw()
      }
      const onCancel = (event: Event): void => { event.preventDefault(); finish(undefined) }
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') { event.preventDefault(); finish(undefined) }
        if (event.key === 'Enter' && choice.kind === 'fighters' && picked.length > 0) { event.preventDefault(); finish(picked) }
      }
      aiming = true
      battleCanvas.style.cursor = 'cell'
      battleCanvas.addEventListener('mousemove', onMove)
      battleCanvas.addEventListener('click', onClick)
      battleCanvas.addEventListener('contextmenu', onCancel)
      window.addEventListener('keydown', onKey, true)
      battleActions.replaceChildren()
      const cancel = document.createElement('button')
      cancel.append('CANCEL')
      cancel.addEventListener('click', () => finish(undefined))
      battleActions.append(cancel)
      if (choice.kind === 'fighters' && choice.count > 1) {
        const done = document.createElement('button')
        done.append('DONE')
        done.addEventListener('click', () => finish(picked.length > 0 ? picked : undefined))
        battleActions.append(done)
      }
      const reach = range === undefined ? '' : ` (${range} SQUARES)`
      pageUi.print(choice.kind === 'area'
        ? `AIM ${name}${reach}: POINT AT A SQUARE AND CLICK. EVERYONE UNDER THE BLAST IS HIT.`
        : `${name}${reach}: CLICK ${choice.count > 1 ? `UP TO ${choice.count} TARGETS` : 'A TARGET'} ON THE FIELD.`, true)
      draw()
    })
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
    void openSaves('save')
  },

  /** Rolling a party by mouse, in the original's order: race, sex, class, alignment, then the dice, MODIFY, a name; a roster that fills up. */
  create(view: CreateView) {
    return new Promise<void>((resolve) => {
      let race = view.races[0]!
      let sex: 0 | 1 = 0
      let classIndex = view.classes(race)[0]!
      let alignment = view.alignmentsFor(classIndex)[0]!
      let draft = view.roll(race, sex, classIndex)
      const words = el('createWords')
      const choice = (host: HTMLElement, labels: string[], picked: number, onPick: (i: number) => void): void => {
        host.replaceChildren(...labels.map((label, i) => { const b = document.createElement('button'); b.textContent = label; if (i === picked) b.classList.add('picked'); b.addEventListener('click', () => onPick(i)); return b }))
      }
      const reroll = (): void => { draft = view.roll(race, sex, classIndex) }
      /** A small button that repeats while held, so a percentile can climb without a hundred clicks. */
      const nudge = (label: string, act: () => void): HTMLButtonElement => {
        const b = document.createElement('button'); b.textContent = label
        let timer: ReturnType<typeof setInterval> | undefined
        let delay: ReturnType<typeof setTimeout> | undefined
        const stop = (): void => { if (timer) clearInterval(timer); if (delay) clearTimeout(delay); timer = delay = undefined }
        b.addEventListener('pointerdown', (e) => { e.preventDefault(); stop(); act(); delay = setTimeout(() => { timer = setInterval(() => { if (b.disabled) stop(); else act() }, 45) }, 350) })
        for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, stop)
        return b
      }
      /** The dice and MODIFY only. The cells are built once and updated in place, so the panel never shifts and a held button stays under the pointer. */
      const keys: CreateKey[] = ['str', 'int', 'wis', 'dex', 'con', 'cha', 'hp']
      const cells = new Map<CreateKey, { v: HTMLSpanElement; down: HTMLButtonElement; up: HTMLButtonElement }>()
      const buildDice = (): void => {
        const statsHost = el('createStats'); statsHost.replaceChildren(); cells.clear()
        for (const key of keys) {
          const cell = document.createElement('div'); cell.className = 'stat'
          const b = document.createElement('b'); b.textContent = key.toUpperCase()
          const v = document.createElement('span'); v.className = 'v'
          const row = document.createElement('div'); row.className = 'nudge'
          const down = nudge('−', () => { draft = view.modify(draft, key, -1); renderDice() })
          const up = nudge('+', () => { draft = view.modify(draft, key, 1); renderDice() })
          row.append(down, up)
          cell.append(b, v, row)
          statsHost.append(cell)
          cells.set(key, { v, down, up })
        }
      }
      const renderDice = (): void => {
        if (cells.size === 0) buildDice()
        const bounds = view.limits(draft)
        for (const key of keys) {
          const cell = cells.get(key)!
          const value = key === 'hp' ? draft.hp : draft.stats[key]
          const [min, max] = bounds[key]
          cell.v.textContent = key === 'str' && draft.stats.str === 18 && draft.strPercent > 0 ? `18/${String(draft.strPercent % 100).padStart(2, '0')}` : String(value)
          cell.down.disabled = !(key === 'str' ? value > min || draft.strPercent > 0 : value > min)
          cell.up.disabled = !(key === 'str' ? value < max || (draft.stats.str === 18 && view.modify(draft, 'str', 1).strPercent !== draft.strPercent) : value < max)
          cell.down.title = `Down, no lower than ${min}`
          cell.up.title = key === 'str' && max === 18 ? 'Up, to 18 and on into the percentile for a fighting class' : `Up, no higher than ${max}`
        }
        el('createRollWords').textContent = `Age ${draft.age}. Modify with the arrows, as the original allowed: up to the race's best, hit points to the class's.`
      }
      const render = (): void => {
        choice(el('createRaces'), view.races.map((r) => r.toUpperCase()), view.races.indexOf(race), (i) => { race = view.races[i]!; const allowed = view.classes(race); if (!allowed.includes(classIndex)) classIndex = allowed[0]!; if (!view.alignmentsFor(classIndex).includes(alignment)) alignment = view.alignmentsFor(classIndex)[0]!; reroll(); render() })
        choice(el('createSex'), ['MALE', 'FEMALE'], sex, (i) => { sex = i as 0 | 1; reroll(); render() })
        const allowed = view.classes(race)
        choice(el('createClasses'), allowed.map((i) => view.classNames[i]!.toUpperCase()), allowed.indexOf(classIndex), (i) => { classIndex = allowed[i]!; if (!view.alignmentsFor(classIndex).includes(alignment)) alignment = view.alignmentsFor(classIndex)[0]!; reroll(); render() })
        const alignments = view.alignmentsFor(classIndex)
        choice(el('createAlign'), alignments.map((a) => view.alignments[a]!), alignments.indexOf(alignment), (i) => { alignment = alignments[i]!; render() })
        renderDice()
        const members = view.members()
        el('createRoster').replaceChildren(...(members.length === 0 ? [Object.assign(document.createElement('span'), { className: 'spellLine', textContent: 'Nobody yet. Six at most.' })] : members.map((m, i) => {
          const row = document.createElement('div'); row.className = 'who'
          const n = document.createElement('div'); n.className = 'n'; n.textContent = m.name
          const acts = document.createElement('div'); acts.className = 'acts'
          const drop = document.createElement('button'); drop.textContent = 'Remove'; drop.addEventListener('click', () => { view.remove(i); render() })
          acts.append(drop)
          const d = document.createElement('div'); d.className = 'd'; d.textContent = m.title
          row.append(n, acts, d)
          return row
        })))
        ;(el('createAdd') as HTMLButtonElement).disabled = members.length >= 6
        ;(el('createDone') as HTMLButtonElement).disabled = members.length === 0
      }
      el('createRoll').onclick = () => { reroll(); renderDice() }
      el('createAdd').onclick = () => {
        const name = (el('createName') as HTMLInputElement).value
        void view.add({ name, alignment, draft }).then((sheet) => {
          words.textContent = `${sheet.name} joins the company: ${sheet.title.toLowerCase()}, ${sheet.hpMax} hit points, armour class ${sheet.ac}.`
          ;(el('createName') as HTMLInputElement).value = ''
          reroll()
          render()
        })
      }
      el('createPremade').onclick = () => { while (view.members().length > 0) view.remove(0); closeOverlays(); resolve() }
      el('createDone').onclick = () => { closeOverlays(); resolve() }
      createClosed = resolve
      words.textContent = ''
      cells.clear()
      render()
      showOverlay(createOverlay)
      ;(el('createName') as HTMLInputElement).focus({ preventScroll: true })
    })
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
  // The original began on the dock with the council's guide; the shipped save A only lends its party.
  const members = how === 1 ? await session.createParty() : []
  await session.begin(members.length > 0 ? members : await lib.party(saved))
}

async function continueGame(): Promise<void> {
  const lib = library
  if (!lib) return
  const snapshot = listSlots().length === 1 ? storedSnapshot() : await openSaves('load')
  if (!snapshot) return
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
    onMove: (state) => { play('step'); refreshHud(state) },
    onBlocked: (state) => { play('blocked'); refreshHud(state) },
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
  if (library && levels.length > 0) setStatus(`${library.game.title} — ${levels.length} level${levels.length === 1 ? '' : 's'}.`)
  session = undefined
  continueButton.hidden = storedSnapshot() === undefined
  playScreen.classList.remove('shown')
  startScreen.style.display = 'grid'
}

/** The round's order of play above the field: who has gone, who is up, who waits. */
function renderTurnStrip(battle: Battle): void {
  const current = battle.current
  turns.replaceChildren(...battle.turnOrder.map(({ fighter, done }) => {
    const chip = document.createElement('span')
    const c = fighter.combatant.member.character
    chip.className = `${fighter.side}${fighter === current ? ' now' : done ? ' done' : ''}`
    if (c.status !== 'okay' && c.status !== 'asleep' && c.status !== 'held') chip.style.textDecoration = 'line-through'
    chip.textContent = fighter.combatant.label
    chip.title = `HP ${c.hpCurrent}/${c.hpMax}`
    return chip
  }))
}

/** A character's sheet in an overlay: the numbers, and the pack, where a click readies or puts down. */
async function openSheet(index: number): Promise<void> {
  const current = session
  if (!current || current.busy || openMenu) return
  const data = await current.sheetData(index)
  if (!data) return
  const h = (tag: string, cls: string | undefined, text?: string): HTMLElement => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e }
  const head = h('div', 'sheetHead')
  head.append(h('h3', undefined, data.name), h('p', 'sub', `${data.title} · LEVEL ${data.level} · ${data.experience} XP · AGE ${data.age}`))
  const stats = h('div', 'stats')
  for (const [label, value] of data.stats) { const cell = h('div', undefined); cell.append(h('b', undefined, label), document.createTextNode(value)); stats.append(cell) }
  const vitals = h('div', 'vitals')
  const vitalPairs: [string, string][] = [['HP', `${data.hp}/${data.hpMax}`], ['AC', String(data.ac)], ['THAC0', String(data.thac0)], ['MOVE', String(data.movement)], ['', data.status], ['', data.coins]]
  for (const [label, value] of vitalPairs) {
    const span = h('span', undefined); if (label) span.append(h('b', undefined, label)); span.append(document.createTextNode(value)); vitals.append(span)
  }
  const items = h('div', 'items')
  data.items.forEach((item, at) => {
    const button = h('button', item.readied ? 'readied' : undefined) as HTMLButtonElement
    button.append(h('i', undefined, item.readied ? '●' : '○'), document.createTextNode(item.label))
    button.title = item.readied ? 'Put down' : item.wearable ? 'Ready' : 'Carried'
    button.addEventListener('click', () => {
      void current.toggleItem(index, at).then((problem) => { if (problem) pageUi.print(problem, true); void openSheet(index) })
    })
    items.append(button)
  })
  sheetBody.replaceChildren(head, stats, vitals, h('div', 'spellLine', data.items.length > 0 ? 'THE PACK — CLICK TO READY OR PUT DOWN' : 'NOTHING CARRIED'), items)
  if (data.caster) {
    sheetBody.append(h('div', 'spellLine', `MEMORISED: ${data.spells.length > 0 ? data.spells.join(', ') : 'NONE'}`))
    sheetBody.append(h('div', 'spellLine', `PREPARED FOR THE NEXT REST: ${data.prepared.length > 0 ? data.prepared.join(', ') : 'NONE'}`))
  }
  showOverlay(sheetOverlay)
}

/** Camp's memorise panel: every slot a caster has, and the book to fill them from. */
function openBook(index: number): Promise<void> {
  const current = session
  if (!current) return Promise.resolve()
  return new Promise<void>((resolve) => {
    void current.spellChoices(index).then((choices) => {
      const chosen = new Map<number, number>()
      for (const choice of choices) for (const id of choice.chosen) chosen.set(id, (chosen.get(id) ?? 0) + 1)
      const render = (): void => {
        bookBody.replaceChildren()
        const name = current.roster.members[index]?.character.name ?? ''
        const title = document.createElement('h3'); title.textContent = `${name}: WHAT TO MEMORISE`; title.style.margin = '0 0 4px'
        bookBody.append(title)
        for (const choice of choices) {
          const used = choice.known.reduce((n, k) => n + (chosen.get(k.id) ?? 0), 0)
          const head = document.createElement('h4')
          head.textContent = `${choice.casterClass.toUpperCase()} LEVEL ${choice.level} — ${used} OF ${choice.slots} SLOT${choice.slots === 1 ? '' : 'S'}`
          bookBody.append(head)
          const list = document.createElement('div'); list.className = 'known'
          for (const spell of choice.known) {
            const row = document.createElement('div')
            const label = document.createElement('span'); label.textContent = spell.name
            const count = document.createElement('span'); count.className = 'count'; count.textContent = String(chosen.get(spell.id) ?? 0)
            const less = document.createElement('button'); less.textContent = '−'; less.disabled = !(chosen.get(spell.id) ?? 0)
            less.addEventListener('click', () => { chosen.set(spell.id, (chosen.get(spell.id) ?? 0) - 1); render() })
            const more = document.createElement('button'); more.textContent = '+'; more.disabled = used >= choice.slots
            more.addEventListener('click', () => { chosen.set(spell.id, (chosen.get(spell.id) ?? 0) + 1); render() })
            row.append(label, less, count, more)
            list.append(row)
          }
          bookBody.append(list)
        }
      }
      const ids = (): number[] => { const out: number[] = []; for (const [id, n] of chosen) for (let i = 0; i < n; i++) out.push(id); return out }
      el('bookDone').onclick = () => { void current.setPrepared(index, ids()).then(() => closeOverlays()) }
      el('bookAuto').onclick = () => { closeOverlays(); void current.setPrepared(index, []).then(async () => { const member = current.roster.members[index]; if (member) { const { autoPrepare } = await import('../engine/casting.js'); autoPrepare(member.character); pageUi.print(`${member.character.name} PREPARES THE USUAL.`, true) } }) }
      bookClosed = resolve
      render()
      showOverlay(bookOverlay)
    })
  })
}

/** A movement command from a key or a pad button. */
function doMove(command: MoveCommand): void {
  if (!session || session.busy || openMenu || openOverlay) return
  // Outdoors the same commands ride: turns swing the compass, steps take an hour a square.
  if (session.overhead) { void session.move(command).then((moved) => play(moved ? 'step' : 'blocked')); return }
  // One step at a time: the viewer animates each, and the session stays in step with it.
  if (viewer?.isMoving) return
  // The session moves the party and runs the script; the viewer animates the same step.
  void session.move(command)
  viewer?.command(command)
}

function doAction(action: string): void {
  if (action === 'log') { logText.textContent = history.join('\n\n'); showOverlay(logOverlay); logText.parentElement!.scrollTop = 1e9; return }
  if (action === 'keys') { showOverlay(keysOverlay); return }
  if (action === 'sound') { setSound(!soundOn()); soundButton.classList.toggle('on', soundOn()); return }
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
/** The eight-way pad's directions as battle steps: 0 north, clockwise. */
const PAD_STEPS = [{ dx: 0, dy: -1 }, { dx: 1, dy: -1 }, { dx: 1, dy: 0 }, { dx: 1, dy: 1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 1 }, { dx: -1, dy: 0 }, { dx: -1, dy: -1 }]
for (const button of document.querySelectorAll<HTMLButtonElement>('#pad8 button[data-dir]')) {
  button.addEventListener('click', () => {
    const dir = Number(button.dataset.dir)
    if (openTurn && !openMenu) { if (!aiming && openTurn.battle.move(openTurn.fighter, PAD_STEPS[dir]!)) openTurn.refresh(); return }
    if (session && !session.busy && !openMenu && session.overhead) void session.moveOverland(dir).then((moved) => play(moved ? 'step' : 'blocked'))
  })
}
for (const button of document.querySelectorAll<HTMLButtonElement>('#actions button[data-act]')) {
  button.addEventListener('click', () => doAction(button.dataset.act!))
}
for (const id of ['sheetDone', 'logDone', 'keysDone']) el(id).addEventListener('click', closeOverlays)
for (const overlay of [sheetOverlay, bookOverlay, logOverlay, keysOverlay, shopOverlay, hallOverlay, campOverlay, createOverlay, savesOverlay]) overlay.addEventListener('click', (event) => { if (event.target === overlay) closeOverlays() })
// Over a fighter on the field, a word or two about them.
battleCanvas.addEventListener('mousemove', (event) => {
  const battle = openTurn?.battle ?? (window as unknown as { gbg?: { battle?: Battle } }).gbg?.battle
  if (!battle || !battlePanel.classList.contains('shown')) { tip.classList.remove('shown'); return }
  const rect = battleCanvas.getBoundingClientRect()
  const focus = openTurn?.fighter ?? battle.current
  const view = viewport(battle, focus)
  const x = view.x + Math.floor(((event.clientX - rect.left) * battleCanvas.width) / rect.width / SQUARE)
  const y = view.y + Math.floor(((event.clientY - rect.top) * battleCanvas.height) / rect.height / SQUARE)
  const f = battle.at(x, y)
  if (!f) { tip.classList.remove('shown'); return }
  const c = f.combatant.member.character
  tip.textContent = `${f.combatant.label}\nHP ${c.hpCurrent}/${c.hpMax}  AC ${c.ac}${c.status !== 'okay' ? `  ${c.status.toUpperCase()}` : ''}`
  tip.style.left = `${event.clientX + 14}px`
  tip.style.top = `${event.clientY + 14}px`
  tip.classList.add('shown')
})
battleCanvas.addEventListener('mouseleave', () => tip.classList.remove('shown'))

// Outdoors a click on the map rides a square toward the point clicked.
overheadCanvas.addEventListener('click', (event) => {
  if (!session || session.busy || openMenu || openOverlay || !session.overhead) return
  const rect = overheadCanvas.getBoundingClientRect()
  const dx = (event.clientX - rect.left) / rect.width - 0.5
  const dy = (event.clientY - rect.top) / rect.height - 0.5
  // The party sits mid-canvas; the angle to the click picks one of the eight ways.
  const angle = Math.atan2(dx, -dy)
  const direction = ((Math.round((angle / (Math.PI / 4))) % 8) + 8) % 8
  if (Math.abs(dx) < 0.03 && Math.abs(dy) < 0.03) return
  void session.moveOverland(direction)
})
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

  if (openTurn && !openMenu && !aiming) {
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
