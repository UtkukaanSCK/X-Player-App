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
  /** Files handed to the app by the OS, now and on every later invocation. */
  onOpenPaths(handler: (paths: string[]) => void): () => void
}

declare global {
  interface Window {
    desktop: DesktopApi
  }
}
