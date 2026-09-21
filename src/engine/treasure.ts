/**
 * The treasure pool: what a TREASURE command laid on the ground, what a shop has on
 * its shelves, and what the party takes, buys and sells.
 *
 * Coins are seven kinds, in the order the character record keeps them. A shop's
 * shelf never empties — the original sold from a list, not a stock — and it pays half
 * of an item's value when the party sells.
 */

import { COINS, type Item } from '../formats/character.js'
import type { Member } from './roster.js'

export interface Pool {
  coins: number[]
  items: Item[]
}

export function emptyPool(): Pool {
  return { coins: [0, 0, 0, 0, 0, 0, 0], items: [] }
}

export function poolIsEmpty(pool: Pool): boolean {
  return pool.items.length === 0 && pool.coins.every((n) => n === 0)
}

/** "36 SILVER, 2 PLATINUM" */
export function describeCoins(coins: readonly number[]): string {
  return coins
    .map((n, i) => (n > 0 ? `${n} ${COINS[i]!.toUpperCase()}` : ''))
    .filter(Boolean)
    .join(', ')
}

/** Everyone standing gets an equal share; the remainder goes to the first. */
export function shareCoins(pool: Pool, members: readonly Member[]): void {
  if (members.length === 0) return
  for (let kind = 0; kind < pool.coins.length; kind++) {
    const total = pool.coins[kind] ?? 0
    if (total === 0) continue
    const each = Math.floor(total / members.length)
    members.forEach((m, i) => {
      m.character.money[kind] = (m.character.money[kind] ?? 0) + each + (i === 0 ? total - each * members.length : 0)
    })
    pool.coins[kind] = 0
  }
}

/** What each coin is worth in copper: copper, silver, electrum, gold, platinum. */
const PER_COPPER = [1, 10, 100, 200, 1000] as const

/** A member's coins valued in gold, the way the original priced things. Gems and jewellery do not count. */
export function goldOf(member: Member): number {
  const money = member.character.money
  const coppers = PER_COPPER.reduce((total, worth, kind) => total + (money[kind] ?? 0) * worth, 0)
  return Math.floor(coppers / PER_COPPER[3])
}

/**
 * Pays `price` in gold from a member, spending the small coins first and making
 * change in the largest coins (coab `SubtractGoldWorth`). Returns false if they cannot.
 */
export function pay(member: Member, price: number): boolean {
  if (goldOf(member) < price) return false
  const money = member.character.money
  let coppers = price * PER_COPPER[3]
  for (let kind = 0; kind < PER_COPPER.length && coppers > 0; kind++) {
    const worth = PER_COPPER[kind]!
    const spend = Math.min(money[kind] ?? 0, Math.floor(coppers / worth) + 1)
    coppers -= worth * spend
    money[kind] = (money[kind] ?? 0) - spend
  }
  // Overpaid with a big coin: the change comes back, largest coins first.
  let change = -coppers
  for (let kind = PER_COPPER.length - 1; kind >= 0 && change > 0; kind--) {
    const worth = PER_COPPER[kind]!
    const back = Math.floor(change / worth)
    change -= worth * back
    money[kind] = (money[kind] ?? 0) + back
  }
  return true
}

export function buy(member: Member, item: Item): boolean {
  if (!pay(member, item.value)) return false
  member.items.push({ ...item, names: [...item.names] as [number, number, number], affects: [...item.affects], readied: false })
  return true
}

export function sell(member: Member, index: number): number {
  const [item] = member.items.splice(index, 1)
  if (!item) return 0
  const price = Math.max(1, Math.floor(item.value / 2))
  member.character.money[3] = (member.character.money[3] ?? 0) + price
  return price
}

export function take(pool: Pool, index: number, member: Member): Item | undefined {
  const [item] = pool.items.splice(index, 1)
  if (item) member.items.push(item)
  return item
}

/** Every coin the party has, onto one member: the original's POOL and TAKE in one. */
export function poolOnto(members: readonly Member[], onto: Member): void {
  for (const m of members) {
    if (m === onto) continue
    for (let kind = 0; kind < 7; kind++) {
      onto.character.money[kind] = (onto.character.money[kind] ?? 0) + (m.character.money[kind] ?? 0)
      m.character.money[kind] = 0
    }
  }
}
