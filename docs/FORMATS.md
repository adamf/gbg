# Gold Box file formats

What the parsers in `src/formats/` implement, in the order you need to know it. Everything
here is little-endian 8086 data. Offsets are decimal unless written `0x`.

Sources: the [Gold Box Explorer](https://github.com/simeonpilgrim/goldboxexplorer) readers,
which came from disassembly of the original SSI loaders and the Curse of the Azure Bonds
overlay tables. Where a field's meaning is still guesswork, this document says so.

Nothing here is game data. These are the shapes of the files, not their contents.

---

## DAX archives — `src/formats/dax.ts`

Every asset lives in a `.DAX` container.

| offset | type | meaning |
|---|---|---|
| 0 | `u16` | size of the index in bytes; block data starts at this + 2 |
| 2 | index | `size / 9` entries, 9 bytes each |

Each index entry:

| offset | type | meaning |
|---|---|---|
| 0 | `u8` | block id |
| 1 | `i32` | payload offset, from the start of the data area |
| 5 | `u16` | decompressed size; **0 means the payload is stored, not compressed** |
| 7 | `u16` | bytes on disk |

Block ids are not guaranteed unique within a file, so `blocksById` returns a list.

### Compression

A byte-oriented RLE with a signed opcode:

```
n = (int8) next byte
n >= 0   copy the following n + 1 bytes literally
n <  0   repeat the following single byte -n times
```

Some shipped blocks over-run their declared `rawSize` — the original loader decoded into a
fixed scratch buffer and did not care. `decompressRle` stops at the output boundary instead
of failing, which is what the game effectively did.

---

## Pictures — `src/formats/ega.ts`, `src/formats/image.ts`

Pixels are **4 bits each, two per byte, high nibble first**. There are no EGA bit planes:
SSI swizzled the art into linear nibbles at build time. A row is `widthCells * 4` bytes,
where `widthCells` counts 8-pixel cells.

The palette is standard 16-colour EGA. Combat art (`CPIC`, `CHEAD`, `CBODY`, `DUNGCOM`,
`WILDCOM`, `RANDCOM`, `COMSPR`) swaps entries 0 and 8: index 0 is the transparent
background and index 8 is real black.

### Image block

| offset | type | meaning |
|---|---|---|
| 0 | `u16` | height in pixels |
| 2 | `u16` | width in 8-pixel cells |
| 4 | `u16` | x position in cells |
| 6 | `u16` | y position (multiplied by 8, matching the original) |
| 8 | `u8` | frame count |
| 17 | pixels | `count` frames of `height * widthCells * 4` bytes |

Bytes 9–16 are unused by any reader I have seen. Death Knights of Krynn stores one more
frame than it declares, so a block is also valid at `count + 1` frames.

### Sprite block

| offset | type | meaning |
|---|---|---|
| 0 | `u8` | frame count, 1..8 |

then per frame, a 21-byte header followed immediately by that frame's pixels:

| offset | type | meaning |
|---|---|---|
| 0 | `u32` | delay in ticks |
| 4 | `u16` | height in pixels |
| 6 | `u16` | width in cells |
| 8 | `u16` | x position in cells |
| 10 | `u16` | y position in cells |
| 12 | 9 bytes | unknown |

In `PIC*` and `FINAL*` files every frame after the first is stored as an **XOR delta against
frame 0**, not as its own picture.

### Telling blocks apart

A DAX block carries no type tag — the game knew what it had asked for. Identification is by
trial fit: a block is an image if its length is exactly `frames * frameSize + 17`, a sprite if
its per-frame headers consume the block exactly, and so on. `classifyBlock` also uses the
archive's name, which is how `GEO1.DAX` and `WALLDEF1.DAX` are recognised outright.

---

## Levels — `src/formats/geo.ts`

`GEO*.DAX`. One block is one 16×16 level; the block id is the map number the scripts use.
A block is 1026 bytes: a two-byte prefix (purpose unconfirmed) and then four parallel
256-byte planes over the same cell order, `cell = row * 16 + col`.

| offset | plane |
|---|---|
| 2 | north/east wall types — high nibble north, low nibble east |
| 258 | south/west wall types — high nibble south, low nibble west |
| 514 | event number in the low 7 bits; the high bit is a flag |
| 770 | door state, two bits per direction, N E S W from bit 0 upward |

A wall nibble of 0 is open floor. 1..15 select a wall graphic from the wall sets the level
loaded. Door states are 0 none, 1 door, 2 locked, 3 wizard-locked.

Both sides of a shared wall are stored independently and **do not always agree** — that is
how a room gets a finished wall on the inside and bare rock on the corridor side. Movement
therefore has to check both.

**Unverified:** that north is decreasing row and east is increasing column. It is the reading
consistent with the cell order and the door bit order, but the first real map you load is
worth checking against a map you recognise.

**Unknown:** the meaning of the event byte's high bit, and of the two prefix bytes.

---

## Wall graphics — `src/formats/walldef.ts`

`WALLDEF*.DAX`. A block is N walls of 156 bytes. Each wall holds **ten views**: the same wall
pre-drawn at the distances and offsets the original renderer needed to fake perspective. Each
view is a grid of 8×8 tile indices, and the ten tile the 156 bytes exactly:

| view | offset | rows × cols | pixels |
|---|---|---|---|
| 0 | 0 | 2 × 1 | 8 × 16 |
| 1 | 2 | 4 × 1 | 8 × 32 |
| 2 | 6 | 4 × 1 | 8 × 32 |
| 3 | 10 | 4 × 3 | 24 × 32 |
| 4 | 22 | 8 × 2 | 16 × 64 |
| 5 | 38 | 8 × 2 | 16 × 64 |
| 6 | 54 | 8 × 7 | 56 × 64 |
| 7 | 110 | 11 × 2 | 16 × 88 |
| 8 | 132 | 11 × 2 | 16 × 88 |
| 9 | 154 | 2 × 1 | 8 × 16 |

Tile index 0 means "draw nothing here" — the original left those pixels showing whatever was
already on screen.

**Unverified:** which view is which. View 6 is the widest and reads as a wall seen face-on;
views 7 and 8 are tall and narrow and read as the wall alongside you, left and right. The 3D
renderer takes view 6 as its flat texture, which is a choice you can change in one constant
(`FACING_VIEW`). Because a view is a drawing rather than a texture, its blank tiles are filled
in (`solidify`) before use, or they become holes in the wall.

A wall set is **five walls**, 780 bytes. A WALLDEF block holding 1560 or 2340 bytes carries
two or three wall sets.

### The 8×8 tiles

Tile indices point into a list assembled at load time from `8x8D*.DAX` — same number as the
WALLDEF file. The order the original left in memory, which the indices assume:

1. index 0 is a placeholder, never drawn
2. the universal tiles: block 203 of `8X8D1.DAX`, or of `8X8D.DAX` in games without one
3. the tiles for this wall set: the block whose id matches the WALLDEF block's
4. for a block holding two or three wall sets, the blocks at `id * 10 + 1`, `+ 2`, `+ 3`
   (with id 0 treated as 10 before multiplying)

A block holding 255 or more tiles is a whole tile page and replaces the lot; at exactly 256
the placeholder is dropped first.

---

## Scripts — `src/formats/ecl.ts`

`ECL*.DAX`. Bytecode for a small stack-less VM, and where everything a level *does*
lives: the events, the text, the encounters, and the commands that load the level's map
and wall graphics.

A block's first two bytes are not part of the loaded image and are skipped. The rest was
loaded at a fixed address, so addresses in the code are absolute: the byte at address `A`
is at `image[A - memStart]`, where memStart is **0x9900 for Pool of Radiance** and
**0x8000** for the others.

### Header

Five addresses, each four bytes: one unused byte then a word operand (the operand reader
expects to be called with the cursor on an opcode, and the header has none).

| entry | meaning |
|---|---|
| 0 | vmRun |
| 1 | searchLocation — the party searching a square |
| 2 | preCampCheck |
| 3 | campInterrupted |
| 4 | start |

Code begins at `memStart + 20`.

### Operands

An instruction is an opcode followed by operand sets. Each set is a code byte and a low
byte; the word-valued codes take a third byte. After the last set of an instruction, one
further byte is consumed.

| code | operand |
|---|---|
| 0x00 | immediate byte (the low byte) |
| 0x01, 0x03 | address to read a value from |
| 0x02 | literal word |
| 0x80 | a compressed string inline; the low byte is its length in bytes |
| 0x81 | address of a string |

So a one-operand instruction is 3 bytes with an immediate and 4 with a word.

### Packed text

Six bits per character, four characters per three bytes:

```
byte0 = c0 << 2 | c1 >> 4
byte1 = (c1 & 0x0F) << 4 | c2 >> 2
byte2 = (c2 & 0x03) << 6 | c3
```

A code of 0x01..0x1f is a letter and is shifted up by 0x40 into ASCII; 0x20..0x3f is
already ASCII (space, punctuation, digits); 0 is padding and emits nothing. Text is
therefore all upper case, which is what the games displayed.

### Instructions

64 opcodes, 0x00..0x3d. The full table with operand counts is in `ecl.ts`. The ones that
matter for reading a level:

| opcode | name | operands | note |
|---|---|---|---|
| 0x00 | EXIT | 0 | ends the run |
| 0x01 | GOTO | 1 | ends the run, continues at the address |
| 0x02 | GOSUB | 1 | continues at the address *and* falls through |
| 0x11, 0x12 | PRINT, PRINTCLEAR | 1 | the text the player reads |
| 0x13, 0x33 | RETURN, PRINT RETURN | 0 | ends the run |
| 0x16–0x1b | IF =, <>, <, >, <=, >= | 0 | makes the **next** instruction conditional |
| 0x20 | NEW ECL | 1 | loads another script; ends the run |
| 0x21 | LOAD FILES | 3 | first operand is the map id |
| 0x24 | COMBAT | 0 | starts a fight |
| 0x25, 0x26 | ON GOTO, ON GOSUB | variable | jump table — see below |
| 0x37 | LOAD PIECES | 3 | the three wall set ids |

Three commands read a count and then that many more operands: **ON GOTO** and **ON GOSUB**
take a selector and a count, **VERTICAL MENU** takes three operands whose last is the count,
**HORIZONTAL MENU** takes two. In each case the cursor steps back one byte before reading
the variable part.

The `IF` commands do not branch. They set a flag that makes the next instruction
conditional, which matters to a decoder: a `RETURN` or `GOTO` immediately after an `IF` may
not be taken, so decoding has to carry on past it.

### Events

A cell's event number indexes a jump table built by an `ON GOTO`. A block contains several
such tables; the level's event dispatch is **the largest one with more than four entries**.

**Unverified:** that event number *N* is entry *N* of that table rather than *N − 1*.
Direct indexing is the natural reading, and event 0 means "no event" on a cell. One real
level tells you which it is.

### Which wall set a level uses

From the script, not the level: the block whose `LOAD FILES` names this map is the level's
script, and its `LOAD PIECES` gives the three wall set ids. Wall set ids are WALLDEF block
ids across all the WALLDEF files. Where no script is found, the loader falls back to the
WALLDEF block whose id matches the map's.

### What this decoder does not do

It reads the scripts; it does not run them. There is no party, no clock and no flags to
evaluate conditions against, so branches are not taken — both sides of every `IF` are
reported. That makes an event summary a description of what an event *can* do, which is
the honest thing to show without a full game state.

---

## Identifying the game — `src/formats/detect.ts`

By the config file each release dropped next to its data, which survives patching better than
file sizes do:

| file | game |
|---|---|
| `POOL.CFG` | Pool of Radiance |
| `CURSE.CFG` | Curse of the Azure Bonds |
| `BLADES.CFG` | Secret of the Silver Blades |
| `POOL4.CFG` | Pools of Darkness |
| `KRYNN.CFG` | Champions of Krynn |
| `DKK.CFG` | Death Knights of Krynn |
| `BUCK.CFG` | Buck Rogers: Countdown to Doomsday |
| `MATRIX.CFG` | Buck Rogers: Matrix Cubed |
| `TREASURE.CFG` | Treasures of the Savage Frontier |
| `GAME.CFG` + `8X8D6.DAX` | Gateway to the Savage Frontier |
| `GAME.CFG` + `CPIC.DAX` | Neverwinter Nights (AOL) |

---

## Not implemented

Everything a full game needs beyond walking around a level:

- **Running the scripts** — the decoder reads ECL but does not execute it. That needs the
  party, the flags and the clock the conditions test against.
- **Items, monsters, spells** — `ITEM*.DAX` and friends.
- **Text** — the string tables behind every message in the game.
- **Saved games and characters** — `*.SAV`, the character vault.
- **Combat maps** — a different layout again from the exploration maps.
- **Non-DOS releases** — the Amiga and C64 builds pack their data differently
  (the Amiga uses ByteKiller compression, not this RLE).
