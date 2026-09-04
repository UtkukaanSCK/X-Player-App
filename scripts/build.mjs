import { build } from 'vite'
import { buildElectron } from './esbuild-electron.mjs'

await buildElectron({ minify: true })
await build()

console.log('\nBuilt out/main and out/renderer.')
