/**
 * Extracts a game folder to PNGs and JSON.
 *
 *   npm run dump -- /path/to/game ./out
 *
 * Writes every picture it can decode, every level as JSON and as a wall-set preview,
 * so the data can be checked by eye and used by other tools.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { decodeAnyImage } from '../formats/image.js'
import { GameLibrary } from '../formats/library.js'
import { encodePng } from './png.js'
import { directorySource } from './node-source.js'

async function main(): Promise<void> {
  const [path, outDir = 'out'] = process.argv.slice(2)
  if (!path) {
    console.error('usage: dump <game-folder> [output-folder]')
    process.exitCode = 1
    return
  }

  const source = await directorySource(path)
  const library = new GameLibrary(source)
  console.log(`${library.game.title}: extracting to ${outDir}`)

  await mkdir(outDir, { recursive: true })

  // ---- pictures ---------------------------------------------------------
  const archives = source.list().filter((name) => name.endsWith('.DAX'))
  let pictureCount = 0

  for (const name of archives) {
    const archive = await library.archive(name)
    if (!archive) continue

    const stem = name.replace(/\.DAX$/, '')
    for (const block of archive.blocks) {
      const decoded = decodeAnyImage(block.data, name)
      if (!decoded || decoded.frames.length === 0) continue

      const dir = join(outDir, 'images', stem)
      await mkdir(dir, { recursive: true })
      for (const [index, frame] of decoded.frames.entries()) {
        const suffix = decoded.frames.length > 1 ? `_${String(index).padStart(2, '0')}` : ''
        await writeFile(join(dir, `${String(block.id).padStart(3, '0')}${suffix}.png`), encodePng(frame, 2))
        pictureCount++
      }
    }
  }
  console.log(`  ${pictureCount} pictures`)

  // ---- levels -----------------------------------------------------------
  const levels = await library.levels()
  await mkdir(join(outDir, 'levels'), { recursive: true })
  await mkdir(join(outDir, 'walls'), { recursive: true })

  const index: unknown[] = []
  for (const ref of levels) {
    const map = await library.level(ref)
    if (!map) continue

    const wallSet = await library.wallSetFor(ref)
    const stem = `${ref.file.replace(/\.DAX$/, '')}_${String(ref.id).padStart(3, '0')}`

    await writeFile(
      join(outDir, 'levels', `${stem}.json`),
      JSON.stringify({ id: map.id, name: ref.name, file: ref.file, cells: map.cells, wallSources: wallSet.sources }, null, 2),
    )

    for (const [index_, texture] of wallSet.textures.entries()) {
      await writeFile(join(outDir, 'walls', `${stem}_wall${index_ + 1}.png`), encodePng(texture, 3))
    }

    index.push({ file: ref.file, id: ref.id, name: ref.name, wallTextures: wallSet.textures.length })
    console.log(`  ${ref.name} (${wallSet.textures.length} wall graphics)`)
  }

  await writeFile(
    join(outDir, 'index.json'),
    JSON.stringify({ game: library.game, levels: index }, null, 2),
  )

  console.log(`Done: ${levels.length} levels, ${pictureCount} pictures.`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
