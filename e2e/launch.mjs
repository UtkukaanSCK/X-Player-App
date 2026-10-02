import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'

export const APP = resolve(import.meta.dirname, '..')
export const FIXTURES = resolve(import.meta.dirname, '../fixtures')

/**
 * Removes a throwaway profile. On Windows Electron can still hold files in it
 * when the app closes, and `force` only forgives a missing path, so the removal
 * retries and then gives up quietly: a leftover temp folder must never turn a
 * suite that passed into a crash inside an event handler.
 */
function removeProfile(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // The operating system clears the temp folder eventually.
  }
}

/**
 * Starts the built app and waits for its window.
 *
 * ELECTRON_RUN_AS_NODE is stripped because some shells export it: with it set,
 * Electron starts as plain Node, require('electron') hands back a path string
 * rather than the API, and the app dies with an error that points nowhere near
 * the cause.
 */
export async function launchApp({ isolated = false } = {}) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  // A throwaway profile keeps a run away from the owner's recents, volume and
  // window state. It is opt-in: a first run has cold caches, and playback.mjs's
  // first-frame budget is measured against a warm profile.
  const userData = isolated ? mkdtempSync(join(tmpdir(), 'xplayer-e2e-')) : null
  const args = userData ? [APP, `--user-data-dir=${userData}`] : [APP]
  let app
  try {
    app = await electron.launch({ args, env })
  } catch (err) {
    if (userData) removeProfile(userData)
    throw err
  }
  if (userData) app.on('close', () => removeProfile(userData))
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
