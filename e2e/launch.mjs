import { resolve } from 'node:path'
import { _electron as electron } from 'playwright'

export const APP = resolve(import.meta.dirname, '..')
export const FIXTURES = resolve(import.meta.dirname, '../fixtures')

/**
 * Starts the built app and waits for its window.
 *
 * ELECTRON_RUN_AS_NODE is stripped because some shells export it: with it set,
 * Electron starts as plain Node, require('electron') hands back a path string
 * rather than the API, and the app dies with an error that points nowhere near
 * the cause.
 */
export async function launchApp() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const app = await electron.launch({ args: [APP], env })
  const page = await app.firstWindow()
  await page.waitForSelector('.shell')
  return { app, page }
}

/** Hands the app a file exactly as the operating system does. */
export async function deliver(app, path) {
  await app.evaluate(({ BrowserWindow }, paths) => {
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:open-paths', paths)
  }, [path])
}
