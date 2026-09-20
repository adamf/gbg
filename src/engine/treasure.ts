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

/** Gold and platinum count; the game priced things in gold. */
export function goldOf(member: Member): number {
  const money = member.character.money
  return (money[3] ?? 0) + (money[4] ?? 0) * 5
}

/** Pays `price` in gold from a member, breaking platinum when gold runs short. Returns false if they cannot. */
export function pay(member: Member, price: number): boolean {
  const money = member.character.money
  if (goldOf(member) < price) return false
  let due = price
  const gold = money[3] ?? 0
  const fromGold = Math.min(gold, due)
  money[3] = gold - fromGold
  due -= fromGold
  if (due > 0) {
    const platinum = Math.ceil(due / 5)
    money[4] = (money[4] ?? 0) - platinum
    money[3] = (money[3] ?? 0) + platinum * 5 - due
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
  const price = Math.floor(item.value / 2)
  member.character.money[3] = (member.character.money[3] ?? 0) + price
  return price
}

export function take(pool: Pool, index: number, member: Member): Item | undefined {
  const [item] = pool.items.splice(index, 1)
  if (item) member.items.push(item)
  return item
}
