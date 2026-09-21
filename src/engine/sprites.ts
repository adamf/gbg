/**
 * COMSPR.DAX: the missiles and spell-lights the combat screen animated. Each is a
 * block `id` and a second frame at `id + 128`: for the arrows the two frames point
 * opposite ways, for the thrown things they are two turns of a tumble, for the bolt
 * two flickers, for the burst the small and the large.
 */

export const SPRITE = {
  arrowUp: 0,
  arrowDiagonal: 1,
  arrowAcross: 2,
  axe: 3,
  flask: 4,
  dart: 5,
  lightning: 6,
  boulder: 7,
  stone: 8,
  sparkles: 9,
  burst: 10,
  skull: 11,
} as const

export type SpriteId = (typeof SPRITE)[keyof typeof SPRITE]

/** Which missile a weapon type throws or shoots, by the ITEMS table's numbering. */
export function missileFor(type: number): SpriteId {
  switch (type) {
    case 9: return SPRITE.dart
    case 2: case 20: return SPRITE.axe
    case 47: return SPRITE.stone
    case 86: return SPRITE.flask
    case 87: return SPRITE.boulder
    default: return SPRITE.arrowUp
  }
}
