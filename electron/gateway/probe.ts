import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { FFPROBE } from './ffmpeg'
import type { AudioStream, MediaInfo, SubtitleStream, VideoStream } from './types'

const run = promisify(execFile)

/** Long enough for a big file on a slow disk, short enough to fail a dead share. */
const PROBE_TIMEOUT_MS = 30_000

/** Subtitle codecs that carry text. The rest are bitmaps and need burn-in. */
const TEXT_SUBTITLES = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'microdvd'])

interface RawStream {
  index: number
  codec_type?: string
  codec_name?: string
  profile?: string
  width?: number
  height?: number
  pix_fmt?: string
  channels?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  disposition?: Record<string, number>
  tags?: Record<string, string>
}

function parseRate(value: string | undefined): number {
  if (!value) return 0
  const [num, den] = value.split('/').map(Number)
  if (!num || !den) return 0
  return num / den
}

/** A track needs a name a person can pick from, not "Stream #0:2". */
function describeAudio(s: RawStream, order: number): string {
  const tags = s.tags ?? {}
  const parts: string[] = []
  if (tags.title) parts.push(tags.title)
  else if (tags.language) parts.push(tags.language.toUpperCase())
  else parts.push(`Track ${order + 1}`)

  const layout = s.channels === 1 ? 'Mono' : s.channels === 2 ? 'Stereo' : s.channels ? `${s.channels}ch` : ''
  const detail = [s.codec_name?.toUpperCase(), layout].filter(Boolean).join(' ')
  return detail ? `${parts[0]} - ${detail}` : parts[0]
}

function describeSubtitle(s: RawStream, order: number): string {
  const tags = s.tags ?? {}
  if (tags.title) return tags.title
  if (tags.language) return tags.language.toUpperCase()
  return `Subtitles ${order + 1}`
}

/**
 * Reads everything playback decisions depend on in a single ffprobe call.
 *
 * Deliberately does not scan packets: that is what makes opening instant. The
 * cost is that we never learn where the keyframes are, which is why the
 * streaming path re-encodes rather than copying video.
 */
export async function probe(path: string): Promise<MediaInfo> {
  const { stdout } = await run(
    FFPROBE,
    [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      path,
    ],
    // A probe with no ceiling hangs the whole open path: ffprobe on an
    // unreachable network share never returns, and the window sits on "Opening"
    // with nothing to cancel. Generous, because a large file on a slow disk is
    // legitimately slow, but finite.
    { maxBuffer: 32 << 20, timeout: PROBE_TIMEOUT_MS },
  )

  const parsed = JSON.parse(stdout) as {
    format?: { format_name?: string; duration?: string }
    streams?: RawStream[]
  }
  const streams = parsed.streams ?? []
  const info = await stat(path)

  const rawVideo = streams.find((s) => s.codec_type === 'video' && !isCoverArt(s))
  const video: VideoStream | null = rawVideo
    ? {
        index: rawVideo.index,
        codec: rawVideo.codec_name ?? 'unknown',
        profile: rawVideo.profile ?? '',
        width: rawVideo.width ?? 0,
        height: rawVideo.height ?? 0,
        fps: parseRate(rawVideo.avg_frame_rate) || parseRate(rawVideo.r_frame_rate) || 25,
        pixFmt: rawVideo.pix_fmt ?? '',
      }
    : null

  const audio: AudioStream[] = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s, order) => ({
      index: s.index,
      order,
      codec: s.codec_name ?? 'unknown',
      channels: s.channels ?? 0,
      language: s.tags?.language ?? '',
      title: describeAudio(s, order),
      isDefault: (s.disposition?.default ?? 0) === 1,
    }))

  const subtitles: SubtitleStream[] = streams
    .filter((s) => s.codec_type === 'subtitle')
    .map((s, order) => ({
      index: s.index,
      codec: s.codec_name ?? 'unknown',
      language: s.tags?.language ?? '',
      title: describeSubtitle(s, order),
      isDefault: (s.disposition?.default ?? 0) === 1,
      forced: (s.disposition?.forced ?? 0) === 1,
      textBased: TEXT_SUBTITLES.has(s.codec_name ?? ''),
    }))

  return {
    path,
    name: basename(path),
    size: info.size,
    container: parsed.format?.format_name ?? '',
    duration: Number(parsed.format?.duration ?? 0) || 0,
    video,
    audio,
    subtitles,
  }
}

/** Embedded artwork shows up as a video stream; it is not the film. */
function isCoverArt(s: RawStream): boolean {
  return (s.disposition?.attached_pic ?? 0) === 1
}
