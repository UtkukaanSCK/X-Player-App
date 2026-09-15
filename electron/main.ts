import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { capabilities, ffmpegAvailable, useCapabilityCache } from './gateway/ffmpeg'
import { startGateway, type GatewayHandle } from './gateway/server'
import { sweepStaleTempDirs } from './gateway/session'
import { toMedia } from './media'
import type { Diagnostics, OpenFailure, OpenResult, Preferences, RecentEntry } from '../shared/api'

/** Everything the app will attempt to open. The gateway decides how. */
const VIDEO_EXTENSIONS = [
  'mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'ts', 'm2ts', 'mts',
  'mpg', 'mpeg', 'm2v', 'vob', 'ogv', 'ogm', 'asf', 'divx', 'f4v', '3gp', 'rm',
]
const VIDEO_SET = new Set(VIDEO_EXTENSIONS.map((e) => `.${e}`))

const RECENT_LIMIT = 12

const PLATFORM =
  process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'macos'
      : process.platform === 'linux'
        ? 'linux'
        : 'other'
const DEV_SERVER = process.env.XPLAYER_DEV_SERVER

/**
 * Chromium blocks autoplay until the page has been interacted with, which is
 * right for a web page and wrong here: double-clicking a film in Explorer is
 * the interaction. Without this, opening a file shows a play button and waits.
 */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

let gateway: GatewayHandle | null = null
let window: BrowserWindow | null = null
/** Paths handed to us before the window was ready to hear about them. */
let pendingPaths: string[] = []
/** The file on screen, so opening the next one can let go of this one. */
let openFileId: string | null = null

/* ------------------------------------------------------------------ recents */

function recentFile() {
  return join(app.getPath('userData'), 'recent.json')
}

async function readRecent(): Promise<RecentEntry[]> {
  try {
    const raw = await readFile(recentFile(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as RecentEntry[]) : []
  } catch {
    return []
  }
}

async function rememberRecent(path: string, name: string) {
  const list = await readRecent()
  const next = [{ path, name, at: Date.now() }, ...list.filter((e) => e.path !== path)].slice(0, RECENT_LIMIT)
  await writeFile(recentFile(), JSON.stringify(next), 'utf8').catch(() => {})
}

/* -------------------------------------------------------------- preferences */

function preferencesFile() {
  return join(app.getPath('userData'), 'preferences.json')
}

const DEFAULT_PREFERENCES: Preferences = { volume: 1, rate: 1 }

/**
 * Clamped on the way in and on the way out.
 *
 * These arrive from the window, and a rate of 0 or a volume of NaN would leave
 * the player in a state with no way back through the interface. The file on disk
 * is equally untrusted: it is editable, and a corrupt one should mean defaults
 * rather than a player that will not play.
 */
function sanePreferences(raw: unknown): Preferences {
  const value = (raw ?? {}) as Partial<Preferences>
  const clamp = (n: unknown, low: number, high: number, fallback: number) =>
    typeof n === 'number' && Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback
  return {
    volume: clamp(value.volume, 0, 1, DEFAULT_PREFERENCES.volume),
    rate: clamp(value.rate, 0.25, 4, DEFAULT_PREFERENCES.rate),
  }
}

async function readPreferences(): Promise<Preferences> {
  try {
    return sanePreferences(JSON.parse(await readFile(preferencesFile(), 'utf8')))
  } catch {
    return DEFAULT_PREFERENCES
  }
}

async function writePreferences(next: Preferences) {
  await writeFile(preferencesFile(), JSON.stringify(sanePreferences(next)), 'utf8').catch(() => {})
}

/* ------------------------------------------------------------- file handling */

function isVideo(path: string) {
  return VIDEO_SET.has(extname(path).toLowerCase())
}

/** Turns whatever the OS or a drop handed us into a list of playable files. */
async function expandPaths(paths: string[]): Promise<string[]> {
  const out: string[] = []
  for (const path of paths) {
    try {
      const entries = await readdir(path, { withFileTypes: true })
      const inside = entries
        .filter((e) => e.isFile() && isVideo(e.name))
        .map((e) => join(path, e.name))
        // Natural order, so "Episode 2" comes before "Episode 10".
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      out.push(...inside)
    } catch {
      // Not a directory. Take it if it looks playable.
      if (isVideo(path)) out.push(path)
    }
  }
  return out
}

/**
 * Picks the file arguments out of a command line.
 *
 * Windows and Linux hand the app an associated file this way, and so does a
 * second launch while one is already running. macOS uses the open-file event
 * instead, which is handled separately. Electron's own switches have to be
 * filtered out or the app tries to play "--allow-file-access".
 */
function pathsFromArgv(argv: string[]): string[] {
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((arg) => !arg.startsWith('-'))
    .map((arg) => resolve(arg))
    .filter(isVideo)
}

function deliverPaths(paths: string[]) {
  if (paths.length === 0) return
  if (window && !window.webContents.isLoading()) {
    window.webContents.send('desktop:open-paths', paths)
    if (window.isMinimized()) window.restore()
    window.focus()
  } else {
    pendingPaths.push(...paths)
  }
}

/** Only a real web link may be handed to the operating system to open. */
function isWebLink(url: string): boolean {
  try {
    const scheme = new URL(url).protocol
    return scheme === "http:" || scheme === "https:"
  } catch {
    return false
  }
}

/* --------------------------------------------------------------------- window */

function createWindow() {
  /*
   * No application menu.
   *
   * autoHideMenuBar only hides it; the accelerators stay live, so in a packaged
   * build Ctrl+R reloads the app in the middle of a film and Ctrl+Shift+I opens
   * DevTools. A video player should own its own keys.
   */
  Menu.setApplicationMenu(null)

  window = new BrowserWindow({
    width: 1280,
    height: 760,
    /*
     * Wide enough that the queue cannot squeeze the player into its phone
     * layout. The player drops the volume slider and both skip buttons at
     * 560px, and the queue is 240px at this size - so 820 leaves the stage 580
     * and the controls intact. Below that the two were fighting and the video
     * lost, silently.
     */
    minWidth: 820,
    minHeight: 460,
    backgroundColor: '#141416',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.once('ready-to-show', () => {
    window?.show()
    if (pendingPaths.length > 0) {
      window?.webContents.send('desktop:open-paths', pendingPaths)
      pendingPaths = []
    }
  })

  // Nothing in this app should ever navigate. A link opens in the real browser -
  // but only if it is a web link. openExternal hands anything else to the OS to
  // decide what to run, which is not a decision this window should be making.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebLink(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  if (DEV_SERVER) void window.loadURL(DEV_SERVER)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))

  window.on('closed', () => {
    window = null
  })
}

/* ------------------------------------------------------------------------ ipc */

function registerIpc() {
  ipcMain.handle('desktop:pick', async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({
      title: 'Open video',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Video', extensions: VIDEO_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('desktop:pick-folder', async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({
      title: 'Open folder',
      properties: ['openDirectory'],
    })
    return result.canceled ? [] : expandPaths(result.filePaths)
  })

  ipcMain.handle('desktop:expand', (_e, paths: string[]) => expandPaths(paths))

  ipcMain.handle('desktop:open', async (_e, path: string): Promise<OpenResult | OpenFailure> => {
    if (!gateway) return fail(path, 'the media gateway is not running')
    try {
      const file = await gateway.open(path)
      // Recents used to be written before this check, so a file the app then
      // refused to open still landed in the list of things you had watched.
      if (!file.info.video) return fail(path, 'this file has no video stream')
      await rememberRecent(file.info.path, file.info.name)

      /*
       * Let the previous file go before warming this one.
       *
       * Nothing used to release a session: they were dropped only by the LRU
       * once a fifth appeared, so skipping through a queue left up to four
       * ffmpeg processes transcoding files nobody was watching, each for the
       * full length of its run. Changing audio track is not an open, so it does
       * not reach here and does not lose its session.
       */
      if (openFileId && openFileId !== file.id) gateway.release(openFileId)
      openFileId = file.id

      const audio = defaultAudio(file)
      gateway.warm(file.id, audio)
      return { ok: true, media: toMedia(gateway, file, audio) }
    } catch (err) {
      return fail(path, err instanceof Error ? err.message : String(err))
    }
  })

  ipcMain.handle('desktop:set-audio', async (_e, id: string, order: number): Promise<OpenResult | OpenFailure> => {
    if (!gateway) return fail('', 'the media gateway is not running')
    const file = gateway.get(id)
    if (!file) return fail('', 'this file is no longer open')
    return { ok: true, media: toMedia(gateway, file, order) }
  })

  ipcMain.handle('desktop:preferences', () => readPreferences())
  ipcMain.handle('desktop:save-preferences', (_e, next: Preferences) => writePreferences(next))

  ipcMain.handle('desktop:recent', () => readRecent())
  ipcMain.handle('desktop:clear-recent', async () => {
    await writeFile(recentFile(), '[]', 'utf8').catch(() => {})
  })

  ipcMain.handle('desktop:diagnostics', async (): Promise<Diagnostics> => {
    const [available, caps] = await Promise.all([ffmpegAvailable(), capabilities()])
    return {
      ffmpeg: available,
      encoder: caps.encoder,
      hardware: caps.hardware,
      hwaccel: caps.hwaccel,
      rejected: caps.rejected,
      platform: PLATFORM,
    }
  })

  ipcMain.handle('desktop:always-on-top', (_e, value: boolean) => {
    window?.setAlwaysOnTop(value)
    return value
  })

  /*
   * Takes the user to the page where defaults are chosen.
   *
   * The installer can claim file types nothing else has claimed, and that is the
   * whole of what is possible: since Windows 8 the choice for a type that
   * already has an owner lives behind a hashed UserChoice key, and applications
   * that appear to set it are either failing quietly or breaking the association
   * until Windows resets it. So this opens Settings rather than pretending.
   */
  ipcMain.handle('desktop:default-apps', async () => {
    const target =
      process.platform === 'win32'
        ? 'ms-settings:defaultapps'
        : process.platform === 'darwin'
          ? 'x-apple.systempreferences:'
          : null
    if (!target) return false
    try {
      await shell.openExternal(target)
      return true
    } catch {
      return false
    }
  })
}

function fail(path: string, message: string): OpenFailure {
  return { ok: false, path, name: path ? path.split(/[\\/]/).pop() ?? path : '', message }
}

/** The track the file itself marks as default, falling back to the first. */
function defaultAudio(file: NonNullable<ReturnType<GatewayHandle['get']>>): number {
  const marked = file.info.audio.find((a) => a.isDefault)
  return marked?.order ?? 0
}

/* ----------------------------------------------------------------- lifecycle */

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    deliverPaths(pathsFromArgv(argv))
  })

  // macOS hands files over through this event rather than the command line.
  app.on('open-file', (event, path) => {
    event.preventDefault()
    deliverPaths([path])
  })

  void app.whenReady().then(async () => {
    useCapabilityCache(app.getPath('userData'))
    gateway = await startGateway()
    registerIpc()
    // Measuring what this machine can encode costs a few process launches.
    // Doing it here keeps it off the clock of the first file someone opens, and
    // the answer is written to disk so only the first ever launch pays.
    void capabilities()
    // Segment directories from a run that was killed rather than quit. Nothing
    // else ever removes them, and each one can be hundreds of megabytes.
    void sweepStaleTempDirs()
    pendingPaths.push(...pathsFromArgv(process.argv))
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    void gateway?.close()
    gateway = null
    openFileId = null
  })
}

