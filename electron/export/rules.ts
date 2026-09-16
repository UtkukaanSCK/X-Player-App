import type { ExportFormat } from '../../shared/api'
import type { MediaInfo } from '../gateway/types'

/** What exporting one file to one format would do, decided before anything runs. */
export interface ExportPlan {
  format: ExportFormat
  available: boolean
  /** "copy" when every stream kept is copied as it is; "encode" when any is re-encoded. */
  method: 'copy' | 'encode'
  /** One line for the menu: how long it will take, or why it cannot be done. */
  note: string
  /** Output options, everything between the input and the output path. */
  args: string[]
}

export const LABEL: Record<ExportFormat, string> = { mp4: 'MP4', mkv: 'MKV', webm: 'WebM', mov: 'MOV' }

/**
 * The muxer for each format, stated outright.
 *
 * An export is written under a temporary name ending in .part and renamed once
 * it is complete, so a half-finished file never carries the real name. ffmpeg
 * picks a container from the output's extension, and .part is not one.
 */
const MUXER: Record<ExportFormat, string> = { mp4: 'mp4', mkv: 'matroska', webm: 'webm', mov: 'mov' }

interface Target {
  /** Video codecs this container holds as they are. */
  copiesVideo: string[]
  copiesAudio: string[]
  video: { encoder: string; name: string; args: string[] }
  audio: { encoder: string; name: string; bitrate: (channels: number) => string }
  /** What text subtitles become. Picture subtitles fit none of these containers. */
  subtitles: string
  extra: string[]
}

/*
 * Copy whatever the container can hold, and re-encode only what it cannot.
 *
 * Copying is seconds for a feature film and loses nothing; re-encoding the
 * picture is minutes to hours and loses a little. So the lists below are the
 * whole of the decision, and they are deliberately the conservative set: a
 * codec the container technically accepts but common players refuse (FLAC or
 * Opus in MP4) is re-encoded, because an export nobody can open is not one.
 */
const H264 = { encoder: 'libx264', name: 'H.264', args: ['-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p'] }
const AAC = { encoder: 'aac', name: 'AAC', bitrate: (channels: number) => (channels > 2 ? '384k' : '192k') }

const TARGETS: Record<Exclude<ExportFormat, 'mkv'>, Target> = {
  mp4: {
    copiesVideo: ['h264', 'hevc', 'av1', 'mpeg4'],
    copiesAudio: ['aac', 'mp3', 'ac3', 'eac3'],
    video: H264,
    audio: AAC,
    subtitles: 'mov_text',
    // The index goes first, so a player can start without fetching the tail.
    extra: ['-movflags', '+faststart'],
  },
  mov: {
    copiesVideo: ['h264', 'hevc', 'prores', 'mpeg4'],
    copiesAudio: ['aac', 'mp3', 'alac', 'pcm_s16le', 'pcm_s24le'],
    video: H264,
    audio: AAC,
    subtitles: 'mov_text',
    extra: ['-movflags', '+faststart'],
  },
  webm: {
    copiesVideo: ['vp8', 'vp9', 'av1'],
    copiesAudio: ['opus', 'vorbis'],
    // Constant quality with no bitrate cap, and row multithreading: libvpx is
    // single-threaded without it and takes several times realtime on a film.
    video: {
      encoder: 'libvpx-vp9',
      name: 'VP9',
      args: ['-crf', '32', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p'],
    },
    audio: { encoder: 'libopus', name: 'Opus', bitrate: (channels) => (channels > 2 ? '256k' : '128k') },
    subtitles: 'webvtt',
    extra: [],
  },
}

export function planExport(
  info: MediaInfo,
  audioOrder: number,
  format: ExportFormat,
  encoders: ReadonlySet<string>,
): ExportPlan {
  const unavailable = (note: string): ExportPlan => ({ format, available: false, method: 'copy', note, args: [] })

  if (!info.video) return unavailable('There is no picture to export')
  // By extension, not by what ffprobe calls the container: it names MP4 and
  // MOV identically, and a person thinks of the file by the name they see.
  if (extensionOf(info.name) === format) return unavailable(`Already ${LABEL[format]}`)
  if (format === 'mkv') return planMatroska(info)

  const target = TARGETS[format]
  const video = info.video
  // Nothing chosen (-1, the direct route) means the file's own default, which
  // is the track the player is sounding; only then the first one.
  const audio =
    info.audio.find((a) => a.order === audioOrder) ?? info.audio.find((a) => a.isDefault) ?? info.audio[0]
  const copyVideo = target.copiesVideo.includes(video.codec)
  const copyAudio = !audio || target.copiesAudio.includes(audio.codec)

  if (!copyVideo && !encoders.has(target.video.encoder)) {
    return unavailable(`This ffmpeg has no ${target.video.name} encoder`)
  }
  if (!copyAudio && !encoders.has(target.audio.encoder)) {
    return unavailable(`This ffmpeg has no ${target.audio.name} encoder`)
  }

  const text = info.subtitles.filter((s) => s.textBased)
  const dropped = info.subtitles.length - text.length

  // The picture by its own index, and only that one. "the first video stream"
  // would be the cover art in a file that carries one, and the copy-or-encode
  // decision above was made about this stream.
  const args = ['-map', `0:${video.index}`]
  if (audio) args.push('-map', `0:a:${audio.order}`)
  for (const s of text) args.push('-map', `0:${s.index}`)

  if (copyVideo) {
    args.push('-c:v', 'copy')
    // QuickTime and Safari refuse HEVC tagged hev1, which is what a copy keeps.
    if (video.codec === 'hevc') args.push('-tag:v', 'hvc1')
  } else {
    args.push('-c:v', target.video.encoder, ...target.video.args)
  }

  if (audio) {
    if (copyAudio) args.push('-c:a', 'copy')
    else {
      args.push('-c:a', target.audio.encoder, '-b:a', target.audio.bitrate(audio.channels))
      // Opus knows only the standard layouts in its default mapping family,
      // and 5.1(side) - what AC-3 and DTS surround decode to - is not one of
      // them: without this the encode stops before it has written a frame.
      if (target.audio.encoder === 'libopus' && audio.channels > 2) args.push('-mapping_family', '1')
    }
  }

  if (text.length > 0) args.push('-c:s', target.subtitles)
  args.push(...target.extra, '-f', MUXER[format])

  let note = !copyVideo ? 'Re-encodes the video, slow' : !copyAudio ? 'Re-encodes the audio' : 'Copies the streams, fast'
  if (dropped > 0) note += `, leaves out ${dropped} picture subtitle${dropped > 1 ? 's' : ''}`

  return { format, available: true, method: copyVideo && copyAudio ? 'copy' : 'encode', note, args }
}

/**
 * Matroska holds anything, so an MKV export copies every stream: all the audio
 * tracks, every subtitle and the fonts styled subtitles depend on.
 */
function planMatroska(info: MediaInfo): ExportPlan {
  const args = ['-map', '0:v', '-map', '0:a?', '-map', '0:s?', '-map', '0:t?', '-c', 'copy']
  // MP4's subtitle format is the one Matroska cannot store as it is.
  if (info.subtitles.some((s) => s.codec === 'mov_text')) args.push('-c:s', 'srt')
  args.push('-f', MUXER.mkv)
  return { format: 'mkv', available: true, method: 'copy', note: 'Copies every stream, fast', args }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}
