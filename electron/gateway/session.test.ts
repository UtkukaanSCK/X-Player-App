import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MediaInfo, RoutePlan, VideoStream } from './types'

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
const probe = vi.hoisted(() => ({ ms: 0, fail: false }))

vi.mock('./ffmpeg', () => ({
  FFMPEG: process.execPath,
  capabilities: async () => {
    if (probe.ms > 0) await new Promise((r) => setTimeout(r, probe.ms))
    if (probe.fail) throw new Error('probe failed')
    return {
      encoder: 'libx264',
      hardware: false,
      hwaccel: null,
      encoderArgs: [],
      rejected: [],
    }
  },
}))

/**
 * How many child processes the session has started.
 *
 * Counting them is the only way to check that a run did *not* happen, which is
 * what one test below is about: looking for files in the temp directory cannot
 * tell a run that was never started from one that started and wrote nothing,
 * and that is exactly the difference being asserted. The real spawn still does
 * the work, so the other tests here keep their real failing child process.
 */
const spawned = vi.hoisted(() => ({ count: 0 }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const counted = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    spawned.count += 1
    return actual.spawn(command, args, options)
  }
  // spawn is a dozen overloads deep and the replacement covers only the one the
  // session uses; the cast is what lets the other eleven keep their signatures.
  return { ...actual, spawn: counted as typeof actual.spawn }
})

let Session: typeof import('./session').Session

beforeAll(async () => {
  ;({ Session } = await import('./session'))
})

const video: VideoStream = {
  index: 0,
  codec: 'hevc',
  profile: 'Main 10',
  width: 1920,
  height: 1080,
  fps: 24,
  pixFmt: 'yuv420p10le',
}

/** Forty seconds: ten four-second segments, so segment 7 is in range and well clear of 0 and 3. */
const info: MediaInfo = {
  path: '/fixtures/film.mkv',
  name: 'film.mkv',
  size: 1_000_000,
  container: 'matroska',
  duration: 40,
  video,
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
 * The same film, five milliseconds longer - the shape of fixtures/hevc10-ac3.mkv.
 *
 * Forty-and-five-thousandths of a second cut into four-second segments leaves a
 * final slot 5 ms wide, and at 24 fps a frame lasts 42 ms: there is no frame
 * left to put in it. The picture in that fixture ends at 40.000 - 959 frames
 * spaced 1/24 s apart, the last starting at 39.958 - and the 5 ms on top of it
 * belongs to the AC-3 track, whose last packet starts at 39.973 and runs 32 ms.
 * ffmpeg opens a segment only where a frame starts, so this eleventh segment is
 * one the encoder never writes: measured with the staged binary on that fixture
 * and on hd720.mkv (40.021 s), where a run over the whole file produces ten
 * segments and stops.
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
   * The frame rate decides how much tail counts as empty, so a slow one is where
   * that rule would break if it were going to. It does not: a container's
   * duration spans the last frame's time on screen, so a 1 fps file whose last
   * frame starts at exactly 40.000 is 41.000 s long - measured, that is what both
   * the Matroska and the MP4 muxer write - and segmenting it with the staged
   * binary and startRun's own arguments writes eleven segments, the eleventh
   * holding that one frame.
   *
   * The 1 fps file whose eleventh segment does go is the one whose picture ends
   * at 40.000 and whose soundtrack runs on to 40.521. ffmpeg writes ten segments
   * for it, and nothing goes missing: the segment muxer cuts at video keyframes,
   * so the 521 ms of audio past the picture ends up inside segment 9, which
   * carries packets out to 40.490.
   */
  it('counts a slow frame rate by its own frames, not by a fixed cut-off', () => {
    const slow: MediaInfo = { ...info, video: { ...video, fps: 1 } }
    expect(promised({ ...slow, duration: 41 })).toBe(11)
    expect(promised({ ...slow, duration: 40.521 })).toBe(10)
  })

  /*
   * The floating-point edge, which is a real file and not only a duration built
   * by arithmetic. ffprobe prints "40.040000" for a silent 25 fps file of 1001
   * frames whose last frame starts at 40.000, and 40.04 - 10 * 4 lands at
   * 0.03999999999999915, a hair under the 0.04 a frame lasts. Without the slack
   * the playlist stopped at ten segments while a run over that file wrote eleven,
   * the eleventh holding that frame - so the last frame of the film was simply
   * not offered. 20, 30, 40 and 100 fps cancel the same way off a six-decimal
   * duration; the second case here is the same cancellation at 24 fps, which
   * needs a duration that came from arithmetic rather than from ffprobe.
   */
  it('does not lose a tail that is exactly one frame long', () => {
    const pal: MediaInfo = { ...info, video: { ...video, fps: 25 }, duration: 40.04 }
    expect(promised(pal)).toBe(11)
    expect(promised({ ...info, duration: 40 + 1 / 24 })).toBe(11)
  })

  /*
   * The two cases with no frame rate to measure a tail against: a file with no
   * video stream at all - a podcast, an album - and one whose rate ffprobe could
   * not work out. Both keep every segment the duration asks for, because an
   * unknown rate is no evidence that the tail is empty, and an audio-only file
   * has no frames to miss.
   *
   * Constructing the session at all is half the point. Reading `info.video.fps`
   * without the guard throws here, and it would throw in the constructor - before
   * the window had a playlist to show for the file it just opened.
   */
  it('keeps every segment when there is no frame rate to compare against', () => {
    expect(promised({ ...shortTail, video: null })).toBe(11)
    expect(promised({ ...shortTail, video: { ...video, fps: 0 } })).toBe(11)
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
   * than anything about the encoder precisely because none was started, and the
   * whole point of the change is the run that does not happen, so the count of
   * started processes is what this checks - the message alone would have passed
   * just as well with an ffmpeg run thrown away behind it.
   */
  it('refuses it at once instead of running the encoder past the end', async () => {
    const s = session(shortTail)
    const before = spawned.count

    await expect(s.segment(10)).rejects.toThrow(/out of range/)
    expect(spawned.count).toBe(before)

    // And the counter is not simply stuck at nothing: segment 9 is in range, so
    // asking for it does start a run - the one above is the absence of this.
    await expect(s.segment(9)).rejects.toThrow(ENCODER_FAILURE)
    expect(spawned.count).toBe(before + 1)
  })
})

/*
 * The gap in front of the spawn. A run is asked for the moment segment() is
 * called, but the process only exists once capabilities() has answered - a second
 * or so on a cold cache, which probe.ms stands in for. 100 ms is wide enough that
 * nothing below can land on the far side of it by luck, and short enough to keep
 * the suite quick.
 */
describe('while the capability probe is still running', () => {
  afterEach(() => {
    probe.ms = 0
    probe.fail = false
  })

  /*
   * The regression. "Is a run in progress" was read off `proc`, which is null
   * until the spawn, so two calls in the same tick each started their own run for
   * the same position: two ffmpeg processes writing %d.ts into one directory, the
   * first orphaned by the second's assignment to `proc` - never killed, never
   * reported. Measured with a 50 ms probe: two spawns for two calls. The delta is
   * asserted as exactly one, because "fewer than two" would pass for a session
   * that started nothing.
   */
  it('starts one run for two requests that arrive in the same tick', async () => {
    probe.ms = 100
    const s = session()
    const before = spawned.count

    const settled = await Promise.allSettled([s.segment(5), s.segment(5)])

    expect(spawned.count - before).toBe(1)
    // Both waited for that one run, and both heard why it failed.
    for (const r of settled) {
      expect(r.status).toBe('rejected')
      expect((r as PromiseRejectedResult).reason.message).toMatch(ENCODER_FAILURE)
    }
  })

  /*
   * The regression. With no process yet, the completion check read the run as
   * over and found no file, so the request was refused with "the encoder produced
   * nothing for this position" 1 ms after it was made - before any encoder had
   * run. The only honest rejection here is the encoder's own, which arrives once
   * the probe is done and the run has really failed (Node is the encoder, so it
   * does).
   */
  it('makes a request wait for the run instead of refusing it as empty', async () => {
    probe.ms = 100
    const s = session()

    const failure = await s.segment(7).then(
      () => null,
      (e: Error) => e.message,
    )

    expect(failure).toMatch(ENCODER_FAILURE)
    expect(failure).not.toMatch(/produced nothing/)
  })
})

describe('a segment file of zero bytes', () => {
  /*
   * The regression. A zero-byte segment is what a run leaves when it opens a
   * file and never gets a frame into it. The old code returned one that was the
   * last of its run or of the file, and server.ts answered 200 with
   * content-length 0, which hls.js cannot parse, so it asked again and each
   * attempt paid for another encoder run. It is refused as no file at all.
   *
   * Segment 9 is the last of this ten-segment film: the shape the old code
   * returned outright.
   */
  it('is refused when it is the last segment of the file', async () => {
    const s = session()
    writeFileSync(join(s.dir, '9.ts'), '')

    await expect(s.segment(9)).rejects.toThrow(/the encoder produced nothing/)
  })

  /*
   * The other shape, which was a different bug: in the middle of the file, with
   * nothing after it, the old code matched no branch and kept polling.
   */
  it('is refused when it is in the middle of the file', async () => {
    const s = session()
    writeFileSync(join(s.dir, '3.ts'), '')

    await expect(s.segment(3)).rejects.toThrow(/the encoder produced nothing/)
  })

  /*
   * The one that matters most. Before, the middle-of-the-file case sat in the
   * wait loop until the 30 s deadline - measured at 30005 ms, which is the shape
   * of the request the end-to-end suite left pending for 22 s. The request is
   * raced against a one second timer, so a regression fails here saying the
   * request was still pending rather than as a generic test timeout, and the
   * test never waits 30 s.
   */
  it('is refused at once rather than after the 30 second deadline', async () => {
    const s = session()
    writeFileSync(join(s.dir, '3.ts'), '')

    const started = Date.now()
    const outcome = await settleWithin(s.segment(3), 1000)
    const elapsed = Date.now() - started

    expect(outcome).toMatch(/the encoder produced nothing/)
    expect(elapsed).toBeLessThan(1000)
  })

  /*
   * The regression the refusal above would otherwise cause. segment() sends an
   * existing file straight to the wait without starting a run, so a zero-byte file
   * left by a run killed just after it opened the file was refused on every
   * retry, until prune() removed it twenty segments later. Refusing it deletes
   * it, so the next request finds no file and starts the run that makes it. The
   * spawn count says so: none for the refusal, exactly one for the retry.
   */
  it('is made again by the next request instead of failing forever', async () => {
    const s = session()
    writeFileSync(join(s.dir, '3.ts'), '')
    const before = spawned.count

    await expect(s.segment(3)).rejects.toThrow(/the encoder produced nothing/)
    expect(spawned.count).toBe(before)

    await expect(s.segment(3)).rejects.toThrow(ENCODER_FAILURE)
    expect(spawned.count - before).toBe(1)
  })
})

/** The request's outcome as a message, or a note that it was still pending after `ms`. */
function settleWithin(request: Promise<string>, ms: number): Promise<string> {
  return Promise.race([
    request.then(
      () => 'resolved',
      (e: Error) => e.message,
    ),
    new Promise<string>((r) => setTimeout(() => r(`still pending after ${ms} ms`), ms)),
  ])
}

describe('when a run cannot get as far as the encoder', () => {
  afterEach(() => {
    probe.ms = 0
    probe.fail = false
  })

  /*
   * The regression a flag for "a run is in progress" invites. If the capability
   * probe throws, nothing ever clears it, and every request for that stretch
   * polled for the full 30 s and failed as a timeout - where it should name the
   * start failure at once. Raced against one second, so the failure says pending.
   */
  it('says the encoder could not start instead of waiting out the deadline', async () => {
    probe.fail = true
    const s = session()

    const outcome = await settleWithin(s.segment(7), 1000)

    expect(outcome).toMatch(/could not start the encoder: probe failed/)
  })

  /*
   * The regression. Runs are told apart by their position, so segment(5), then
   * segment(40), then segment(5) again leaves the first and the third both asked
   * for position 5, and when the probe answered both of them spawned: two
   * processes into one directory, the first orphaned by the second's assignment
   * to `proc`. Measured: two spawns. A longer film, so 40 is in range.
   */
  it('starts one run when a request for a position is made, replaced, and made again', async () => {
    probe.ms = 100
    const s = session({ ...info, duration: 400 })
    const before = spawned.count
    const tick = () => new Promise((r) => setTimeout(r, 10))

    // A pause between each, because segment() looks at the disk before it asks for a run.
    const a = s.segment(5)
    await tick()
    const b = s.segment(40)
    await tick()
    const c = s.segment(5)
    await Promise.allSettled([a, b, c])

    expect(spawned.count - before).toBe(1)
  })
})
