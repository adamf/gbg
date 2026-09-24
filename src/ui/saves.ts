/**
 * Saved games in the browser's storage: numbered slots, each a snapshot with a
 * word about where it stands and a small picture of the map. Nothing leaves the
 * machine. The single save older builds kept becomes slot 1.
 */

import type { Snapshot } from '../engine/session.js'

const PREFIX = 'goldbox-web:slot:'
const LEGACY_KEY = 'goldbox-web:save'

export interface SlotMeta {
  id: number
  /** The level or the wilderness. */
  where: string
  day: number
  hour: number
  minute: number
  party: string[]
  /** When it was saved, as milliseconds since the epoch. */
  savedAt: number
  /** A small PNG data URL of the map, if the page had one. */
  thumb?: string
}

interface Stored { meta: SlotMeta; snapshot: Snapshot }

function safe<T>(work: () => T, fallback: T): T {
  try { return work() } catch { return fallback }
}

/** Every slot, newest first. */
export function listSlots(): SlotMeta[] {
  migrate()
  return safe(() => {
    const out: SlotMeta[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(PREFIX)) continue
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const stored = JSON.parse(raw) as Stored
      if (stored.meta && stored.snapshot?.version === 1) out.push(stored.meta)
    }
    return out.sort((a, b) => b.savedAt - a.savedAt)
  }, [])
}

export function readSlot(id: number): Snapshot | undefined {
  return safe(() => {
    const raw = localStorage.getItem(PREFIX + id)
    if (!raw) return undefined
    const stored = JSON.parse(raw) as Stored
    return stored.snapshot?.version === 1 ? stored.snapshot : undefined
  }, undefined)
}

/** Writes a slot; returns false when the browser would not keep it. */
export function writeSlot(meta: Omit<SlotMeta, 'id' | 'savedAt'>, id: number | undefined, snapshot: Snapshot): SlotMeta | undefined {
  const slotId = id ?? nextId()
  const full: SlotMeta = { ...meta, id: slotId, savedAt: Date.now() }
  const stored: Stored = { meta: full, snapshot }
  return safe(() => { localStorage.setItem(PREFIX + slotId, JSON.stringify(stored)); return full }, undefined)
}

export function deleteSlot(id: number): void {
  safe(() => localStorage.removeItem(PREFIX + id), undefined)
}

function nextId(): number {
  const ids = listSlots().map((s) => s.id)
  return ids.length === 0 ? 1 : Math.max(...ids) + 1
}

/** The single save of earlier builds becomes slot 1, once. */
function migrate(): void {
  safe(() => {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return
    const snapshot = JSON.parse(raw) as Snapshot
    if (snapshot.version === 1 && !localStorage.getItem(PREFIX + 1)) {
      const stored: Stored = { meta: { id: 1, where: 'An earlier save', day: 0, hour: 0, minute: 0, party: snapshot.members.map((m) => m.character.name), savedAt: Date.now() }, snapshot }
      localStorage.setItem(PREFIX + 1, JSON.stringify(stored))
    }
    localStorage.removeItem(LEGACY_KEY)
  }, undefined)
}
