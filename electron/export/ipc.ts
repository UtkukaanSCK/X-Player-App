import { ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { existsSync, rmSync, statSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import type { ExportFormat, ExportOption, ExportProgress, ExportRange, ExportStart } from '../../shared/api'
import { listEncoders } from '../gateway/ffmpeg'
import type { GatewayHandle, OpenFile } from '../gateway/server'
import { startExport, type ExportJob } from './job'
import { LABEL, planExport } from './rules'

const FORMATS: ExportFormat[] = ['mp4', 'mkv', 'webm', 'mov', 'gif']

/** A reading every quarter of a second is smooth, and more is IPC for nothing. */
const PROGRESS_EVERY_MS = 250

/** Enough finished exports to reveal; the id of an older one is of no use. */
const FINISHED_KEPT = 20

interface Deps {
  gateway: () => GatewayHandle | null
  window: () => BrowserWindow | null
}

/** One export at a time: two encodes compete for the same cores and both crawl. */
let running: ExportJob | null = null

/**
 * Held between a request arriving and its job existing.
 *
 * Starting an export asks ffmpeg what it can encode, and awaiting that let a
 * second request pass the "one at a time" check while the first was still
 * deciding. Both then wrote the same file.
 */
let starting = false

/** Finished exports, by job, so "Show in folder" never takes a path from the page. */
const finished = new Map<string, string>()

/**
 * The export half of the bridge.
 *
 * The page names an open file by its id and a format from a fixed list; it
 * never names a path. Every argument is checked here as untrusted, because the
 * window is the one part of the app that renders content from outside it.
 */
export function registerExportIpc(deps: Deps) {
  const fromWindow = (event: IpcMainInvokeEvent) => {
    const window = deps.window()
    return !!window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
  }

  /** The open file an id and audio track refer to, or null when either is not real. */
  const openFile = (id: unknown, audioOrder: unknown): OpenFile | null => {
    if (typeof id !== 'string' || !Number.isInteger(audioOrder)) return null
    const file = deps.gateway()?.get(id)
    if (!file) return null
    // The export is written beside this file, so it has to be one: an absolute
    // path to something that is there now.
    if (!isAbsolute(file.info.path) || !isFile(file.info.path)) return null
    // -1 is what a file on the direct route reports: nothing chosen, the first track plays.
    const order = audioOrder as number
    return order >= -1 && order < Math.max(1, file.info.audio.length) ? file : null
  }

  /**
   * The stretch the page marked, when it is one this file could be cut from.
   *
   * It arrives as whatever the renderer felt like sending, and it ends up in
   * an ffmpeg -ss, so it is checked here rather than trusted: two finite
   * seconds, in order, inside the file.
   */
  const markedRange = (value: unknown, duration: number): ExportRange | null => {
    if (!value || typeof value !== 'object') return null
    const { start, end } = value as Partial<ExportRange>
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null
    const from = start as number
    const to = end as number
    // Half a second of slack: a duration is a rounded number and the last
    // frame of a file is allowed to be the end of a selection.
    if (from < 0 || to <= from || to > duration + 0.5) return null
    return { start: from, end: to }
  }

  const send = (progress: ExportProgress) => {
    const window = deps.window()
    if (window && !window.isDestroyed()) window.webContents.send('desktop:export-progress', progress)
  }

  ipcMain.handle(
    'desktop:export-options',
    async (event, id: unknown, audioOrder: unknown, range: unknown): Promise<ExportOption[]> => {
      if (!fromWindow(event)) return []
      const file = openFile(id, audioOrder)
      if (!file) return []
      const encoders = await listEncoders()
      const marked = markedRange(range, file.info.duration)
      const busy = running !== null || starting
      return FORMATS.map((format) => {
        const plan = planExport(file.info, audioOrder as number, format, encoders, marked)
        const blocked = plan.available && busy
        return {
          format,
          label: LABEL[format],
          available: plan.available && !blocked,
          method: plan.method,
          note: blocked ? 'Another export is running' : plan.note,
        }
      })
    },
  )

  ipcMain.handle(
    'desktop:export-start',
    async (event, id: unknown, format: unknown, audioOrder: unknown, range: unknown): Promise<ExportStart> => {
      if (!fromWindow(event)) return { ok: false, message: 'That request did not come from the player window' }
      if (typeof format !== 'string' || !FORMATS.includes(format as ExportFormat)) {
        return { ok: false, message: 'X-Player does not export to that format' }
      }
      const file = openFile(id, audioOrder)
      if (!file) return { ok: false, message: 'That file or audio track is not open' }
      // Claimed here, in the same breath as the check, and before any await.
      if (running || starting) return { ok: false, message: 'Another export is already running' }
      starting = true

      try {
        const plan = planExport(
          file.info,
          audioOrder as number,
          format as ExportFormat,
          await listEncoders(),
          markedRange(range, file.info.duration),
        )
        if (!plan.available) return { ok: false, message: plan.note }

        // A copy, because opening the next file releases this one's session.
        const info = structuredClone(file.info)
        let lastSent = 0
        const job: ExportJob = startExport({
          info,
          plan,
          onProgress: (fraction) => {
            const now = Date.now()
            if (fraction < 1 && now - lastSent < PROGRESS_EVERY_MS) return
            lastSent = now
            send(progressOf(job, info.name, plan.format, 'running', fraction))
          },
        })
        running = job
        send(progressOf(job, info.name, plan.format, 'running', 0))

        void job.done.then((outcome) => {
          // Everything below is the report, and a window that closed between
          // the check and the send can make any of it throw. The slot is freed
          // first, so a lost message never costs the next export.
          if (running === job) running = null
          if (outcome.state === 'done') {
            finished.set(job.id, outcome.outputPath)
            while (finished.size > FINISHED_KEPT) {
              const oldest = finished.keys().next().value
              if (oldest === undefined) break
              finished.delete(oldest)
            }
            send({ ...progressOf(job, info.name, plan.format, 'done', 1), outputName: basename(outcome.outputPath) })
          } else if (outcome.state === 'failed') {
            send({ ...progressOf(job, info.name, plan.format, 'failed', 0), message: outcome.message })
          } else {
            send(progressOf(job, info.name, plan.format, 'cancelled', 0))
          }
        }).catch(() => {
          if (running === job) running = null
        })

        return { ok: true, jobId: job.id, outputName: basename(job.outputPath) }
      } finally {
        starting = false
      }
    },
  )

  ipcMain.handle('desktop:export-cancel', (event, jobId: unknown) => {
    if (fromWindow(event) && running && running.id === jobId) running.cancel()
  })

  ipcMain.handle('desktop:export-reveal', (event, jobId: unknown): boolean => {
    if (!fromWindow(event) || typeof jobId !== 'string') return false
    const path = finished.get(jobId)
    if (!path || !existsSync(path)) return false
    shell.showItemInFolder(path)
    return true
  })
}

/**
 * Stops an export that is still running when the app quits, and deletes what
 * it had written. The job's own cleanup runs when ffmpeg exits, which can be
 * after the app has gone, so the partial file is removed here as well.
 *
 * One attempt, and a failure is let go. This runs in before-quit, ahead of the
 * gateway's own teardown: waiting on a file the dying ffmpeg still holds would
 * freeze the window for seconds, and throwing would leave the transcodes and
 * their temporary folders behind - a worse thing than a leftover .part, which
 * no player will open and no one will mistake for the export.
 */
export function cancelRunningExport() {
  if (!running) return
  const job = running
  running = null
  job.cancel()
  try {
    rmSync(`${job.outputPath}.part`, { force: true })
  } catch {
    /* it is still held; it stays */
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function progressOf(
  job: ExportJob,
  sourceName: string,
  format: ExportFormat,
  state: ExportProgress['state'],
  fraction: number,
): ExportProgress {
  return { jobId: job.id, sourceName, outputName: basename(job.outputPath), format, state, fraction }
}
