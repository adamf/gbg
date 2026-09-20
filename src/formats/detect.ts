/**
 * Which Gold Box game a folder holds.
 *
 * Every release dropped a differently named .CFG next to its data, which is a more
 * reliable tell than file sizes (players patched their executables).
 */

export type GameId =
  | 'pool-of-radiance'
  | 'curse-of-the-azure-bonds'
  | 'secret-of-the-silver-blades'
  | 'pools-of-darkness'
  | 'champions-of-krynn'
  | 'death-knights-of-krynn'
  | 'dark-queen-of-krynn'
  | 'gateway-to-the-savage-frontier'
  | 'treasures-of-the-savage-frontier'
  | 'neverwinter-nights'
  | 'countdown-to-doomsday'
  | 'matrix-cubed'
  | 'unknown'

export interface GameInfo {
  id: GameId
  title: string
  year?: number
}

const TITLES: Record<GameId, GameInfo> = {
  'pool-of-radiance': { id: 'pool-of-radiance', title: 'Pool of Radiance', year: 1988 },
  'curse-of-the-azure-bonds': { id: 'curse-of-the-azure-bonds', title: 'Curse of the Azure Bonds', year: 1989 },
  'secret-of-the-silver-blades': { id: 'secret-of-the-silver-blades', title: 'Secret of the Silver Blades', year: 1990 },
  'pools-of-darkness': { id: 'pools-of-darkness', title: 'Pools of Darkness', year: 1991 },
  'champions-of-krynn': { id: 'champions-of-krynn', title: 'Champions of Krynn', year: 1990 },
  'death-knights-of-krynn': { id: 'death-knights-of-krynn', title: 'Death Knights of Krynn', year: 1991 },
  'dark-queen-of-krynn': { id: 'dark-queen-of-krynn', title: 'The Dark Queen of Krynn', year: 1992 },
  'gateway-to-the-savage-frontier': { id: 'gateway-to-the-savage-frontier', title: 'Gateway to the Savage Frontier', year: 1991 },
  'treasures-of-the-savage-frontier': { id: 'treasures-of-the-savage-frontier', title: 'Treasures of the Savage Frontier', year: 1992 },
  'neverwinter-nights': { id: 'neverwinter-nights', title: 'Neverwinter Nights (AOL)', year: 1991 },
  'countdown-to-doomsday': { id: 'countdown-to-doomsday', title: 'Buck Rogers: Countdown to Doomsday', year: 1990 },
  'matrix-cubed': { id: 'matrix-cubed', title: 'Buck Rogers: Matrix Cubed', year: 1992 },
  unknown: { id: 'unknown', title: 'Unrecognised Gold Box data' },
}

/** `fileNames` may be in any case; only the base names matter. */
export function detectGame(fileNames: readonly string[]): GameInfo {
  const present = new Set(fileNames.map((n) => n.split(/[\\/]/).pop()!.toUpperCase()))
  const hasFile = (n: string) => present.has(n)

  if (hasFile('POOL.CFG')) return TITLES['pool-of-radiance']
  if (hasFile('POOL4.CFG')) return TITLES['pools-of-darkness']
  if (hasFile('BLADES.CFG')) return TITLES['secret-of-the-silver-blades']
  if (hasFile('CURSE.CFG')) return TITLES['curse-of-the-azure-bonds']
  if (hasFile('BUCK.CFG')) return TITLES['countdown-to-doomsday']
  if (hasFile('MATRIX.CFG')) return TITLES['matrix-cubed']
  if (hasFile('KRYNN.CFG')) return TITLES['champions-of-krynn']
  if (hasFile('DKK.CFG')) return TITLES['death-knights-of-krynn']
  if (hasFile('TREASURE.CFG')) return TITLES['treasures-of-the-savage-frontier']
  if (hasFile('GAME.CFG') && hasFile('8X8D6.DAX')) return TITLES['gateway-to-the-savage-frontier']
  if (hasFile('GAME.CFG') && hasFile('CPIC.DAX')) return TITLES['neverwinter-nights']

  return TITLES.unknown
}

export function gameInfo(id: GameId): GameInfo {
  return TITLES[id]
}

/**
 * Level names for the maps we have names for. Keyed by GEO block id.
 * Pool of Radiance is filled in; the rest come from the Gold Box Explorer tables.
 */
export const MAP_NAMES: Partial<Record<GameId, Record<number, string>>> = {
  'pool-of-radiance': {
    0: 'Civilized Area, New Phlan',
    1: 'Buccaneer Base',
    2: 'Cadorna Textile House',
    3: 'Valjevo Castle, North West',
    4: 'Valjevo Castle, North East',
    5: 'Valjevo Castle, South East',
    6: 'Valjevo Castle, South West',
    7: 'Valjevo Castle, Inner Tower',
    9: 'Stojanow Gate',
    10: 'Valhingen Graveyard',
    13: 'Kobold Caves',
    14: 'Kovel Mansion',
    15: "Mendor's Library",
    16: 'Lizard Men Keep',
    17: 'Nomad Camp',
    18: 'Podal Plaza',
    20: 'Slums',
    21: 'Sokal Keep',
    22: "Sorcerer's Island, Level 1",
    23: "Sorcerer's Island, Levels 2 and 3",
    24: 'Temple of Bane',
    25: 'Unknown Lair',
    26: 'Unknown Zone',
    27: 'Unknown Lair',
    28: 'Outpost of Zhentil Keep',
    29: "Kuto's Well",
    30: 'Lizard Men Catacombs',
    31: 'Wealthy Area',
    32: "Kuto's Well Catacombs",
  },
  'curse-of-the-azure-bonds': {
    1: "Tilverton City, Thieves' Guild",
    3: 'Tilverton Sewers',
    4: 'The Fire Knife Hideout',
    16: 'Yulash',
    17: 'The Pit of Moander, Levels 1-2',
    32: 'Zhentil Keep, The Shrine of Bane',
    33: 'The Cave of the Beholder',
    37: "Oxam's Tower, Dungeon, Cavern",
    50: 'Village of Haptooth, Cave of the Dracolich',
    51: "The Wizard's Tower",
    64: 'The Burial Glen',
    66: 'The Ruins of Myth Drannor',
    67: 'The Grand Ruined Temple, Levels 2-1',
  },
  'champions-of-krynn': {
    32: 'Throtl, Throtl Temple',
    34: 'Throtl Catacombs',
    48: 'Gargath',
    49: 'Gargath Keep',
    50: 'Jalek',
    64: 'Nereka City and Base',
    66: 'Nereka Prison',
    67: 'Tomb of Sir Dargaard',
    68: 'Southern Outpost',
    80: 'Sanction Docks',
    81: 'Temple of Huerzyd',
    82: 'Temple of Duerghast',
    96: 'Citadels',
    97: 'Kernen Square',
    99: 'Ogre Base',
  },
}

export function mapName(game: GameId, blockId: number): string {
  return MAP_NAMES[game]?.[blockId] ?? `Map ${blockId}`
}
