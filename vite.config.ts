import { readdir, readFile, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/**
 * Dev-server-only: serves the folder named by GOLDBOX_DATA at /dev-data/ so the page can
 * load a game without the folder picker on every reload. Files never leave the machine —
 * this is the local Vite server reading a local folder for a local tab. It is not part of
 * the build, and no game data is ever copied into the repository.
 */
function devGameFolder(): Plugin {
  const folder = process.env.GOLDBOX_DATA
  return {
    name: 'goldbox-dev-data',
    apply: 'serve',
    configureServer(server) {
      if (!folder) return
      server.middlewares.use('/dev-data/', async (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '/').replace(/^\/+/, '').split('?')[0])
        // Only flat file names: no subpaths, no traversal.
        if (name !== basename(name)) return next()
        try {
          if (name === 'index.json') {
            const entries = await readdir(folder, { withFileTypes: true })
            const names = entries.filter((e) => e.isFile()).map((e) => e.name)
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ folder: basename(folder), names }))
            return
          }
          const path = join(folder, name)
          if (!(await stat(path)).isFile()) return next()
          res.setHeader('content-type', 'application/octet-stream')
          res.end(await readFile(path))
        } catch {
          res.statusCode = 404
          res.end()
        }
      })
      server.config.logger.info(`  ➜  serving game folder ${folder} at /dev-data/ (dev only)`)
    },
  }
}

export default defineConfig({
  base: './',
  build: { target: 'es2022', outDir: 'dist' },
  plugins: [devGameFolder()],
})
