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
| 0x13 | RETURN | 0 | ends the run, or returns from a GOSUB |
| 0x33 | PRINT RETURN | 0 | a line break in the text box |
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

Event number *N* is entry *N* of that table — the interpreter's ON GOTO indexes from
zero, and running a real level confirms it. Event 0 is not "no event": it is the entry
most levels run on every ordinary square, usually a random-encounter roll.

### Which wall set a level uses

From the script, not the level: the block whose `LOAD FILES` names this map is the level's
script, and its `LOAD PIECES` gives the three wall set ids. Wall set ids are WALLDEF block
ids across all the WALLDEF files. Where no script is found, the loader falls back to the
WALLDEF block whose id matches the map's.

### Running them — `src/engine/ecl-vm.ts`

The decoder walks the code; the interpreter executes it, with the semantics of the
Curse of the Azure Bonds reimplementation (`coab`, `engine/ovr003.cs`). The things a
reader needs to know:

- **Memory is 16-bit words at 16-bit addresses**, except the script's own bytes, which
  are bytes. Reads of `0xC04B`–`0xC04F` return the party's column, row, facing, the wall
  ahead and the square's event byte; writes to the first three move the party.
- **COMPARE a, b** sets six flags for `a = b`, `a <> b`, `a < b`, `a > b`, `a <= b`,
  `a >= b`; **IF** skips the *next instruction* when its flag is false. AND and OR leave
  the flags as if comparing zero with the result, so an `IF <` after them means "not
  zero".
- **SUBTRACT a, b, dst** stores `b - a`; the other arithmetic is in operand order.
- **RANDOM n, dst** stores 0..n inclusive.
- **ON GOTO sel, count, t0..** jumps to `t[sel]` and falls through when `sel >= count`.
  That settles the question above: event *N* is entry *N*, and event 0 is a real
  handler — the random-encounter code most levels run on every empty square.
- **GET TABLE base, i, dst** reads `base + i`; **SAVE TABLE v, base, i** writes it.
- **NEW ECL n** loads script *n* and runs its start entry; **LOAD FILES** and
  **LOAD PIECES** swap the map and wall sets under the party without moving them.

The five entry points run in a fixed order: `start` when a script is loaded, then
`vmRun` and `searchLocation` — the latter being the event dispatch — after that and
after every step. `preCampCheck` and `campInterrupted` bracket resting, which is not
built yet.

Training halls write the classes they teach as a mask to `0x6DA8` — bit 0 magic-user,
bit 1 cleric, bit 2 thief, bit 3 fighter — and call PROGRAM 0, the original's party
menu, where Train appeared. New Phlan's hall (ECL3 block 11) runs on the city's own
map: the city's events 10 and 17 hand over to it, and its search routine subtracts
ten from the cell's event byte, so the schools' doors are the cells marked 12
(clerics), 13 (magic-users), 16 (fighters) and 17 (thieves). Its arena master picks a
character with WHO, then `CALL 0x8000` before a COMBAT with no monsters loaded: a
sparring bout against an even match, not to the death, paid at a hundred experience
a level (coab `calc_battle_exp`, the duel case).

A TREASURE whose item value is 0x80 or more asks for that many random items, rolled
on a table that is mostly ordinary arms and armour with a few swords, scrolls,
potions, wands, rings and bracers (coab `CMD_Treasure`). Whether the original also
rolled a plus for them is not known; here they are built from a shipped record of
the type and a plain weapon stays plain.

The hall's doorway is a cell walled on all four sides with doors in two of them.

### Combat art

`CBODY.DAX` and `CHEAD.DAX` are the party's icons in parts. A body is a 48×48 frame
(the figure and its readied weapon; 32 of them), a head a 48×20 strip drawn over the
body's top (14 of them). Each part has four ids: `n` normal, `n + 64` the small size,
`n + 128` the action pose, `n + 192` small and in action. The art is drawn in template
colours that the record's six swap pairs at 0xC1 replace. `CPIC?.DAX` are the
monsters' icons, with the same `+128` action frame. `ICON.DAX` is the party on
horseback for the wilderness map, two frames.

`COMSPR.DAX` is what flew across the combat screen: block 0 an arrow upright, 1 an
arrow on the diagonal, 2 an arrow across, 3 a thrown axe, 4 a flask, 5 a dart, 6 a
lightning bolt, 7 a boulder, 8 a sling stone, 9 sparkles, 10 a burst, 11 a skull; each
with a second frame at `+128` — for the arrows pointing the other way, for the thrown
things another turn of the tumble, for the burst the large one.

`SQRPACI.DAX` and `BACPAC.DAX` are 48×48 terrain tiles — grass, hills, mountains,
rivers, forest — which must be the wilderness map's. The map that indexes them is
not found yet; the wilderness scripts' overland coordinates run on it.

`.SPC` files (a member's `CHRDATx.SPC`, a monster's `MON?SPC.DAX` block) are nine-byte
records that look like the lasting effects on a character rather than spells; not read. A
four-walled cell is solid rock only when it has no door at all. Two more area words matter to the loop around the scripts: `0x6DD2`/`0x6DD3` are how often
(hours) and how likely (percent) a resting party is interrupted, and `0x6DE2`/`0x6E6C`
set before a COMBAT with no monsters loaded mean the temple and the shop.

### The order of a step

coab's 3D loop (`ovr003`) runs the script's per-step entry *before* the party moves,
from the square it stands on and facing the way it means to go; the entry may take the
party elsewhere or refuse the move by writing 255 to `0x6DC9`. Only then does the party
step, and the square it lands on runs the search entry. Getting this backwards made
the city clerk's office refuse everyone: its per-step code guards her south and east
doors against a party without a commission, and a party that had just stepped in from
the anteroom looked, from the wrong side of the move, like one trying to leave.

### What the interpreter does not do yet

Spells, items in play, CHECK PARTY and shops. Those commands run, do nothing, and say
so in the page's notes. Combat is resolved a round at a time without the grid.

---

## The combat map — `src/engine/arena.ts`

Before a fight the original built a 50×25 grid of DUNGCOM tile indexes from the
thirteen-by-five dungeon squares around the party (`sub_378CD0`; `SetupDungeonFloor`
in the coab disassembly, which this is a port of). A square is a patch six wide and
five tall at `(dx·6 + dy·5 + 21, dy·5 + 10)`, so each dungeon row sits five columns
right of the one above and north–south walls run as diagonals. Rows 2–4 are floor
(piece 22); a west wall is a three-wide diagonal band of pieces 4, 3, 13 across them;
a north wall is pieces 5 over 10 in columns 3–4 of rows 0–1; the two-by-two corners
at columns 1–2 and 5–6 are chosen from the walls of the squares above and beside.
A side reads as 0 open, 1 wall, 3 door, OR'd across the boundary. The grid holds ids
into the original's background tile table, which gives each id an art cell and a
move cost; 255 cannot be stood on, which makes some corner slivers walkable and the
walls not. A room flagged with bit 6 of its event byte may get a table (id 0x1A, the
first RANDCOM cell) with chairs around it. Outdoors the same grid is filled by the
wilderness routine: open ground (WILDCOM cell 22), by the region's terrain flags a
river slanting with the map, clearings of rough ground, and scenery rolled onto the
rest; the region flags are not yet read from the game, so every outdoor fight is
wooded.

## Saved games — `src/formats/library.ts`

`SAVGAM?.DAT`, one letter per slot. Pool of Radiance ships `A` and `J`: the starting
state of a new game with each of its two pre-made parties. The layout is the one
`coab` loads:

| offset | size | meaning |
|---|---|---|
| 0 | 1 | area number — which ECL, GEO, PIC and SPRIT files are current |
| 1 | 0x800 | game globals: addresses `0x4900`–`0x4CFF`, two bytes per address |
| 0x801 | 0x800 | area and character scratch: addresses `0x6B00`–`0x6FFF` |
| 0x1001 | 0x400 | more scratch: addresses `0x9700`–`0x98FF` |
| 0x1401 | 0x1E00 | the current script image, not read |
| 0x3201 | 7 | position and state bytes, not read |
| 0x3208 | 1 + 8 × 41 | party size, then each member's file base name, length-prefixed |

Among the globals, in word offsets: `0x18E`–`0x196` the clock (minutes ones, minutes
tens, hour, day, year), `0x1E0`/`0x1E2` the party's last column and row, `0x1E4` the
last script loaded. A new game therefore starts in the Slums, at 10:50.

---

## Characters — `src/formats/character.ts`

Each party member is three files named after a slot: `CHRDATA1.SAV` (the record),
`.ITM` (inventory) and `.SPC` (memorised spells, not read yet). A saved game lists the
slots its party uses.

The record is 285 bytes: the Curse of the Azure Bonds layout with a 56-byte spell book
where Curse has 100. Offsets checked against every character Pool of Radiance ships:

| offset | meaning |
|---|---|
| 0x00 | name, length-prefixed, up to 15 |
| 0x10 | STR INT WIS DEX CON CHA, then exceptional strength |
| 0x2D | to-hit, stored as `60 - THAC0` |
| 0x2E, 0x2F | race, class (see `RACES`, `CLASSES`) |
| 0x30 | age, `i16` |
| 0x32 | hit points, maximum |
| 0x33 | spell book, 56 bytes |
| 0x6D | five saving throws |
| 0x72, 0x73 | base movement, hit dice |
| 0x78 | eight thief skills |
| 0x85 | control: 0 is the player's, above that an NPC's morale |
| 0x88 | seven `i16` coins: copper, silver, electrum, gold, platinum, gems, jewellery |
| 0x96 | eight class levels: cleric, druid, fighter, paladin, ranger, magic-user, thief, monk |
| 0x9E, 0xA0 | sex, alignment |
| 0xA1 | attacks per round, doubled |
| 0xA9 | base armour class, `60 - AC` |
| 0xAC | experience, `i32` |
| 0xBD, 0xBE | combat icon parts: the CHEAD strip and the CBODY frame (the body is the readied weapon's) |
| 0xB1 | hit points rolled, before the constitution bonus |
| 0xB8, 0xBA | what a fallen monster is worth: base experience `i16`, plus this much per hit point rolled |
| 0xC0 | icon size: 1 small (dwarves, gnomes, halflings), 2 normal |
| 0xC1 | six colour swaps for the icon, old nibble high, new nibble low |
| 0x10C | health status |
| 0x110 | to-hit bonus, raw: 40 is none |
| 0x111, 0x112 | armour class front and behind, `60 - AC` |
| 0x115, 0x117, 0x119 | current attack dice, sides, bonus |
| 0x11B, 0x11C | hit points now, movement |

An inventory is 63-byte item records: a name at 0, type at 0x2E, plus at 0x32, readied
at 0x34, cursed at 0x36, weight (tenths of a pound, `i16`) at 0x37, count at 0x39,
value (`i16`) at 0x3A, three affects at 0x3C.

### Item names — `src/formats/items.ts`

An item's three name numbers index one list of words, and the list is not in a data
file: it is inline in `START.EXE` as Pascal literals between the instructions that
print them, one-based from "Battle Axe". The reader scans them out. The game's own
copy has five words the utility lacks — two after "Arrow", two before "Holy Symbol",
one after "of" — found by matching every shipped item; the slots are kept empty. The
display order is the third word, then the second, then the first: "Banded Mail",
"Cloak of Displacement", "Sling of Seeking +2", "Broad Sword -2 Cursed". An item's
*type* is its base word's index and indexes `ITEMS`, whose 16-byte records (after a
two-byte header) hold slot, hands, damage dice against small and large foes, attacks
per round and range.

Shops are scripts: TREASURE with an item block loads that block of the area's
`ITEM*.DAX` onto the ground, and a COMBAT with the shop word set sells from it.

### Spells — `src/formats/spells.ts`

Spell names are inline in `START.EXE` too, one-based from "Bless" (the "Bless" that is
followed by "Curse"): eight first-level prayers, thirteen first-level magic-user
spells, then the second and third levels of each. A character's 56-byte spell book at
0x33 has a 1 per known spell by that numbering, and the six bytes at 0xB2 are spell
slots per level, three cleric levels then three magic-user levels — a level 1 cleric
with 17 wisdom shows 3, which is the bonus the rules give. What is memorised is not
stored in the shipped records (nobody has memorised yet), so the interpreter keeps
its own list. `SPELLS` says what the early spells do; the rest can be memorised and
cast for no effect.

### The selected character in script memory

`LOAD CHARACTER n` and `WHO` pick a party member, and the scripts then read them at
`0x6B00` plus an offset the original's overlay answered by hand: `0x72` race, `0x73`
class, `0x15`/`0x18` INT and CON, `0x9B` the petrification save, `0xA0` hit dice,
`0xA5`–`0xAC` thief skills, `0xB8` control, `0xBB`/`0xBD`/`0xBF`/`0xC1`/`0xC3` copper,
electrum, silver, gold, platinum, `0xC9` magic-user level, `0xD6` sex, `0xD8` alignment,
`0x11B` movement, `0x2CF` charisma as a reaction score, `0x33E` party size, and `0x100`
whether anyone is there at all: 1 standing, 0x80 down, 0 no such member. `0x6B00`
itself reads as the name. `src/engine/roster.ts` answers these.

---

### Writing them back — `src/formats/save-writer.ts`

Each writer starts from the bytes that were read, where there are any, and patches in
what this program models, so the fields it does not understand survive. A saved game is
written as the layout above with the current script image and position, and the party
named `CHRDAT?1`–`CHRDAT?6` for the slot letter, the way the shipped J party is. Camp's
EXPORT hands the files to the browser's download dialog; nothing leaves the machine.

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
