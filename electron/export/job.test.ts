import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MediaInfo } from '../gateway/types'
import type { ExportPlan } from './rules'
import { startExport } from './job'

/**
 * Running an export: the file it writes, the file it leaves behind, and what it
 * cleans up when it does not finish.
 *
 * The encoder is test/fake-encoder.mjs run by Node - a real child process in a
 * real temporary folder, so renames, deletes and kills are the real thing and
 * only the encoding is not. What an export asks ffmpeg to do is rules.test.ts.
 */

const FAKE = resolve(import.meta.dirname, 'test', 'fake-encoder.mjs')

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A folder holding one source file, as a person's video folder would. */
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xplayer-export-test-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'film.mkv'), 'source')
  return dir
}

function info(path: string): MediaInfo {
  return {
    path,
    name: 'film.mkv',
    size: 6,
    container: 'matroska',
    duration: 10,
    video: { index: 0, codec: 'h264', profile: 'High', width: 1920, height: 1080, fps: 24, pixFmt: 'yuv420p' },
    audio: [{ index: 1, order: 0, codec: 'aac', channels: 2, language: 'eng', title: 'English', isDefault: true }],
    subtitles: [],
  }
}

const PLAN: ExportPlan = { format: 'mp4', available: true, method: 'copy', note: '', args: ['-c', 'copy', '-f', 'mp4'] }

/** Starts the fake in the given mode, counting how many times it was started. */
function encoder(mode: 'ok' | 'fail' | 'hang', before?: () => void) {
  const started = { count: 0 }
  const run = (args: string[]) => {
    started.count++
    before?.()
    return spawn(process.execPath, [FAKE, ...args], {
      env: { ...process.env, FAKE_ENCODER: mode },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  return { run, started }
}

describe('an export that finishes', () => {
  it('writes under a .part name and gives the file its real name only when it is complete', async () => {
    const dir = folder()
    const source = join(dir, 'film.mkv')
    const job = startExport({ info: info(source), plan: PLAN, onProgress: () => {} }, encoder('ok').run)

    await expect(job.done).resolves.toEqual({ state: 'done', outputPath: join(dir, 'film.mp4') })

    const asked = JSON.parse(readFileSync(join(dir, 'film.mp4'), 'utf8')) as string[]
    expect(asked[asked.indexOf('-i') + 1]).toBe(source)
    expect(asked.at(-1)).toBe(join(dir, 'film.mp4.part'))
    expect(asked[asked.indexOf('-progress') + 1]).toBe('pipe:1')
    expect(readdirSync(dir).sort()).toEqual(['film.mkv', 'film.mp4'])
  })

  it('reports its progress through to the end', async () => {
    const seen: number[] = []
    const job = startExport(
      { info: info(join(folder(), 'film.mkv')), plan: PLAN, onProgress: (fraction) => seen.push(fraction) },
      encoder('ok').run,
    )
    await job.done
    expect(seen).toEqual([0.5, 1])
  })

  it('leaves a stale .part file alone and takes the next name', async () => {
    const dir = folder()
    // Someone else's half-written file, or one left by a crash. Writing through
    // it would destroy it, and on a shared folder it could be a symlink.
    writeFileSync(join(dir, 'film.mp4.part'), 'not ours')
    const job = startExport({ info: info(join(dir, 'film.mkv')), plan: PLAN, onProgress: () => {} }, encoder('ok').run)

    await expect(job.done).resolves.toEqual({ state: 'done', outputPath: join(dir, 'film (1).mp4') })
    expect(readFileSync(join(dir, 'film.mp4.part'), 'utf8')).toBe('not ours')
  })

  it('takes the next free name when a file of its name appeared while it was running', async () => {
    const dir = folder()
    const arrived = () => writeFileSync(join(dir, 'film.mp4'), 'someone else')
    const job = startExport({ info: info(join(dir, 'film.mkv')), plan: PLAN, onProgress: () => {} }, encoder('ok', arrived).run)

    await expect(job.done).resolves.toEqual({ state: 'done', outputPath: join(dir, 'film (1).mp4') })
    expect(readFileSync(join(dir, 'film.mp4'), 'utf8')).toBe('someone else')
  })
})

describe('an export that does not finish', () => {
  it('deletes what it wrote and says why when the encoder fails', async () => {
    const dir = folder()
    const job = startExport({ info: info(join(dir, 'film.mkv')), plan: PLAN, onProgress: () => {} }, encoder('fail').run)

    const outcome = await job.done
    expect(outcome.state).toBe('failed')
    expect(outcome.state === 'failed' && outcome.message).toMatch(/Invalid data found/)
    expect(readdirSync(dir)).toEqual(['film.mkv'])
  })

  it('stops the encoder and deletes what it wrote when cancelled', async () => {
    const dir = folder()
    let running!: () => void
    const firstProgress = new Promise<void>((done) => (running = done))
    const job = startExport(
      { info: info(join(dir, 'film.mkv')), plan: PLAN, onProgress: () => running() },
      encoder('hang').run,
    )

    // Only once the fake has written its partial file is there anything to clean up.
    await firstProgress
    expect(existsSync(join(dir, 'film.mp4.part'))).toBe(true)
    job.cancel()

    await expect(job.done).resolves.toEqual({ state: 'cancelled' })
    expect(readdirSync(dir)).toEqual(['film.mkv'])
  })

  it('refuses without starting the encoder when it cannot write beside the source', async () => {
    const missing = join(tmpdir(), 'xplayer-export-test-no-such-folder', 'film.mkv')
    const fake = encoder('ok')
    const job = startExport({ info: info(missing), plan: PLAN, onProgress: () => {} }, fake.run)

    const outcome = await job.done
    expect(outcome.state).toBe('failed')
    expect(outcome.state === 'failed' && outcome.message).toMatch(/Can't write next to the original/)
    expect(fake.started.count).toBe(0)
  })
})
