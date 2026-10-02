import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { access, readdir, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capabilities, FFMPEG } from './ffmpeg'
import type { MediaInfo, RoutePlan } from './types'

/** Segment length. Short enough to start fast, long enough to encode efficiently. */
export const SEGMENT_SECONDS = 4

/**
 * How far ahead of the playhead one ffmpeg run is allowed to encode.
 *
 * There is no portable way to pause a child process, so the throttle is the
 * length of the run itself: two minutes of output, then the process exits. A
 * new run starts when playback approaches the end of the current one, which is
 * what keeps the encoder ahead of the player without encoding a whole film
 * nobody is watching.
 */
const RUN_SEGMENTS = 30
/** Start the next run once the player is this close to the end of this one. */
const LOOKAHEAD_SEGMENTS = 8
/** Segments kept on disk behind the playhead, so short rewinds cost nothing. */
const KEEP_BEHIND = 20
/** How often to look for a finished segment while waiting for one. */
const POLL_MS = 40
/** A segment that has not appeared in this long is a failure, not slowness. */
const SEGMENT_TIMEOUT_MS = 30_000

export interface SessionKey {
  fileId: string
  audioOrder: number
  maxHeight: number
}

export function keyOf(k: SessionKey): string {
  return `${k.fileId}|${k.audioOrder}|${k.maxHeight}`
}

/** Prefix every session temp directory carries, so stale ones can be found. */
const TEMP_PREFIX = 'xplayer-'
/** Left alone if touched this recently, in case something is still using it. */
const SWEEP_GRACE_MS = 60_000

/**
 * Removes segment directories left behind by a previous run.
 *
 * dispose() handles the ordinary path, but nothing survives a hard kill - Task
 * Manager, a crash, power loss - and each abandoned directory can hold hundreds
 * of megabytes of .ts segments. Nothing else ever deletes them: the note in
 * dispose() about the OS clearing its own temp directory does not hold on
 * Windows unless the user has turned Storage Sense on.
 *
 * Safe to run at startup because the app holds a single-instance lock, so no
 * sibling owns these. The grace window is belt and braces for the case where
 * one somehow does.
 */
export async function sweepStaleTempDirs(): Promise<number> {
  const root = tmpdir()
  let removed = 0
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return 0
  }
  const cutoff = Date.now() - SWEEP_GRACE_MS
  for (const name of entries) {
    if (!name.startsWith(TEMP_PREFIX)) continue
    const dir = join(root, name)
    try {
      const info = await stat(dir)
      if (!info.isDirectory() || info.mtimeMs > cutoff) continue
      await rm(dir, { recursive: true, force: true })
      removed += 1
    } catch {
      /* another process owns it, or it went away on its own - either is fine */
    }
  }
  return removed
}

/**
 * One transcoding session: a file, an audio track, a resolution ceiling.
 *
 * The whole timeline is addressable from the first moment. The playlist is
 * written up front from the duration alone, so the player can seek anywhere
 * before a single frame has been encoded; asking for a segment is what causes
 * it to be produced.
 */
export class Session {
  readonly dir: string
  readonly segmentCount: number

  private proc: ChildProcess | null = null
  /** First segment number the running process was started for. */
  private runStart = -1
  /**
   * True from the moment a run is asked for until its process is gone.
   *
   * `proc` cannot answer that question: it is null before the spawn as well as
   * after the exit, and the gap in front of the spawn is as wide as
   * capabilities() takes - "a second or so of process launches" on a cold cache,
   * as ffmpeg.ts puts it. Reading that gap as "the run is over" is measurable
   * damage: with a 50 ms probe, one segment() call rejects in 1 ms with "the
   * encoder produced nothing for this position" before any encoder has run, and
   * two calls in the same tick each start a run for the same position - two
   * ffmpeg processes writing %d.ts into one directory, the first of them orphaned
   * by the second's assignment to `proc` and so never killed and never reported.
   */
  private running = false
  /**
   * Which run is current. A position cannot say: segment(5), segment(40) and
   * segment(5) again leave two runs asked for the same position, and a check on
   * `runStart` lets both of them through to spawn.
   */
  private runId = 0
  private runFailed: string | null = null
  private disposed = false

  constructor(
    readonly key: SessionKey,
    private readonly info: MediaInfo,
    private readonly plan: RoutePlan,
  ) {
    this.dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX))
    this.segmentCount = segmentsIn(info)
  }

  /**
   * The complete VOD playlist, known before anything has been encoded.
   *
   * This is the trick the whole design rests on: hls.js is handed the entire
   * timeline immediately, so seeking to the last minute of a two-hour film is
   * instant and costs one segment.
   */
  playlist(segmentUrl: (n: number) => string): string {
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
    ]
    for (let n = 0; n < this.segmentCount; n++) {
      const remaining = this.info.duration - n * SEGMENT_SECONDS
      const length = Math.min(SEGMENT_SECONDS, Math.max(0.001, remaining))
      lines.push(`#EXTINF:${length.toFixed(6)},`, segmentUrl(n))
    }
    lines.push('#EXT-X-ENDLIST')
    return lines.join('\n') + '\n'
  }

  /** Produces segment `n` if it is not on disk yet, and returns its path. */
  async segment(n: number): Promise<string> {
    if (this.disposed) throw new Error('session closed')
    if (n < 0 || n >= this.segmentCount) throw new Error(`segment ${n} out of range`)

    const path = this.segmentPath(n)

    if (await exists(path)) {
      // A file that exists may still be open for writing; wait for it to close.
      await this.awaitComplete(n)
      void this.maintain(n)
      return path
    }

    const inCurrentRun = this.running && n >= this.runStart && n < this.runStart + RUN_SEGMENTS
    if (!inCurrentRun) this.startRun(n)

    await this.awaitComplete(n)
    void this.maintain(n)
    return path
  }

  dispose() {
    this.disposed = true
    this.kill()
    try {
      rmSync(this.dir, { recursive: true, force: true })
    } catch {
      /* the OS will clean the temp directory up eventually */
    }
  }

  /* --------------------------------------------------------------- internals */

  private segmentPath(n: number): string {
    return join(this.dir, `${n}.ts`)
  }

  /**
   * A segment is finished when the muxer has moved on to the next one, or when
   * the process producing it has exited. Checking the file size is not enough:
   * the muxer writes continuously and a partially written segment plays as a
   * corrupt fragment.
   *
   * One thing this cannot clear, and does not try to: the last segment of the
   * file, complete on disk, after a run failed somewhere else. It has no
   * successor by definition, so "the muxer moved on" can never be true of it,
   * and a complete last segment and one the muxer was half way through look
   * identical from outside - which is what the failed-run branch below is
   * refusing. The cost is the final four seconds of a film, once, after an
   * encoder failure the viewer has already been told about; the alternative is
   * serving a corrupt fragment as the end of every film whose run died there.
   */
  private async awaitComplete(n: number): Promise<void> {
    const deadline = Date.now() + SEGMENT_TIMEOUT_MS

    for (;;) {
      if (this.disposed) throw new Error('session closed')

      // Whether this segment is finished comes before whether a run has failed.
      // Once the muxer has moved on to the next segment this one is whole, and a
      // failure after that changes nothing about it. In the other order a single
      // failed run made every segment already on disk unservable, until a request
      // for a missing one happened to start a new run - so a viewer rewinding into
      // KEEP_BEHIND got an error for each segment sitting there, complete.
      const nextExists = await exists(this.segmentPath(n + 1))
      if (nextExists) return

      // Still ahead of the branch below, which would otherwise take a half-written
      // segment left by a failed run as "all there is" and serve a corrupt fragment.
      if (this.runFailed) throw new Error(this.runFailed)

      if (!this.running) {
        // The run is over, so whatever is on disk for this segment is all there
        // is - and an empty file is the same news as no file. Both used to be
        // read as something: a zero-byte last segment of a run or of a file was
        // returned, and server.ts answered 200 with content-length 0, which
        // hls.js cannot parse, so it asked again and each attempt paid for
        // another run; a zero-byte segment anywhere else matched none of these
        // branches at all and sat here until the 30 s deadline - measured at
        // 30005 ms, which is the shape of the request left pending for 22 s.
        //
        // Empty means zero bytes and nothing else. A larger file cannot be told
        // apart from a complete one by its size: the smallest whole segment
        // measured here is 14 kB (one 854x480 frame, no audio) while a write cut
        // off part way can be any size at all, so a threshold would refuse whole
        // segments without catching partial ones. What catches those is the
        // failed-run branch above and the muxer having moved on, not arithmetic
        // on a byte count.
        if ((await size(this.segmentPath(n))) > 0) return
        // Removed, not just refused: segment() sends an existing file straight
        // here without starting a run, so a zero-byte file left by a run that was
        // killed just after opening it would fail every retry until prune()
        // got to it. Safe only because no run is live to be writing it.
        await unlink(this.segmentPath(n)).catch(() => {})
        throw new Error('the encoder produced nothing for this position')
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for the encoder')

      await delay(POLL_MS)
    }
  }

  /** Keeps the encoder ahead of the player and the temp directory small. */
  private async maintain(n: number) {
    if (this.disposed) return

    const nearEnd = this.running && n >= this.runStart + RUN_SEGMENTS - LOOKAHEAD_SEGMENTS
    const runEnded = !this.running && this.runStart >= 0
    const next = this.runStart + RUN_SEGMENTS
    if ((nearEnd || runEnded) && next < this.segmentCount && n >= this.runStart) {
      // Only chase forwards. A viewer who just seeked backwards will trigger
      // their own run through segment().
      if (!(await exists(this.segmentPath(next)))) this.startRun(next)
    }

    await this.prune(n)
  }

  private async prune(n: number) {
    try {
      const files = await readdir(this.dir)
      await Promise.all(
        files.map(async (file) => {
          const num = Number(file.replace('.ts', ''))
          if (!Number.isFinite(num) || num >= n - KEEP_BEHIND) return
          await unlink(join(this.dir, file)).catch(() => {})
        }),
      )
    } catch {
      /* pruning is housekeeping; failing to do it must never break playback */
    }
  }

  private kill() {
    const proc = this.proc
    this.proc = null
    this.running = false
    this.runStart = -1
    if (!proc) return
    proc.removeAllListeners()
    try {
      proc.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }

  private startRun(from: number) {
    this.kill()
    this.running = true
    this.runFailed = null
    this.runStart = from
    const id = ++this.runId

    void capabilities().then((caps) => {
      // A newer run has taken this one's place, or the session is gone. Either
      // way `running` belongs to whoever replaced it, so it is not cleared here.
      if (this.disposed || this.runId !== id) return

      const start = from * SEGMENT_SECONDS
      const v = this.info.video
      const audio = this.info.audio[this.key.audioOrder] ?? this.info.audio[0]
      const args: string[] = ['-hide_banner', '-loglevel', 'error', '-nostdin']

      // Decoding on the GPU is what makes 4K HEVC free. It has to come before
      // the input, and it is skipped for software encoding on purpose.
      if (caps.hwaccel) args.push('-hwaccel', caps.hwaccel)

      // Seeking before -i is the fast path: ffmpeg jumps in the container
      // rather than decoding everything up to the point we want.
      args.push('-ss', String(start), '-i', this.info.path)

      // Encode a bounded window, then stop. This is the throttle.
      args.push('-t', String(RUN_SEGMENTS * SEGMENT_SECONDS))

      if (v) args.push('-map', `0:v:0`)
      if (audio) args.push('-map', `0:a:${audio.order}`)
      args.push('-map_metadata', '-1', '-sn', '-dn')

      if (v) {
        args.push('-c:v', caps.encoder, ...caps.encoderArgs)
        // Segment boundaries must fall exactly on keyframes, or a seek lands
        // mid-GOP and the first second of the segment is garbage.
        //
        // -force_key_frames alone is not enough: NVENC honours its own GOP
        // length instead and quietly produces ten second segments while the
        // playlist promises four, which sends the player's clock backwards.
        // Stating the interval in frames as well leaves it no room to decide.
        args.push('-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`)
        args.push('-fps_mode', 'cfr', '-g', String(Math.max(1, Math.round(v.fps * SEGMENT_SECONDS))))
        const height = this.key.maxHeight
        if (height > 0 && v.height > height) {
          // -2 keeps the width even, which every H.264 encoder requires.
          args.push('-vf', `scale=-2:${height}`)
        }
        args.push('-pix_fmt', 'yuv420p')
      }

      if (audio) {
        if (this.plan.copyAudio) args.push('-c:a', 'copy')
        else args.push('-c:a', 'aac', '-b:a', audio.channels > 2 ? '384k' : '192k')
      }

      args.push(
        '-f', 'segment',
        '-segment_time', String(SEGMENT_SECONDS),
        '-segment_time_delta', '0.05',
        '-segment_start_number', String(from),
        // Absolute timestamps, so the player's clock agrees with the playlist
        // no matter which segment was produced first.
        '-output_ts_offset', String(start),
        '-segment_format', 'mpegts',
        '-avoid_negative_ts', 'disabled',
        '-muxdelay', '0',
        '-muxpreload', '0',
        join(this.dir, '%d.ts'),
      )

      const proc = spawn(FFMPEG, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      this.proc = proc

      let stderr = ''
      proc.stderr?.on('data', (chunk: Buffer) => {
        // Keep only the tail: a broken input can produce megabytes of errors.
        stderr = (stderr + chunk.toString()).slice(-2000)
      })
      proc.on('error', (err) => {
        if (this.proc !== proc) return
        this.proc = null
        this.running = false
        this.runFailed = `could not start the encoder: ${err.message}`
      })
      proc.on('exit', (code) => {
        if (this.proc !== proc) return
        this.proc = null
        this.running = false
        // Code 0 and being killed are both normal: a run always ends.
        if (code !== null && code !== 0) this.runFailed = stderr.trim() || `the encoder exited with code ${code}`
      })
    }).catch((err: unknown) => {
      // The probe or the spawn threw. Nothing will ever clear `running` for this
      // run, so a request would poll the full 30 s and report a timeout.
      if (this.disposed || this.runId !== id) return
      this.running = false
      this.runFailed = `could not start the encoder: ${err instanceof Error ? err.message : String(err)}`
    })
  }

}

/**
 * Slack on the tail comparison below: one microsecond, the last digit ffprobe
 * prints.
 *
 * Both sides of it are arrived at by arithmetic, and subtracting the segment
 * boundary from the duration throws away the bottom of the mantissa. This is not
 * only a worry about durations built by hand: ffprobe prints "40.040000" for a
 * silent 25 fps file of 1001 frames (`testsrc2=size=854x480:rate=25
 * -frames:v 1001`, the last frame at 40.000), and 40.04 - 10 * 4 comes out
 * 0.03999999999999915 against a frame of 0.04, so the frame at 40.000 was
 * dropped - while segmenting that file with the arguments startRun builds wrote
 * eleven segments, the eleventh holding exactly that frame in 14 kB. 20, 30, 40
 * and 100 fps land the same way.
 *
 * The cancellation to absorb is around 1e-14 at these durations. The slack is
 * this much wider than that because a duration landing within one ffprobe tick
 * below boundary-plus-a-frame is that frame rounded off rather than a shorter
 * one, so keeping its segment is the right answer there too.
 */
const TAIL_SLACK_SECONDS = 1e-6

/**
 * How many segments the file really has.
 *
 * Dividing the duration by the segment length and rounding up asks for one
 * segment too many whenever all that is left over is a stretch with no video
 * frame in it. ffmpeg opens a segment where a frame starts and nowhere else, so
 * fixtures/hevc10-ac3.mkv gets ten segments and stops while the playlist
 * promised eleven: 959 frames spaced 1/24 s apart, the last starting at 39.958,
 * so the picture ends at 40.000, and the 5 ms the container claims on top of
 * that is its AC-3 track, whose last packet starts at 39.973 and runs 32 ms.
 * fixtures/hd720.mkv, 40.021 s, is the same shape.
 *
 * Promising that eleventh one cost real time. hls.js asked for it while
 * buffering ahead, and asking started a whole ffmpeg run at -ss 40 that could
 * only read the input, produce no frame and exit 0 - half a second to a second
 * each time, leaving either a zero-byte segment that was served as a 200 the
 * player could not parse, or no file at all, which failed the request. Then the
 * player asked again.
 *
 * Measuring the tail against one frame rather than against a fixed number of
 * milliseconds is not a bet on how much time may be thrown away. A container's
 * duration spans the last frame's time on screen, so a tail shorter than a frame
 * is a tail with no frame in it however low the frame rate goes, and the two
 * low-frame-rate shapes that could have shown otherwise were measured with the
 * staged binary, segmenting the whole file with startRun's own arguments:
 *
 * - 1 fps, last frame at exactly 40.000. Such a file is 41.000 s long rather
 *   than 40.5 (both the Matroska and the MP4 muxer write the duration that way),
 *   so the tail is 1.000 s against a frame of 1.000 s and nothing is dropped.
 *   Eleven segments promised, eleven written, the eleventh holding that frame.
 * - 1 fps, 40.521 s, picture ending at 40.000 (video `testsrc2:rate=1 -t 40`
 *   muxed with a 40.5 s sine track). Ten segments promised, ten written: the
 *   521 ms left over is audio, and it is not lost but muxed into segment 9,
 *   which carries packets out to 40.490.
 *
 * So an absolute cap on the tail would buy nothing and cost the second of those:
 * any cap loose enough to bound the loss at 1 fps promises its empty eleventh
 * segment back.
 */
function segmentsIn(info: MediaInfo): number {
  const count = Math.max(1, Math.ceil(info.duration / SEGMENT_SECONDS))
  const tail = info.duration - (count - 1) * SEGMENT_SECONDS
  const frame = info.video && info.video.fps > 0 ? 1 / info.video.fps : 0
  // A file one segment long has nothing to drop, and without a frame rate there
  // is nothing to measure the tail against.
  return count > 1 && tail < frame - TAIL_SLACK_SECONDS ? count - 1 : count
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function size(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}
