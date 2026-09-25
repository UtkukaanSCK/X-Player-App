/** The contract between the Electron side and the window. Types only. */

export interface MediaSource {
  src: string
  label: string
  type: 'auto' | 'hls' | 'native'
}

export interface MediaTextTrack {
  src: string
  label: string
  srclang: string
  default?: boolean
}

export interface MediaAudioTrack {
  id: number
  label: string
  language?: string
}

export interface OpenedMedia {
  id: string
  path: string
  name: string
  duration: number
  /** "direct" means the file is played untouched; nothing is being converted. */
  route: 'direct' | 'transcode'
  /** One sentence saying what is happening to the file, shown to the user. */
  reason: string
  videoCodec: string
  audioCodec: string
  resolution: string
  sources: MediaSource[]
  tracks: MediaTextTrack[]
  audioTracks: MediaAudioTrack[]
  activeAudioTrack: number
  /**
   * Subtitles present in the file that cannot be displayed without re-encoding
   * the picture. Listed so they are not silently missing.
   */
  imageSubtitles: string[]
}

export interface OpenResult {
  ok: true
  media: OpenedMedia
}

export interface OpenFailure {
  ok: false
  path: string
  name: string
  message: string
}

export interface Diagnostics {
  ffmpeg: boolean
  encoder: string
  hardware: boolean
  hwaccel: string | null
  /** Encoders ffmpeg listed but that failed a real encode on this machine. */
  rejected: string[]
  platform: 'windows' | 'macos' | 'linux' | 'other'
}

/** The containers the open file can be exported to. */
export type ExportFormat = 'mp4' | 'mkv' | 'webm' | 'mov' | 'gif'

/**
 * A stretch of the open file, in seconds, as marked on the seek bar.
 *
 * Only the GIF export uses one so far: a GIF of a whole film is not something
 * anyone wants, and every other format takes the file entire.
 */
export interface ExportRange {
  start: number
  end: number
}

/** One row of the Export menu. */
export interface ExportOption {
  format: ExportFormat
  /** "MP4", "WebM". */
  label: string
  available: boolean
  method: 'copy' | 'encode'
  /** How long it will take, or why it cannot be chosen. */
  note: string
}

export type ExportStart = { ok: true; jobId: string; outputName: string } | { ok: false; message: string }

/** Sent while an export runs, and once more when it ends. */
export interface ExportProgress {
  jobId: string
  sourceName: string
  /** The name it is being written under, beside the original. */
  outputName: string
  format: ExportFormat
  state: 'running' | 'done' | 'failed' | 'cancelled'
  /** 0 to 1. */
  fraction: number
  /** Why it failed. Absent in every other state. */
  message?: string
}

export interface RecentEntry {
  path: string
  name: string
  at: number
}

/**
 * Settings that belong to the viewer rather than to any one file.
 *
 * The player remembers a position per file on its own, but volume and speed are
 * not properties of a film - they are how this person likes to watch. The app
 * remounts the player for every file, so without somewhere outside the component
 * to keep them, every episode started at full volume.
 *
 * Mute is deliberately not among them. It is a momentary thing - answer the
 * door, mute; come back, unmute - and it is also set for reasons that are not a
 * preference at all, so remembering it means a file that opens silent for no
 * reason the viewer can name. Wanting silence is volume 0, which is remembered,
 * and which the player already treats as muted.
 */
export interface Preferences {
  /** 0 to 1. Silence is volume 0, not a separate mute flag - see below. */
  volume: number
  /** Playback rate, 0.25 to 4. */
  rate: number
}

export interface DesktopApi {
  /** Opens the system file picker. Returns the chosen paths. */
  pick(): Promise<string[]>
  pickFolder(): Promise<string[]>
  /** Prepares a file for playback. */
  open(path: string): Promise<OpenResult | OpenFailure>
  /** Chooses another audio track; the caller reloads the player afterwards. */
  setAudio(id: string, order: number): Promise<OpenResult | OpenFailure>
  /** Expands a dropped folder into the playable files inside it. */
  expand(paths: string[]): Promise<string[]>
  /** Resolves a dropped File to its path on disk. */
  pathForFile(file: File): string
  recent(): Promise<RecentEntry[]>
  clearRecent(): Promise<void>
  diagnostics(): Promise<Diagnostics>
  setAlwaysOnTop(value: boolean): Promise<boolean>
  /** How this person likes to watch, remembered across files and launches. */
  preferences(): Promise<Preferences>
  savePreferences(next: Preferences): Promise<void>
  /**
   * Opens the operating system's default-applications settings.
   *
   * Not "make X-Player the default": Windows 8 and later protect that choice
   * with a hashed key precisely so applications cannot make it for you. All any
   * app can honestly do is take you to the page where you decide.
   */
  openDefaultAppsSettings(): Promise<boolean>
  /** What the open file, with this audio track, can be exported to. */
  exportOptions(id: string, audioOrder: number, range?: ExportRange | null): Promise<ExportOption[]>
  /**
   * Exports an open file beside the original. Takes the id of a file already
   * open, never a path: where it is written is decided on the Electron side.
   */
  startExport(
    id: string,
    format: ExportFormat,
    audioOrder: number,
    range?: ExportRange | null,
  ): Promise<ExportStart>
  cancelExport(jobId: string): Promise<void>
  /** Shows a finished export in the file manager. */
  revealExport(jobId: string): Promise<boolean>
  onExportProgress(handler: (progress: ExportProgress) => void): () => void
  /** Files handed to the app by the OS, now and on every later invocation. */
  onOpenPaths(handler: (paths: string[]) => void): () => void
}

declare global {
  interface Window {
    desktop: DesktopApi
  }
}
