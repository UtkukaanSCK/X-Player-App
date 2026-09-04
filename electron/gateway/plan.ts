import { extname } from 'node:path'
import { capabilities } from './ffmpeg'
import type { MediaInfo, RoutePlan } from './types'

/**
 * What Chromium can actually play, which is narrower than what people assume.
 *
 * The container matters as much as the codec: an H.264 video inside an MKV is
 * rejected outright even though the identical stream inside an MP4 plays. That
 * single fact is why this app exists.
 */
const NATIVE_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.ogv'])
const NATIVE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1'])
const NATIVE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac'])

/**
 * What can be copied into an MPEG-TS segment, which is a different question
 * from what a browser can decode.
 *
 * MP3 frames hold 1152 samples and cannot be split where a video segment ends,
 * so copied MP3 drifts a little further from the video boundary with every
 * segment until the buffer has holes in it and playback stops dead at the seam.
 * AAC frames are 1024 samples and the muxer lines them up. Everything else is
 * re-encoded, which costs almost nothing next to the video.
 */
const COPYABLE_AUDIO = new Set(['aac'])

/**
 * 8-bit 4:2:0 only. High 10, 4:2:2 and 4:4:4 H.264 decode nowhere in a browser,
 * and they are common in anime releases and camera footage - exactly the files
 * people complain other web players cannot open.
 */
const NATIVE_PIX_FMTS = new Set(['yuv420p', 'yuvj420p'])

function videoIsNative(info: MediaInfo): boolean {
  const v = info.video
  if (!v) return false
  if (!NATIVE_VIDEO.has(v.codec)) return false
  if (v.codec === 'h264' && !NATIVE_PIX_FMTS.has(v.pixFmt)) return false
  return true
}

function audioIsNative(info: MediaInfo, order: number): boolean {
  const a = info.audio[order]
  return !a || NATIVE_AUDIO.has(a.codec)
}

function audioIsCopyable(info: MediaInfo, order: number): boolean {
  const a = info.audio[order]
  return !a || COPYABLE_AUDIO.has(a.codec)
}

/** How the codec is written when a person reads it, not how ffmpeg spells it. */
const CODEC_NAMES: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
  mpeg4: 'MPEG-4',
  mpeg2video: 'MPEG-2',
  vc1: 'VC-1',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  dts: 'DTS',
  truehd: 'TrueHD',
  aac: 'AAC',
  mp3: 'MP3',
  mp2: 'MP2',
}

const name = (codec: string) => CODEC_NAMES[codec] ?? codec.toUpperCase()

/**
 * The sentence a person reads while the fan spins up.
 *
 * It has to name the real reason. An H.264 file in an MKV is re-encoded, but
 * saying "converting H.264 to H.264" reads as a bug: the codec was never the
 * problem, the container was. So a video the browser would have accepted is
 * described as repacking, and only a codec it genuinely cannot decode is
 * described as a conversion.
 */
function describe(
  info: MediaInfo,
  videoWouldHavePlayed: boolean,
  copyAudio: boolean,
  encoder: string,
  hardware: boolean,
): string {
  const v = info.video
  const a = info.audio[0]
  const audioNote = !copyAudio && a ? `, and its ${name(a.codec)} audio to AAC` : ''

  if (!v) return `Converting the audio to AAC`

  if (videoWouldHavePlayed) {
    const container = extname(info.path).slice(1).toUpperCase() || 'the container'
    return `Repacking ${container} for streaming${audioNote}`
  }

  const depth = v.pixFmt.includes('10') ? ' 10-bit' : ''
  const how = hardware ? `${(encoder.split('_')[1] ?? encoder).toUpperCase()} hardware` : 'software'
  return `Converting ${name(v.codec)}${depth} video to H.264 (${how})${audioNote}`
}

/**
 * Picks the cheapest route that actually plays.
 *
 * Direct means the file is handed to the browser untouched: no ffmpeg process
 * runs at all and seeking is as good as it gets. Everything else is streamed as
 * HLS built on demand.
 *
 * Files with several audio tracks are sent down the streaming route even when
 * the browser could play them, because Chromium exposes no way to pick a track
 * from a plain file. Offering a menu that cannot switch anything would be worse
 * than the small cost of streaming.
 */
export async function planRoute(info: MediaInfo, audioOrder = 0): Promise<RoutePlan> {
  const nativeContainer = NATIVE_EXTENSIONS.has(extname(info.path).toLowerCase())
  const copyVideo = videoIsNative(info)

  // Decided before asking about encoders, because this route never runs one.
  // Waiting on capability detection here made a file that needs no conversion
  // wait for the answer to a question about converting it.
  if (nativeContainer && copyVideo && audioIsNative(info, audioOrder) && info.audio.length <= 1) {
    return { route: 'direct', copyVideo: true, copyAudio: true, reason: 'Playing the file as it is' }
  }

  const caps = await capabilities()
  const copyAudio = audioIsCopyable(info, audioOrder)
  return {
    route: 'transcode',
    // Video is always re-encoded on the streaming route. Copying it would tie
    // segment boundaries to the source keyframes, whose positions we refuse to
    // spend seconds scanning for - and a mismatch there makes seeking land in
    // the wrong place, which is worse than a generation of quality loss.
    copyVideo: false,
    copyAudio,
    reason: describe(info, copyVideo, copyAudio, caps.encoder, caps.hardware),
  }
}
