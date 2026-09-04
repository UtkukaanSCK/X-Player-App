import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { promisify } from 'node:util'
import { FFMPEG } from './ffmpeg'
import type { MediaInfo } from './types'

const run = promisify(execFile)

/*
 * Extraction demuxes the whole container, so it is allowed longer than a
 * conversion of a file that is already subtitles. Both are bounded: the HTTP
 * request is held open for the duration, and an unbounded one never answers.
 */
const EXTRACT_TIMEOUT_MS = 60_000
const CONVERT_TIMEOUT_MS = 30_000

/** Sidecar subtitle files worth picking up automatically. */
const SIDECAR_EXTENSIONS = new Set(['.srt', '.ass', '.ssa', '.vtt', '.sub'])

export interface SidecarSubtitle {
  /** Absolute path on disk. */
  path: string
  label: string
}

/**
 * Converts one embedded subtitle stream to WebVTT.
 *
 * ASS and SSA carry positioning, fonts and colours that WebVTT has no room for.
 * The text survives, the styling does not, and the app says so rather than
 * quietly showing a worse version of what the file contains.
 */
export async function extractSubtitle(info: MediaInfo, streamIndex: number): Promise<string> {
  const { stdout } = await run(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', info.path,
      '-map', `0:${streamIndex}`,
      '-c:s', 'webvtt',
      '-f', 'webvtt',
      'pipe:1',
    ],
    { maxBuffer: 64 << 20, encoding: 'utf8', timeout: EXTRACT_TIMEOUT_MS },
  )
  return stdout
}

/** Converts a subtitle file sitting next to the video. */
export async function convertSidecar(path: string): Promise<string> {
  if (extname(path).toLowerCase() === '.vtt') return readFile(path, 'utf8')
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1'],
    { maxBuffer: 64 << 20, encoding: 'utf8', timeout: CONVERT_TIMEOUT_MS },
  )
  return stdout
}

/**
 * Finds subtitle files that belong to this video.
 *
 * Matches `film.srt` and `film.en.srt` next to `film.mkv`, which is how
 * practically every download names them. The language suffix becomes the label.
 */
export async function findSidecars(videoPath: string): Promise<SidecarSubtitle[]> {
  const dir = dirname(videoPath)
  const stem = basename(videoPath, extname(videoPath)).toLowerCase()

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const found: SidecarSubtitle[] = []
  for (const entry of entries) {
    const ext = extname(entry).toLowerCase()
    if (!SIDECAR_EXTENSIONS.has(ext)) continue

    const name = basename(entry, extname(entry)).toLowerCase()
    if (name !== stem && !name.startsWith(`${stem}.`)) continue

    const suffix = name.slice(stem.length).replace(/^\./, '')
    found.push({
      path: join(dir, entry),
      label: suffix ? `${suffix.toUpperCase()} (file)` : `${ext.slice(1).toUpperCase()} file`,
    })
  }
  return found
}
