# Gold Box Web

Reads the data files from SSI's Gold Box games and walks their dungeons in a browser, in
real 3D, with the original art on the walls.

Built for **Pool of Radiance (DOS)** first; the readers are shared across the family and the
other DOS releases are recognised, with varying luck (see *Which games* below).

> **No game data ships here.** This repository contains code that reads files, not files.
> Point it at a copy of a game you own. In the browser the files are read in the page and
> never uploaded anywhere — there is no server and nothing leaves your machine.

---

## What it does today

- **Reads the formats** — DAX archives and their RLE compression, EGA pictures and sprites,
  the 8×8 tile sets, wall definitions, and the 16×16 dungeon levels with their walls, doors
  and event triggers. Written up in [`docs/FORMATS.md`](docs/FORMATS.md).
- **Decodes the scripts** — ECL bytecode: the 64-opcode instruction set, the six-bit packed
  text, the event jump table, and the commands that load a level's map and wall graphics.
- **Walks a level in 3D** — the real geometry from the level data, the original wall art as
  textures, a torch that flickers and falls off, fog, and the step-and-turn movement of the
  originals with the steps smoothed out. A minimap drawn from the same data. Step on an
  event square and the game's own words come up.
- **Extracts everything** — a CLI that dumps every picture to PNG and every level to JSON,
  and disassembles any script.

What is *not* here: combat, characters, items, spells, saved games — and the scripts are
read but not *run*, which is the difference between seeing what an event can do and playing
it. This is the data pipeline and the dungeon crawl, not the game.

## What is new versus 1988

The original faked depth by choosing one of ten pre-drawn views of each wall. Here the walls
are where the data says they are and the perspective is the camera's, so you can stand in a
doorway and look down a corridor at an angle — a view the 1988 renderer could only imply.

The art itself is untouched: nearest-neighbour magnification, no smoothing, no repainting.
What is new is the lighting around it. Each wall texture gets a normal map derived from its
own painted highlights, on the theory that the pixel artist drew their own light and shade —
bright on top of a stone, dark beneath it — so reading luminance as height recovers roughly
the relief they had in mind. A torch then rakes across it and agrees with the painting.

---

## Using it

```bash
npm install
```

### Walk a dungeon

```bash
npm run dev
```

Open the page, choose the folder holding your game (the one with `POOL.CFG` and the `.DAX`
files in it), pick a level, and walk.

<kbd>W</kbd>/<kbd>↑</kbd> forward · <kbd>S</kbd> back · <kbd>A</kbd>/<kbd>D</kbd> sidestep ·
<kbd>Q</kbd>/<kbd>←</kbd> and <kbd>E</kbd>/<kbd>→</kbd> turn · <kbd>X</kbd> about face

### See what is in a folder

```bash
npm run inspect -- /path/to/game              # the game, its levels and events, its archives
npm run inspect -- /path/to/game GEO1.DAX     # every block in one archive
npm run inspect -- /path/to/game GEO1.DAX 21  # a hex dump of one block
npm run inspect -- /path/to/game ECL1.DAX 1   # a disassembly of one script
```

The disassembly is the one to try first on real data. It prints the script's entry points,
what it loads, its event table with the first line each event says, and then the code:

```
  events (6):
      4  0x9aa4  [combat]  "SIX KOBOLDS RUSH FROM THE DARKNESS!"

    ; event 4
    0x9aa4  PRINT            "SIX KOBOLDS RUSH FROM THE DARKNESS!"
    0x9ac2  COMBAT
    0x9ac3  RETURN
```

This is the tool to reach for when something looks wrong. It never throws on bad data — it
reports what it could not read and carries on.

### Extract everything

```bash
npm run dump -- /path/to/game ./out
```

Writes `out/images/**.png` (every picture it can decode), `out/walls/**.png` (the wall
textures as the 3D view uses them), `out/levels/*.json` (every cell, wall, door and event),
and `out/index.json`.

### Tests

```bash
npm test
```

62 tests over synthetic files built to the spec — no game data required, which is the point.
The ECL tests assemble bytecode with a small assembler in `test/fixtures.ts` and decode it
back, so the decoder is checked against programs whose meaning is known.

---

## Which games

The readers are shared, so all the DOS releases load to some degree. Confidence varies:

| Game | Expected |
|---|---|
| Pool of Radiance | The target. Levels, walls, pictures. |
| Curse of the Azure Bonds, Secret of the Silver Blades, Pools of Darkness | Same engine generation; should work, unverified. |
| Champions of Krynn, Death Knights of Krynn, Dark Queen of Krynn | Later engine. Death Knights has a known extra-frame quirk that is handled. |
| Gateway / Treasures of the Savage Frontier, Neverwinter Nights | Detected; otherwise unverified. |
| Buck Rogers: Countdown to Doomsday, Matrix Cubed | Detected; otherwise unverified. |
| Amiga, C64, Atari ST releases | **Not supported.** Different packing — the Amiga uses ByteKiller, not this RLE. |

---

## How it is put together

Plain TypeScript and three.js. Read in this order:

- `src/formats/` — the file readers, and the only code that knows about bytes. Pure functions
  over `Uint8Array`, no DOM and no filesystem, which is why the same code serves the browser
  and the CLI and why the tests need no game data.
  - `dax.ts` the archive container and its compression — start here, everything is inside one
  - `ega.ts` the palette and the 4bpp pixel decoder
  - `image.ts` the two picture layouts, and the guesswork that tells blocks apart
  - `geo.ts` the levels: walls, doors, events, and what blocks movement
  - `walldef.ts` wall graphics as grids of 8×8 tile indices
  - `ecl.ts` the scripts: instruction decoding, packed text, event tables
  - `library.ts` ties a folder together: detects the game, finds levels, assembles wall sets,
    reads each level's script
- `src/engine/` — the rules. `dungeon.ts` turns a level into faces and floors; `party.ts` is
  where the party stands and which way it faces. Pure, and tested.
- `src/render/` — three.js. `dungeon-scene.ts` builds the geometry, merged per wall graphic so
  a level is a handful of draw calls; `textures.ts` is the pixels-to-surfaces pipeline;
  `viewer.ts` is the camera, the torch and the movement feel.
- `src/ui/` — the page: folder picker, level list, minimap.
- `src/cli/` — `inspect` and `dump`, plus a small PNG writer so there is no image dependency.
- `docs/FORMATS.md` — the file formats, and which parts of them are still inference.

### Things worth knowing before changing it

- **Formats stay pure.** Anything in `src/formats/` that reaches for `window` or `fs` has
  broken the arrangement that makes the CLI, the browser and the tests share one reader.
- **Bad data is normal.** Shipped blocks over-run their declared sizes and both sides of a
  wall disagree. Readers report and carry on; they do not throw.
- **Some of this is inference.** `docs/FORMATS.md` marks what is unverified — most
  importantly which of a wall's ten views is which, that north is decreasing row, and
  whether event *N* is entry *N* of the jump table or *N − 1*. If something renders inside
  out or an event says the wrong thing, start there.
- **The scripts are read, not run.** Branches are not evaluated, so an event summary shows
  every path through it. Running them needs the game state they test against.

---

## Where this goes next

Roughly in order of how much each one unlocks:

1. **Run the scripts, don't just read them.** The decoder is there; what is missing is the
   state a script tests against — party, flags, clock — and the handful of commands that
   need a UI (menus, input, treasure). That turns "this event can say three things" into
   the one thing it actually says.
2. **Item and monster tables**, so encounters name real creatures.
3. **Characters and combat** — the tactical grid is a different map format again.
4. **Saved games**, so a real party can walk its own campaign.

---

## Credit

The formats were reverse-engineered by the Gold Box community over many years. This code was
written against the readers in
[simeonpilgrim/goldboxexplorer](https://github.com/simeonpilgrim/goldboxexplorer) (itself from
disassembly of the original loaders, and Bill Simser's earlier work), which is the best
documentation of these files that exists.
