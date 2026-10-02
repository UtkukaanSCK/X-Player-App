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

function session(media: MediaInfo = info) {
  const s = new Session({ fileId: 'film', audioOrder: 0, maxHeight: 0 }, media, plan)
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

/**
 * The same film, five milliseconds longer.
 *
 * Forty-and-five-thousandths of a second cut into four-second segments leaves a
 * final slot 5 ms wide, and at 24 fps a frame lasts 42 ms: there is no frame
 * left to put in it. ffmpeg opens a segment only where a frame starts, so this
 * eleventh segment is one the encoder never writes - measured with the staged
 * binary on hevc10-ac3.mkv (40.005 s) and hd720.mkv (40.021 s), where a run
 * over the whole file produces ten segments and stops.
 */
const shortTail: MediaInfo = { ...info, duration: 40.005 }

function promised(media: MediaInfo): number {
  const lines = session(media)
    .playlist((n) => `seg/${n}.ts`)
    .split('\n')
  return lines.filter((line) => line.startsWith('seg/')).length
}

describe('a file whose last segment would hold no frame', () => {
  it('does not promise one the encoder will never produce', () => {
    expect(promised(shortTail)).toBe(10)
  })

  /*
   * The other direction, and the reason the test above cannot simply drop the
   * last segment of every file. A 168 ms tail at 24 fps holds four frames, and
   * the encoder does write that segment: measured with the staged binary on
   * h264-aac.mkv and multi.mkv, both 40.168 s, where a run over the whole file
   * produces eleven. A file that divides exactly keeps all of its segments too.
   */
  it('still promises one that holds frames', () => {
    expect(promised({ ...info, duration: 40.168 })).toBe(11)
    expect(promised(info)).toBe(10)
  })

  /*
   * The regression. The playlist promised eleven segments, so hls.js asked for
   * the eleventh while buffering ahead - and asking for it started a whole
   * ffmpeg run at -ss 40 on a file that ends at 40.005. That run reads the
   * input, produces no frame and exits 0: measured against the staged binary it
   * cost 550-850 ms and left either a zero-byte segment, which was then served
   * as a 200 that hls.js could not parse, or no file at all, which made the
   * request fail. Either way hls.js asked again, and every attempt paid for
   * another run, which is the request left pending in the report.
   *
   * Refusing it outright is the only honest answer: no encoder run can produce
   * a frame that is not in the file. The rejection says "out of range" rather
   * than anything about the encoder precisely because none was started.
   */
  it('refuses it at once instead of running the encoder past the end', async () => {
    const s = session(shortTail)
    await expect(s.segment(10)).rejects.toThrow(/out of range/)
  })
})
