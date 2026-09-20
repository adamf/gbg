/**
 * Reports what is actually in a game folder, so a parser can be checked against
 * real bytes rather than hoped about.
 *
 *   npm run inspect -- /path/to/game            what the folder holds
 *   npm run inspect -- /path/to/game GEO1.DAX   every block in one archive
 *   npm run inspect -- /path/to/game GEO1.DAX 21  a hex dump of one block
 *   npm run inspect -- /path/to/game ECL1.DAX 1   a disassembly of one script
 */

import { decodeEcl, memStartFor, summariseEvent, type EclInstruction, type EclProgram } from '../formats/ecl.js'
import { classifyBlock } from '../formats/image.js'
import { GameLibrary } from '../formats/library.js'
import { directorySource } from './node-source.js'

async function main(): Promise<void> {
  // Piping into `head` closes stdout early; that is the caller being done, not an error.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0)
    throw error
  })

  const [path, archiveName, blockArg] = process.argv.slice(2)
  if (!path) {
    console.error('usage: inspect <game-folder> [ARCHIVE.DAX] [blockId]')
    process.exitCode = 1
    return
  }

  const library = new GameLibrary(await directorySource(path))

  if (!archiveName) {
    await summariseFolder(library)
    return
  }

  const archive = await library.archive(archiveName)
  if (!archive) {
    console.error(`no such file in that folder: ${archiveName}`)
    process.exitCode = 1
    return
  }

  if (blockArg === undefined) {
    console.log(`${archive.name} — ${archive.blocks.length} blocks`)
    for (const problem of archive.problems) console.log(`  ! ${problem}`)
    console.log('   id   bytes  stored  looks like')
    for (const block of archive.blocks) {
      const kind = classifyBlock(block.data, archive.name)
      console.log(
        `  ${String(block.id).padStart(3)}  ${String(block.data.length).padStart(6)}` +
        `  ${block.stored ? '  yes ' : '   no '}  ${kind}`,
      )
    }
    return
  }

  const id = Number(blockArg)
  const block = archive.blocks.find((b) => b.id === id)
  if (!block) {
    console.error(`no block ${id} in ${archive.name}`)
    process.exitCode = 1
    return
  }

  if (archive.name.startsWith('ECL')) {
    disassemble(decodeEclBlock(library, id, block.data))
    return
  }

  console.log(`${archive.name} block ${id}: ${block.data.length} bytes, ${classifyBlock(block.data, archive.name)}`)
  hexDump(block.data)
}

function decodeEclBlock(library: GameLibrary, id: number, data: Uint8Array): EclProgram {
  return decodeEcl(id, data, memStartFor(library.game.id))
}

async function summariseFolder(library: GameLibrary): Promise<void> {
  console.log(`Game: ${library.game.title}${library.game.year ? ` (${library.game.year})` : ''}`)

  const levels = await library.levels()
  console.log(`\nLevels (${levels.length}):`)
  for (const level of levels) {
    const events = await library.eventsFor(level)
    const script = events
      ? `${events.summaries.size} events` +
        (events.program.loadsWallSets[0] ? `, walls ${events.program.loadsWallSets[0].join('/')}` : '')
      : 'no script'
    console.log(`  ${level.file} #${String(level.id).padStart(3)}  ${level.name.padEnd(36)} ${script}`)
  }

  console.log(`\nWall definition files: ${library.wallDefFiles().join(', ') || 'none'}`)

  console.log('\nArchives:')
  for (const name of allDax(library)) {
    const archive = await library.archive(name)
    if (!archive) continue
    const kinds = new Map<string, number>()
    for (const block of archive.blocks) {
      const kind = classifyBlock(block.data, archive.name)
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
    }
    const summary = [...kinds].map(([kind, n]) => `${n} ${kind}`).join(', ')
    const warn = archive.problems.length > 0 ? `  (${archive.problems.length} problem blocks)` : ''
    console.log(`  ${name.padEnd(16)} ${String(archive.blocks.length).padStart(4)} blocks  ${summary}${warn}`)
  }
}

/** The archives worth summarising: levels, wall definitions and their tile sets. */
function allDax(library: GameLibrary): string[] {
  const tileFiles = ['8X8D.DAX', ...Array.from({ length: 8 }, (_, i) => `8X8D${i}.DAX`)]
  return [
    ...library.geoFiles(),
    ...library.wallDefFiles(),
    ...tileFiles.filter((name) => library.has(name)),
  ]
}

/** Prints a decoded script: its entry points, what it loads, and its instructions. */
function disassemble(program: EclProgram): void {
  const hex = (n: number, width = 4) => `0x${n.toString(16).padStart(width, '0')}`

  console.log(`ECL block ${program.blockId}, loaded at ${hex(program.memStart)}`)
  console.log(`  entry points: start ${hex(program.entryPoints.start)}, vmRun ${hex(program.entryPoints.vmRun)},` +
    ` search ${hex(program.entryPoints.searchLocation)}, preCamp ${hex(program.entryPoints.preCampCheck)},` +
    ` campInterrupted ${hex(program.entryPoints.campInterrupted)}`)
  if (program.loadsMaps.length > 0) console.log(`  loads maps: ${program.loadsMaps.join(', ')}`)
  for (const set of program.loadsWallSets) console.log(`  loads wall sets: ${set.join(', ')}`)

  if (program.events.length > 0) {
    console.log(`\n  events (${program.events.length}):`)
    for (let event = 0; event < program.events.length; event++) {
      const summary = summariseEvent(program, event)
      const where = hex(program.events[event]!)
      const says = summary && summary.text.length > 0 ? `  "${summary.text[0]}"` : ''
      const fights = summary?.fights ? '  [combat]' : ''
      console.log(`    ${String(event).padStart(3)}  ${where}${fights}${says}`)
    }
  }

  for (const problem of program.problems.slice(0, 20)) console.log(`  ! ${problem}`)
  if (program.problems.length > 20) console.log(`  ! …and ${program.problems.length - 20} more`)

  console.log(`\n  ${program.instructions.size} instructions:`)
  const eventAt = new Map(program.events.map((address, event) => [address, event]))
  let previousEnd = -1

  for (const address of [...program.instructions.keys()].sort((a, b) => a - b)) {
    const instruction = program.instructions.get(address)!
    if (address !== previousEnd) console.log('')
    const label = eventAt.get(address)
    if (label !== undefined) console.log(`    ; event ${label}`)
    console.log(`    ${hex(address)}  ${formatInstruction(instruction)}`)
    previousEnd = address + instruction.length
  }
}

function formatInstruction(instruction: EclInstruction): string {
  const targets = new Set(instruction.targets)

  const parts = instruction.operands.map((operand) => {
    // An operand the instruction can jump to reads as an address, not a number.
    if (targets.has(operand.word) && (operand.kind === 'literal' || operand.kind === 'memory')) {
      return `0x${operand.word.toString(16).padStart(4, '0')}`
    }
    switch (operand.kind) {
      case 'immediate': return String(operand.word)
      case 'literal': return `#${operand.word}`
      case 'memory': return `[0x${operand.word.toString(16).padStart(4, '0')}]`
      case 'inline-string':
      case 'string-pointer': return JSON.stringify(operand.text ?? '')
      default: return `?${operand.code.toString(16)}:${operand.word}`
    }
  })
  return `${instruction.name.padEnd(16)} ${parts.join(', ')}`.trimEnd()
}

/** Sixteen bytes a line, with printable characters alongside. */
function hexDump(data: Uint8Array, limit = 1088): void {
  for (let offset = 0; offset < Math.min(data.length, limit); offset += 16) {
    const slice = data.subarray(offset, offset + 16)
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47)
    const text = [...slice].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')
    console.log(`  ${offset.toString(16).padStart(4, '0')}  ${hex}  ${text}`)
  }
  if (data.length > limit) console.log(`  … ${data.length - limit} more bytes`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
