import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MediaInfo, RoutePlan } from './types'

/**
 * What a session serves after one of its encoder runs has failed.
 *
 * The encoder is Node itself. Handed ffmpeg's arguments it exits with code 9
 * and "bad option: -hide_banner" on stderr, so a real child process really
 * fails and the session's own exit handler records it - which is the state
 * these tests are about. Everything else is real: the Session class, its temp
 * directory and the files in it. GPU detection is stubbed for the reason
 * plan.test.ts gives: what a machine has is not what is under test.
 */
vi.mock('./ffmpeg', () => ({
  FFMPEG: process.execPath,
  capabilities: async () => ({
    encoder: 'libx264',
    hardware: false,
    hwaccel: null,
    encoderArgs: [],
    rejected: [],
  }),
}))

let Session: typeof import('./session').Session

beforeAll(async () => {
  ;({ Session } = await import('./session'))
})

/** Forty seconds: ten four-second segments, so segment 7 is in range and well clear of 0 and 3. */
const info: MediaInfo = {
  path: '/fixtures/film.mkv',
  name: 'film.mkv',
  size: 1_000_000,
  container: 'matroska',
  duration: 40,
  video: { index: 0, codec: 'hevc', profile: 'Main 10', width: 1920, height: 1080, fps: 24, pixFmt: 'yuv420p10le' },
  audio: [{ index: 1, order: 0, codec: 'ac3', channels: 6, language: 'eng', title: 'English', isDefault: true }],
  subtitles: [],
}

const plan: RoutePlan = { route: 'transcode', copyVideo: false, copyAudio: false, reason: 'HEVC 10-bit video -> H.264' }

/** Node's own complaint, or the session's fallback when the exit arrives before stderr does. */
const ENCODER_FAILURE = /bad option|exited with code/

const open: InstanceType<typeof Session>[] = []

afterEach(() => {
  for (const s of open.splice(0)) s.dispose()
})

function session() {
  const s = new Session({ fileId: 'film', audioOrder: 0, maxHeight: 0 }, info, plan)
  open.push(s)
  return s
}

/**
 * Asks for a segment nothing has produced, which starts a run, and waits for
 * that run to fail.
 *
 * Asserted rather than assumed. If the rejection were a timeout, or "the
 * encoder produced nothing", the session would not be in the failed-run state
 * at all, and every check after this would pass or fail for reasons unrelated
 * to what it claims to test.
 */
async function failARun(s: InstanceType<typeof Session>) {
  await expect(s.segment(7)).rejects.toThrow(ENCODER_FAILURE)
}

describe('after an encoder run has failed', () => {
  /*
   * The regression. A failed run made every segment already on disk unservable:
   * the completion check looked at the failure before it looked at whether the
   * muxer had moved on, so a finished segment was refused for a failure that
   * happened elsewhere. It bit hardest exactly where KEEP_BEHIND exists to help
   * - a viewer rewinding into segments that were sitting there, complete.
   */
  it('still serves a segment the encoder had already finished', async () => {
    const s = session()
    const finished = join(s.dir, '0.ts')
    writeFileSync(finished, 'segment 0')
    // The muxer had moved on to segment 1, which is what makes segment 0 whole.
    writeFileSync(join(s.dir, '1.ts'), 'segment 1')

    await failARun(s)

    await expect(s.segment(0)).resolves.toBe(finished)
  })

  /*
   * The guard against fixing that by deleting the check. A run that fails can
   * leave its last segment half-written, with nothing after it, and a non-empty
   * file there would otherwise count as done and be served as a corrupt
   * fragment.
   */
  it('does not serve a segment the failed run left half-written', async () => {
    const s = session()
    // Nothing after it: this is where the run stopped, possibly mid-write.
    writeFileSync(join(s.dir, '3.ts'), 'partial')

    await failARun(s)

    await expect(s.segment(3)).rejects.toThrow(ENCODER_FAILURE)
  })
})
