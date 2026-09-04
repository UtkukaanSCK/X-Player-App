/** What ffprobe found in a file, reduced to what playback actually needs. */

export interface VideoStream {
  index: number
  codec: string
  profile: string
  width: number
  height: number
  fps: number
  pixFmt: string
}

export interface AudioStream {
  index: number
  /** Position among audio streams only - what ffmpeg's `0:a:<n>` expects. */
  order: number
  codec: string
  channels: number
  language: string
  title: string
  isDefault: boolean
}

export interface SubtitleStream {
  index: number
  codec: string
  language: string
  title: string
  isDefault: boolean
  forced: boolean
  /** Image subtitles (PGS, VOBSUB) cannot become WebVTT; they need burn-in. */
  textBased: boolean
}

export interface MediaInfo {
  path: string
  name: string
  size: number
  container: string
  duration: number
  video: VideoStream | null
  audio: AudioStream[]
  subtitles: SubtitleStream[]
}

export type PlaybackRoute = 'direct' | 'transcode'

/**
 * Why the file is taking the route it is taking.
 *
 * This exists to be shown to the user. A player that silently re-encodes is a
 * player you cannot reason about when your laptop fan spins up.
 */
export interface RoutePlan {
  route: PlaybackRoute
  copyVideo: boolean
  copyAudio: boolean
  /** Short human sentence, e.g. "HEVC 10-bit video -> H.264 (NVENC)". */
  reason: string
}
