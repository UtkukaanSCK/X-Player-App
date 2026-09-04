import { context } from 'esbuild'

/**
 * The Electron side is bundled to CommonJS.
 *
 * Not a stylistic choice: a sandboxed preload script has to be CJS, and the
 * main process wants `__dirname` to find the preload and the built window next
 * to itself. Everything Electron provides stays external.
 */
const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
}

export async function buildElectron({ watch = false, minify = false } = {}) {
  const contexts = await Promise.all([
    context({ ...shared, minify, entryPoints: ['electron/main.ts'], outfile: 'out/main/main.cjs' }),
    context({ ...shared, minify, entryPoints: ['electron/preload.ts'], outfile: 'out/main/preload.cjs' }),
  ])

  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()))
    return contexts
  }

  await Promise.all(contexts.map((c) => c.rebuild()))
  await Promise.all(contexts.map((c) => c.dispose()))
  return []
}
