import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, linkSync, openSync, renameSync, rmSync, unlinkSync } from 'node:fs'
import type { ExportFormat } from '../../shared/api'
import { FFMPEG } from '../gateway/ffmpeg'
import type { MediaInfo } from '../gateway/types'
import { outputPathFor } from './names'
import { progressReader } from './progress'
import type { ExportPlan } from './rules'

export type ExportOutcome =
  | { state: 'done'; outputPath: string }
  | { state: 'failed'; message: string }
  | { state: 'cancelled' }

export interface ExportRequest {
  info: MediaInfo
  /** An available plan from planExport. */
  plan: ExportPlan
  onProgress: (fraction: number) => void
}

export interface ExportJob {
  id: string
  /** Where it will land, unless a file takes that name before it finishes. */
  outputPath: string
  done: Promise<ExportOutcome>
  cancel(): void
}

/** Starts the encoder with these arguments. stdout and stderr must be pipes. */
export type EncoderRunner = (args: string[]) => ChildProcess

const runFfmpeg: EncoderRunner = (args) => spawn(FFMPEG, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

/**
 * Runs one export to the end, or to a cancel.
 *
 * It is written under the final name plus ".part" and given its real name only
 * when ffmpeg exits cleanly, so a crash, a cancel or a full disk never leaves
 * something that looks like a finished video beside the original. Whatever it
 * wrote is deleted when it does not finish.
 *
 * The file's details are taken as they are at the start. Opening another file
 * releases this one's playback session, and the export must not depend on it.
 */
export function startExport(request: ExportRequest, runEncoder: EncoderRunner = runFfmpeg): ExportJob {
  const { info, plan, onProgress } = request
  const id = randomUUID()
  const free = () => outputPathFor(info.path, plan.format, existsSync)

  let reserved: Reserved
  try {
    reserved = reserve(info.path, plan.format)
  } catch (err) {
    return {
      id,
      outputPath: free(),
      done: Promise.resolve({ state: 'failed', message: `Can't write next to the original: ${whyUnwritable(err)}` }),
      cancel: () => {},
    }
  }

  const { output, part } = reserved
  let cancel = () => {}

  const done = new Promise<ExportOutcome>((resolve) => {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      ...(plan.inputArgs ?? []),
      '-i', info.path,
      ...plan.args,
      '-progress', 'pipe:1', '-nostats',
      part,
    ]

    let proc: ChildProcess
    try {
      proc = runEncoder(args)
    } catch (err) {
      discard(part)
      resolve({ state: 'failed', message: `Could not start ffmpeg: ${err instanceof Error ? err.message : String(err)}` })
      return
    }

    let cancelled = false
    let stderr = ''

    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on(
      'data',
      // What is being written, which for a cut is shorter than the film.
      progressReader(plan.duration ?? info.duration, (fraction) => {
        // What the caller does with a reading is its own business: a throw
        // here would come out of a stream event, which no one catches.
        try {
          onProgress(fraction)
        } catch {
          /* the next reading is a quarter of a second away */
        }
      }),
    )
    proc.stderr?.on('data', (chunk: Buffer) => {
      // Only the tail: a damaged input can produce megabytes of complaints.
      stderr = (stderr + chunk.toString()).slice(-2000)
    })

    proc.on('error', (err) => {
      // A failed kill() arrives here too, so a process that died on its own a
      // moment before the cancel is still a cancel, not a failure to report.
      discard(part)
      resolve(cancelled ? { state: 'cancelled' } : { state: 'failed', message: `Could not start ffmpeg: ${err.message}` })
    })

    proc.on('exit', (code) => {
      if (cancelled) {
        discard(part)
        resolve({ state: 'cancelled' })
        return
      }
      if (code !== 0) {
        discard(part)
        resolve({ state: 'failed', message: lastLine(stderr) || `ffmpeg stopped with code ${code}` })
        return
      }
      try {
        resolve({ state: 'done', outputPath: claimName(part, output, free) })
      } catch (err) {
        discard(part)
        resolve({
          state: 'failed',
          message: `Could not give the export its name: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    })

    cancel = () => {
      if (cancelled) return
      cancelled = true
      try {
        proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
  })

  return { id, outputPath: output, done, cancel: () => cancel() }
}

interface Reserved {
  output: string
  part: string
}

/**
 * Takes the name this export will be written under, by creating its .part file
 * and nothing else.
 *
 * Exclusively: `wx` fails if anything is already there, including a symlink
 * someone planted in a shared folder, so ffmpeg's `-y` can only ever truncate
 * the empty file we just made. A name whose .part is taken is a name in use by
 * another export, so the next one is tried. Creating the file is also the
 * honest test of whether the folder can be written to at all.
 */
function reserve(source: string, format: ExportFormat): Reserved {
  const taken = new Set<string>()
  for (;;) {
    const output = outputPathFor(source, format, (path) => taken.has(path) || existsSync(path))
    const part = `${output}.part`
    try {
      closeSync(openSync(part, 'wx'))
      return { output, part }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      taken.add(output)
    }
  }
}

/**
 * Gives the finished file its name without replacing anything that appeared
 * while it was being written.
 *
 * A hard link fails when the name is taken, where a rename would quietly
 * destroy the file already there on macOS and Linux. Filesystems without hard
 * links fall back to the rename, which is the best that is left.
 */
function claimName(part: string, output: string, nextFree: () => string): string {
  let target = output
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      linkSync(part, target)
      unlinkSync(part)
      return target
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') break
      target = nextFree()
    }
  }
  renameSync(part, target)
  return target
}

function discard(part: string) {
  try {
    // A Windows process that has just been killed can still hold its output
    // open for a moment, so the delete retries rather than leaving the file
    // behind. `recursive` is what turns the retries on - fs.rm ignores
    // maxRetries without it - and a plain file is deleted either way.
    rmSync(part, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    // The .part is left where it is. Every caller has an outcome to settle
    // after this, and a file nothing can delete must not take that with it.
  }
}

function whyUnwritable(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'the folder is read-only'
  if (code === 'ENOENT') return 'the folder is no longer there'
  return err instanceof Error ? err.message : String(err)
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).at(-1)?.trim() ?? ''
}
