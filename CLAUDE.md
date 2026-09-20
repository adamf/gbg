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

- **The party** — characters and inventories read from the CHRDATA files a saved game
  names, with hit points, saving throws, coins and the selected-character view the
  scripts read at 0x6B00. Damage lands; nobody fights back yet.

- **Fights, rest and saves** — round-based combat against the area's monster records,
  camping that heals and can be interrupted by the level's own encounter odds, a temple
  that heals for gold, and a save in the browser's storage with a Continue button.

- **Treasure and shops** — what TREASURE leaves on the ground can be shared and taken,
  shops buy and sell, and items carry the names the game printed, scanned from
  START.EXE. V shows a character sheet.

Not here yet, in roughly the order they are needed: the tactical combat grid, spells,
training, the city overview map, and writing the original's save files. Script commands that need
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
  together.
- `src/render/` — three.js. `dungeon-scene.ts` builds the geometry, merged per wall graphic;
  `textures.ts` is the pixels-to-surfaces pipeline; `viewer.ts` is the camera, torch and feel.
- `src/ui/` — the page: folder picker, level list, minimap, event text.
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
```

`.github/workflows/ci.yml` typechecks, tests and builds on every branch but main.

## Credit

The formats were reverse-engineered by the Gold Box community over many years. This code was
written against the readers in
[simeonpilgrim/goldboxexplorer](https://github.com/simeonpilgrim/goldboxexplorer), itself from
disassembly of the original loaders, and Bill Simser's earlier work.
