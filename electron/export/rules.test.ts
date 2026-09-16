import { describe, expect, it } from 'vitest'
import type { AudioStream, MediaInfo, SubtitleStream, VideoStream } from '../gateway/types'
import { planExport } from './rules'

/**
 * What an export copies, what it re-encodes, and what it refuses.
 *
 * These are the promises behind every row of the Export menu: "copies the
 * streams" has to mean nothing is decoded, and a format offered as available
 * has to be one this ffmpeg can actually produce. Each case below is a file a
 * person really has - an MKV off a camera, a WebM off the web, an HEVC rip -
 * and the flags are checked by what they make ffmpeg do, not by their order.
 */

/** Every encoder an export can ask for. */
const ALL = new Set(['libx264', 'aac', 'libvpx-vp9', 'libopus'])

function video(over: Partial<VideoStream> = {}): VideoStream {
  return { index: 0, codec: 'h264', profile: 'High', width: 1920, height: 1080, fps: 24, pixFmt: 'yuv420p', ...over }
}

function audio(over: Partial<AudioStream> = {}): AudioStream {
  return { index: 1, order: 0, codec: 'aac', channels: 2, language: 'eng', title: 'English', isDefault: true, ...over }
}

function subtitle(over: Partial<SubtitleStream> = {}): SubtitleStream {
  return {
    index: 2, codec: 'subrip', language: 'eng', title: 'English',
    isDefault: false, forced: false, textBased: true, ...over,
  }
}

function file(name: string, over: Partial<MediaInfo> = {}): MediaInfo {
  return {
    path: `/v/${name}`,
    name,
    size: 1_000_000,
    container: 'test',
    duration: 600,
    video: video(),
    audio: [audio()],
    subtitles: [],
    ...over,
  }
}

/** Every value that follows a flag, in the order ffmpeg will read them. */
function valuesOf(args: string[], flag: string): string[] {
  return args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []))
}

function valueOf(args: string[], flag: string): string | undefined {
  return valuesOf(args, flag).at(-1)
}

describe('exporting to MP4', () => {
  it('copies H.264 and AAC out of an MKV without decoding them', () => {
    const plan = planExport(file('film.mkv'), 0, 'mp4', ALL)
    expect(plan.available).toBe(true)
    expect(plan.method).toBe('copy')
    expect(valueOf(plan.args, '-c:v')).toBe('copy')
    expect(valueOf(plan.args, '-c:a')).toBe('copy')
    expect(valuesOf(plan.args, '-map')).toEqual(['0:0', '0:a:0'])
    // Without it the index sits at the end and a browser fetches the tail first.
    expect(valueOf(plan.args, '-movflags')).toBe('+faststart')
  })

  it('refuses to turn an MP4 into an MP4', () => {
    const plan = planExport(file('film.mp4'), 0, 'mp4', ALL)
    expect(plan.available).toBe(false)
    expect(plan.note).toMatch(/MP4/)
  })

  it('reads an upper-case extension as the same format', () => {
    expect(planExport(file('HOLIDAY.MP4'), 0, 'mp4', ALL).available).toBe(false)
  })

  it('re-encodes VP9 and Opus into H.264 and AAC', () => {
    const plan = planExport(
      file('clip.webm', { video: video({ codec: 'vp9' }), audio: [audio({ codec: 'opus' })] }),
      0, 'mp4', ALL,
    )
    expect(plan.method).toBe('encode')
    expect(valueOf(plan.args, '-c:v')).toBe('libx264')
    // 10-bit and 4:4:4 sources would otherwise produce files most players reject.
    expect(valueOf(plan.args, '-pix_fmt')).toBe('yuv420p')
    expect(valueOf(plan.args, '-c:a')).toBe('aac')
  })

  it('is unavailable when this ffmpeg has no H.264 encoder to re-encode with', () => {
    const plan = planExport(file('clip.webm', { video: video({ codec: 'vp9' }) }), 0, 'mp4', new Set(['aac']))
    expect(plan.available).toBe(false)
    expect(plan.note).toMatch(/H\.264/)
  })

  it('tags copied HEVC so Apple players will open it', () => {
    const plan = planExport(
      file('rip.mkv', { video: video({ codec: 'hevc', pixFmt: 'yuv420p10le' }), audio: [audio({ codec: 'ac3', channels: 6 })] }),
      0, 'mp4', ALL,
    )
    expect(valueOf(plan.args, '-c:v')).toBe('copy')
    expect(valueOf(plan.args, '-tag:v')).toBe('hvc1')
    expect(valueOf(plan.args, '-c:a')).toBe('copy')
  })

  it('re-encodes only the audio when the picture can be copied, and says it is the audio', () => {
    const plan = planExport(file('concert.mkv', { audio: [audio({ codec: 'flac' })] }), 0, 'mp4', ALL)
    expect(plan.method).toBe('encode')
    expect(valueOf(plan.args, '-c:v')).toBe('copy')
    expect(valueOf(plan.args, '-c:a')).toBe('aac')
    expect(plan.note).toMatch(/audio/i)
    expect(plan.note).not.toMatch(/video/i)
  })

  it('exports the audio track being listened to, not the first one', () => {
    const plan = planExport(
      file('dub.mkv', { audio: [audio(), audio({ index: 2, order: 1, language: 'tur', title: 'Türkçe', isDefault: false })] }),
      1, 'mp4', ALL,
    )
    expect(valuesOf(plan.args, '-map')).toEqual(['0:0', '0:a:1'])
  })

  it('leaves audio out entirely for a silent file', () => {
    const plan = planExport(file('silent.mkv', { audio: [] }), 0, 'mp4', ALL)
    expect(plan.available).toBe(true)
    expect(valuesOf(plan.args, '-map')).toEqual(['0:0'])
    expect(valueOf(plan.args, '-c:a')).toBeUndefined()
  })

  it('keeps text subtitles as mov_text and drops picture subtitles, saying so', () => {
    const plan = planExport(
      file('film.mkv', {
        subtitles: [subtitle({ index: 2 }), subtitle({ index: 3, codec: 'hdmv_pgs_subtitle', textBased: false })],
      }),
      0, 'mp4', ALL,
    )
    expect(valuesOf(plan.args, '-map')).toEqual(['0:0', '0:a:0', '0:2'])
    expect(valueOf(plan.args, '-c:s')).toBe('mov_text')
    expect(plan.note).toMatch(/subtitle/i)
  })
})

describe('exporting to MOV', () => {
  it('copies ALAC, which an MP4 export re-encodes', () => {
    const source = file('studio.mkv', { audio: [audio({ codec: 'alac' })] })
    expect(valueOf(planExport(source, 0, 'mov', ALL).args, '-c:a')).toBe('copy')
    expect(valueOf(planExport(source, 0, 'mp4', ALL).args, '-c:a')).toBe('aac')
  })

  it('refuses to turn a MOV into a MOV', () => {
    expect(planExport(file('phone.mov'), 0, 'mov', ALL).available).toBe(false)
  })
})

describe('exporting to WebM', () => {
  it('re-encodes H.264 and AAC into VP9 and Opus', () => {
    const plan = planExport(file('film.mp4'), 0, 'webm', ALL)
    expect(plan.method).toBe('encode')
    expect(valueOf(plan.args, '-c:v')).toBe('libvpx-vp9')
    expect(valueOf(plan.args, '-c:a')).toBe('libopus')
  })

  it('copies VP9 and Opus out of an MKV', () => {
    const plan = planExport(
      file('clip.mkv', { video: video({ codec: 'vp9' }), audio: [audio({ codec: 'opus' })] }),
      0, 'webm', ALL,
    )
    expect(plan.method).toBe('copy')
    expect(valueOf(plan.args, '-c:v')).toBe('copy')
    expect(valueOf(plan.args, '-c:a')).toBe('copy')
  })

  it('is unavailable without a VP9 encoder when the picture must be re-encoded', () => {
    const plan = planExport(file('film.mp4'), 0, 'webm', new Set(['libx264', 'aac', 'libopus']))
    expect(plan.available).toBe(false)
    expect(plan.note).toMatch(/VP9/)
  })

  it('is unavailable without an Opus encoder when the audio must be re-encoded', () => {
    const plan = planExport(
      file('clip.mkv', { video: video({ codec: 'vp9' }) }),
      0, 'webm', new Set(['libvpx-vp9']),
    )
    expect(plan.available).toBe(false)
    expect(plan.note).toMatch(/Opus/)
  })

  it('needs no encoder at all when every stream is copied', () => {
    const plan = planExport(
      file('clip.mkv', { video: video({ codec: 'av1' }), audio: [audio({ codec: 'vorbis' })] }),
      0, 'webm', new Set(),
    )
    expect(plan.available).toBe(true)
  })

  it('keeps text subtitles as WebVTT', () => {
    const plan = planExport(file('film.mp4', { subtitles: [subtitle({ index: 2 })] }), 0, 'webm', ALL)
    expect(valueOf(plan.args, '-c:s')).toBe('webvtt')
  })
})

describe('exporting to MKV', () => {
  it('copies every stream - all audio tracks, subtitles and attached fonts', () => {
    const plan = planExport(
      file('film.mp4', {
        video: video({ codec: 'hevc' }),
        audio: [audio({ codec: 'eac3' }), audio({ index: 2, order: 1, codec: 'aac' })],
        subtitles: [subtitle({ index: 3, codec: 'hdmv_pgs_subtitle', textBased: false })],
      }),
      0, 'mkv', ALL,
    )
    expect(plan.method).toBe('copy')
    expect(valueOf(plan.args, '-c')).toBe('copy')
    expect(valuesOf(plan.args, '-map')).toEqual(['0:v', '0:a?', '0:s?', '0:t?'])
  })

  it('turns mov_text subtitles into SRT, which Matroska can hold', () => {
    const plan = planExport(file('film.mp4', { subtitles: [subtitle({ codec: 'mov_text' })] }), 0, 'mkv', ALL)
    expect(valueOf(plan.args, '-c:s')).toBe('srt')
  })

  it('needs no encoder at all', () => {
    expect(planExport(file('film.mp4'), 0, 'mkv', new Set()).available).toBe(true)
  })

  it('refuses to turn an MKV into an MKV', () => {
    expect(planExport(file('film.mkv'), 0, 'mkv', ALL).available).toBe(false)
  })
})

describe('the file being written', () => {
  /*
   * An export is written under a temporary name ending in .part and renamed
   * when it is complete, so ffmpeg cannot guess the container from the name it
   * is writing to. Without the muxer stated it refuses to start at all.
   */
  it.each([
    ['mp4', 'film.mkv', 'mp4'],
    ['mov', 'film.mkv', 'mov'],
    ['webm', 'film.mkv', 'webm'],
    ['mkv', 'film.mp4', 'matroska'],
  ] as const)('names the %s muxer outright', (format, name, muxer) => {
    expect(valueOf(planExport(file(name), 0, format, ALL).args, '-f')).toBe(muxer)
  })
})

describe('a file with no picture', () => {
  it.each(['mp4', 'mov', 'webm', 'mkv'] as const)('cannot be exported to %s', (format) => {
    expect(planExport(file('podcast.m4a', { video: null }), 0, format, ALL).available).toBe(false)
  })
})

describe('files whose streams are not in the usual order', () => {
  it('maps the picture it decided on, not whichever video stream comes first', () => {
    // Cover art is a video stream too, and it is often stream 0. The codec
    // decision was made about the real picture, so the map has to match it.
    const info = file('album.mkv', { video: video({ index: 1 }), audio: [audio({ index: 2, order: 0 })] })
    const plan = planExport(info, 0, 'mp4', ALL)
    expect(valuesOf(plan.args, '-map')).toContain('0:1')
    expect(valuesOf(plan.args, '-map')).not.toContain('0:v:0')
  })

  it('tells libopus which channel layouts to expect for surround sound', () => {
    // 5.1 off a DVD or a Blu-ray rip decodes to 5.1(side), which Opus refuses
    // outright in its default mapping family.
    const info = file('film.mkv', { audio: [audio({ codec: 'ac3', channels: 6 })] })
    const plan = planExport(info, 0, 'webm', ALL)
    expect(valueOf(plan.args, '-c:a')).toBe('libopus')
    expect(valueOf(plan.args, '-mapping_family')).toBe('1')
  })
})

describe('a file playing straight from disk, with no track chosen', () => {
  it('exports the track the player is sounding: the one the file marks default', () => {
    // -1 is what the direct route reports. Chromium plays the default track,
    // so exporting the first one would hand back different sound.
    const info = file('film.mkv', {
      audio: [
        audio({ index: 1, order: 0, language: 'jpn', title: 'Japanese', isDefault: false }),
        audio({ index: 2, order: 1, language: 'eng', title: 'English', isDefault: true }),
      ],
    })
    expect(valuesOf(planExport(info, -1, 'mp4', ALL).args, '-map')).toEqual(['0:0', '0:a:1'])
  })
})
