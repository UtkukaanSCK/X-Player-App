import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** The player's working copy, when this folder sits next to it. */
const SIBLING = resolve(import.meta.dirname, '..')
const SIBLING_SRC = resolve(SIBLING, 'src/index.ts')
const useSibling = existsSync(SIBLING_SRC)

export default defineConfig({
  // Everything is loaded from disk by Electron, so assets must be relative.
  base: './',
  plugins: [react()],
  resolve: {
    /*
     * One React, always.
     *
     * The player is compiled from the sibling checkout, which has its own
     * node_modules, so without this the bundle ends up with two copies of
     * React. Hooks then read a dispatcher belonging to the other copy and the
     * first useRef throws "Cannot read properties of null".
     */
    dedupe: ['react', 'react-dom'],
    alias: useSibling
      ? {
          'x-player/style.css': resolve(SIBLING, 'src/player/styles/player.css'),
          'x-player': SIBLING_SRC,
        }
      : {},
  },
  build: {
    outDir: 'out/renderer',
    emptyOutDir: true,
  },
  server: {
    port: 5176,
    strictPort: true,
  },
})
