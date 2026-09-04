import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'vite'
import { buildElectron } from './esbuild-electron.mjs'

/**
 * Development: Vite serves the window with hot reload, esbuild watches the
 * Electron side, and the app is pointed at the dev server.
 *
 * Changing anything under electron/ needs a restart - the main process cannot
 * hot reload itself - so the watcher only rebuilds, and says so.
 */
const require = createRequire(import.meta.url)

const contexts = await buildElectron({ watch: true })

const server = await createServer()
await server.listen()
const url = server.resolvedUrls?.local?.[0]
if (!url) throw new Error('the dev server did not report a URL')
console.log(`\nrenderer: ${url}`)

const env = { ...process.env, XPLAYER_DEV_SERVER: url }
// Set in some shells by other tooling. Left in place it makes Electron run as
// plain Node, and require('electron') then returns a path string instead of the
// API, which fails in a way that looks nothing like its cause.
delete env.ELECTRON_RUN_AS_NODE

const electron = spawn(require('electron'), ['.'], { stdio: 'inherit', env })

const shutdown = async () => {
  await Promise.all(contexts.map((c) => c.dispose()))
  await server.close()
  process.exit(0)
}

electron.on('exit', () => void shutdown())
process.on('SIGINT', () => void shutdown())
