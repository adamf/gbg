# Gold Box Web

Reads the data files from SSI's Gold Box games and plays them in a browser. The goal is the
**full game** — walking, events, encounters, characters, combat, saves — running on the
original data with a modern 3D view and UI around it. Targets **Pool of Radiance (DOS)**
first; the readers are shared across the family. Today it is a dungeon viewer; the rest is
being built on top of it.

**No game data belongs in this repository, ever.** This is code that reads files, not files.
The browser reads the player's own folder in the page and uploads nothing — there is no server
and nothing leaves the machine. Keep it that way: any change that would upload a file, cache
one server-side, or check a `.DAX` into git is the wrong change.

## What is here

- **The file readers** — DAX archives, EGA pictures, wall graphics, dungeon levels, and the
  ECL scripts that drive them. `docs/FORMATS.md` is the write-up and the place to look first.
- **A 3D dungeon crawl** — real geometry from the level data, the original art on the walls,
  step-and-turn movement.
- **The scripts, running** — an ECL interpreter with the original's semantics, a game
  session that runs the right entry points on level load and after every step, and the
  page as its host: text box, menus, pictures, encounter sprites. A new game starts from
  the shipped saved game, in the Slums.
- **A CLI** — `inspect` reports what a folder holds and disassembles scripts; `dump` extracts
  every picture to PNG and every level to JSON.

- **Your own party** — a new game offers the pre-made six or rolling characters: race,
  class the race allows, dice with the race's adjustments, first-level tables.
- **The party** — characters and inventories read from the CHRDATA files a saved game
  names, with hit points, saving throws, coins and the selected-character view the
  scripts read at 0x6B00. Damage lands; nobody fights back yet.

- **Fights, rest and saves** — combat against the area's monster records, on the
  original's combat map (`engine/arena.ts` is a port of the game's own builder: a
  50×25 grid of DUNGCOM pieces from the thirteen-by-five squares around the party,
  six-by-five patches sheared a column a row) with eight-way moves, turns by
  initiative, blows, missiles, spells and monsters that close in, or played quickly by
  the computer on the same grid,
  camping that heals and can be interrupted by the level's own encounter odds, a temple
  that heals for gold, and a save in the browser's storage with a Continue button.

- **Spells** — memorised at camp against the book and the slots, refilled by rest,
  cast in a fight or on the road: all fifty-six of the game's list have an effect,
  with the manual's durations, on a registry of lasting effects the fight keeps —
  blessings and curses, shields and protections, haste and slow, silence, strength
  and enfeeblement, proofing against fire and missiles, the cures for poison and
  drain, paralysis and a medusa's or basilisk's gaze, which turns the failed save to
  stone until the temple raises them. Sleepers and the held are auto-hit for double.
- **Training** — the halls' class masks and PROGRAM 0 open a training menu; a level
  costs the original's thousand gold and brings a hit die, a better to-hit and slots.
- **Treasure and shops** — what TREASURE leaves on the ground can be shared and taken,
  random loot rolls on the original's table and is built from shipped records of the
  same type, shops buy and sell, and items carry the names the game printed, scanned
  from START.EXE. V shows a character sheet.
- **The fight, seen** — the party's icons put together from CBODY and CHEAD as the
  original's icon editor did, swapped to their action pose for a blow; the missiles
  and spell-lights from COMSPR — arrows, thrown axes and darts, sling stones, the
  bolt, the sparkles, the burst — flying and flashing over the art, never repainting it.
- **Spells on the grid** — a fireball is a disc of twenty-one squares, a lightning bolt
  a line, a sleep or a stinking cloud a block, each with the manual's range, and
  everyone under it is hit, friend or foe; the page aims them with the mouse, the blast
  drawn under the pointer before the click, and picks the targets of the rest by
  clicking them on the field. The computer aims where the most foes and fewest
  friends stand.
- **The rules of the round** — zero hit points is unconscious, below it dying and
  bleeding a point a round to death at minus ten unless bandaged (B); trolls mend
  three a round and get up unless burnt or stood on, and must be finished; ghouls
  paralyse, spiders poison, wights drain, each with its save; fighters sweep small fry;
  the field's edge is the way out; rest takes a day a hit point; the halls hold to the
  manual's race limits; shops appraise gems. Arrows, quarrels and thrown darts and axes
  are spent; the load slows a character by the first edition's steps, strength counted;
  a blow from behind meets the rear armour class with a bonus, and a thief's is a
  backstab for double; monsters badly hurt or half down check morale and may run,
  paying nothing.

- **Outdoors** — the wilderness is the original's one 44×36 map of the Moonsea's
  shore, read out of START.EXE's packed data and drawn from the SQRPACI tiles with
  the riders' icon on the party's square; the three wilderness scripts see it
  through sixteen-column windows and vet each of the eight-way steps against their
  own impassable-tile tables through CALL 0xC01B, plant tiles with CALL 0xC018, and
  hand the party across their edges. The movement keys ride: turns swing the
  compass an eighth, a square takes an hour.
- **Monsters that shoot and cast** — from the same gear and books the party uses. The
  computer's own party (QUICK, and the bot) memorises fireballs and holds first, casts the
  spell worth most against what stands there, strikes the held and sleeping first, and
  presents the holy symbol to undead.

- **The rest a run needs** — NPCs join by ADD NPC, thieves ROB, SPELL and CHECK PARTY
  answer from the party, clerics turn undead (T in a fight), potions and wands are used
  (U in a fight, USE at camp), and PROGRAM 8 shows the closing pictures.
- **Scrolls** — a Magic User or Clerical Scroll carries up to three spells in its
  affect bytes; a caster of its class reads one (USE, at camp or in a fight) at
  sixth level or their own, and a magic-user can SCRIBE one into the book at camp.
- **The page** — a stage for the 3D view, the wilderness or a fight; a sidebar with
  a compass, the day and hour, the minimap and a party roster whose rows open a
  character sheet; a bottom bar with the message box, an on-screen pad (eight ways
  outdoors and in a fight) and the camp, view, search, look, log and keys buttons.
  Everything is playable by mouse: menus are buttons, a fight is clicks on squares and
  foes with a tooltip over each fighter, spells are aimed on the field, the wilderness
  is ridden by clicking the map, the sheet's pack is readied by clicking, camp's
  MEMORISE is a book with a count against every spell, a shop is a panel with the
  buyer picked and every ware and pack item priced, and a strip above the field
  shows the round's order of play.
- **Headless play** — `src/headless/driver.ts` runs a session with no page: every
  prompt queues for the caller and the state is a plain object. `npm run headless --
  <folder>` is that as a JSON-lines conversation on stdin/stdout, and `npm run mcp --
  <folder>` serves the same over MCP (stdio), one tool a command, so an agent can
  play at any speed.
- **DOS saves** — camp's EXPORT writes SAVGAMB.DAT and CHRDATB1–6 in the original's
  formats, with the bytes this program does not model carried through from the read;
  the original loads them (checked in DOSBox), which needs the area word and the
  wall-set ids kept in the globals.

Not here yet: monsters' special attacks as data rather than by name.
`scripts/soak.ts` random-walks every level headlessly and prints what the scripts
trip over; run it after touching the interpreter. `scripts/playthrough.ts` plays
the game for thousands of steps with a seeded party — menus, fights, camp, training —
and reports what it saw and what hung; run a few seeds after touching the engine.
`PLAY_QUEST=1` makes it play the story instead of wandering: clear the Slums (every
event square, every fight), collect from the clerk, take the harbour master's boat to
Sokal Keep, answer its undead with the journal's words, clear it, sail home and collect
again, then the clerk's other areas one by one, and then tours every other scripted
level in the game two laps each (`PLAY_TARGET=<name>` starts there), riding out of
Cadorna's west door and across the wilderness to the places reached that way — the
kobold caves, the lizard men's keep, the nomad camp, Sorcerer's Island, the bases
that need their commissions — on a shortest path over the map, learning the tiles
the scripts refuse. It has done all of that on several seeds
with the pre-made party and with one it rolled (`PLAY_PARTY=roll`, which buys its gear
first); with the parties `scripts/make-save.ts` writes (`PLAY_PARTY=C` at level 6, D at
8, E at the cap; the page's NEW GAME offers each as LOAD GAME) it clears Sokal Keep, the
Temple of Bane, Stojanow Gate and Valhingen Graveyard, climbs Valjevo's tower, beats the
audience hall's guards and Tyranthraxus, and sees the ending — with the wilderness
ridden on the real map, not skipped. The whole story runs. The clerk's office is reached through her anteroom from the south. Script commands that need
those run as no-ops and say so in the page's notes line.

## How it is put together

Plain TypeScript and three.js. Read in this order:

- `src/formats/` — the file readers, and the only code that knows about bytes.
  - `dax.ts` the archive container and its run-length coding — everything lives inside one
  - `ega.ts` the palette and the 4bpp pixel decoder
  - `image.ts` the two picture layouts, and the guesswork that tells blocks apart
  - `geo.ts` the levels: walls, doors, events, and what blocks movement
  - `walldef.ts` wall graphics as grids of 8×8 tile indices
  - `ecl.ts` the scripts: instruction decoding, six-bit packed text, event tables
  - `character.ts` party members and their inventories
  - `library.ts` ties a folder together: game, levels, wall sets, each level's script
- `src/engine/` — the rules. `dungeon.ts` turns a level into faces and floors; `party.ts` is
  where the party stands and which way it faces; `ecl-vm.ts` runs the scripts against a
  host interface; `session.ts` is the game loop that ties memory, map, party and script
  together; `roster.ts`, `combat.ts`, `battle.ts`, `casting.ts`, `equipment.ts`,
  `training.ts` and `treasure.ts` are the party, the blows, the grid, the spells, the
  gear, the levels and the loot.
- `src/render/` — three.js. `dungeon-scene.ts` builds the geometry, merged per wall graphic;
  `textures.ts` is the pixels-to-surfaces pipeline; `viewer.ts` is the camera, torch and feel.
- `src/ui/` — the page: folder picker, level list, minimap, event text; `battle-view.ts`
  draws a fight the way the original's combat screen did, oblique walls from the
  DUNGCOM cobble art and the wilderness scenery outdoors.
- `vite.config.ts` — in `npm run dev` only, serves the folder named by `GOLDBOX_DATA` at
  `/dev-data/` so the page can load it without the picker. It is not part of the build.
- `src/cli/` — `inspect` and `dump`, plus a small PNG writer so there is no image dependency.

## Rules that are easy to break by accident

- **`src/formats/` stays pure.** No `window`, no `fs` — just functions over `Uint8Array`. That
  is the whole reason the CLI, the browser and the tests share one reader, and why the tests
  need no game data.
- **Bad data is normal, not exceptional.** Shipped blocks over-run their declared sizes and
  both sides of a wall disagree with each other. Readers report problems and carry on; they
  do not throw. A reader that throws on a real game folder is a bug.
- **Tests use synthetic files built to the spec**, assembled by `test/fixtures.ts` — including
  an ECL assembler. Never add a fixture carved out of real game data.
- **Some of this is inference, and it is marked.** `docs/FORMATS.md` flags what is unverified:
  which of a wall's ten views is which, that north is decreasing row, and whether event *N* is
  entry *N* of the jump table or *N* − 1. When something renders inside out or an event says
  the wrong thing, start there rather than patching the symptom.
- **Keep the art untouched.** Nearest-neighbour magnification, no smoothing, no repainting.
  The modern part is the lighting around it, not the pixels.

## Working on it

```bash
npm install
npm run dev                          # the crawl
GOLDBOX_DATA=/path/to/game npm run dev   # …with a folder preloaded (local dev server only)
npm test                             # the suite; no game data required
npm run inspect -- /path/to/game     # what a folder holds
npm run inspect -- /path/to/game ECL1.DAX 1   # disassemble a script
npm run dump -- /path/to/game ./out  # extract everything
npm run make-save -- /path/to/game C 6   # a sixth-level party as SAVGAMC.DAT, for testing the late game
npm run headless -- /path/to/game        # play by JSON lines on stdin; npm run mcp -- /path/to/game serves MCP
```

`.github/workflows/ci.yml` typechecks, tests and builds on every branch but main.

## Credit

The formats were reverse-engineered by the Gold Box community over many years. This code was
written against the readers in
[simeonpilgrim/goldboxexplorer](https://github.com/simeonpilgrim/goldboxexplorer), itself from
disassembly of the original loaders, and Bill Simser's earlier work.
