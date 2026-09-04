import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { AudioStream, MediaInfo, SubtitleStream, VideoStream } from './types'

/**
 * The routing rules are the app's actual claims, one per line: this file plays
 * untouched, that one has to be converted and here is why. Until now they were
 * only checked through the end-to-end suite, which needs a real ffmpeg, real
 * fixtures and half a minute per case. These run in milliseconds and cover the
 * combinations no fixture does.
 *
 * Capability detection is stubbed rather than run. What encoder a machine has
 * changes the sentence shown to the user, never the route, and a unit test
 * should not depend on the GPU it happens to run on.
 */
vi.mock('./ffmpeg', () => ({
  capabilities: async () => ({
    encoder: 'h264_nvenc',
    hardware: true,
    hwaccel: 'cuda',
    encoderArgs: [],
    rejected: [],
  }),
}))

let planRoute: typeof import('./plan').planRoute

beforeAll(async () => {
  ;({ planRoute } = await import('./plan'))
})

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

function file(path: string, over: Partial<MediaInfo> = {}): MediaInfo {
  return {
    path,
    name: path.split('/').pop() ?? path,
    size: 1_000_000,
    container: 'test',
    duration: 600,
    video: video(),
    audio: [audio()],
    subtitles: [],
    ...over,
  }
}

describe('files the browser can already play', () => {
  it('hands an H.264 MP4 straight over', async () => {
    const plan = await planRoute(file('/v/film.mp4'))
    expect(plan.route).toBe('direct')
    expect(plan.reason).toBe('Playing the file as it is')
  })

  it.each(['/v/a.mp4', '/v/a.m4v', '/v/a.mov', '/v/a.webm', '/v/a.ogv'])('accepts %s', async (path) => {
    expect((await planRoute(file(path))).route).toBe('direct')
  })

  it('is not fooled by an upper-case extension', async () => {
    expect((await planRoute(file('/v/HOLIDAY.MP4'))).route).toBe('direct')
  })

  it.each(['vp8', 'vp9', 'av1'])('accepts %s video', async (codec) => {
    expect((await planRoute(file('/v/a.webm', { video: video({ codec }) }))).route).toBe('direct')
  })

  it.each(['aac', 'mp3', 'opus', 'vorbis', 'flac'])('accepts %s audio', async (codec) => {
    expect((await planRoute(file('/v/a.mp4', { audio: [audio({ codec })] }))).route).toBe('direct')
  })

  it('plays a file with no audio at all', async () => {
    expect((await planRoute(file('/v/silent.mp4', { audio: [] }))).route).toBe('direct')
  })
})

describe('the container alone can disqualify a file', () => {
  it('sends an H.264 MKV to be converted even though the stream would play', async () => {
    // The single fact this whole app exists for.
    const plan = await planRoute(file('/v/film.mkv'))
    expect(plan.route).toBe('transcode')
  })

  it.each(['/v/a.mkv', '/v/a.avi', '/v/a.ts', '/v/a.flv', '/v/a.wmv', '/v/a.m2ts'])(
    'rejects the %s container',
    async (path) => {
      expect((await planRoute(file(path))).route).toBe('transcode')
    },
  )
})

describe('pixel formats no browser decodes', () => {
  it.each(['yuv420p10le', 'yuv422p', 'yuv444p', 'yuv420p12le'])(
    'converts H.264 in %s even inside an MP4',
    async (pixFmt) => {
      const plan = await planRoute(file('/v/anime.mp4', { video: video({ pixFmt }) }))
      expect(plan.route).toBe('transcode')
    },
  )

  it('reports 10-bit in the sentence the user reads', async () => {
    const plan = await planRoute(file('/v/anime.mkv', { video: video({ codec: 'hevc', pixFmt: 'yuv420p10le' }) }))
    expect(plan.reason).toContain('HEVC 10-bit')
    expect(plan.reason).toContain('NVENC hardware')
  })

  it('applies the depth rule only to H.264, since the others are converted anyway', async () => {
    const plan = await planRoute(file('/v/clip.webm', { video: video({ codec: 'vp9', pixFmt: 'yuv420p10le' }) }))
    expect(plan.route).toBe('direct')
  })
})

describe('audio', () => {
  it.each(['ac3', 'eac3', 'dts', 'truehd', 'pcm_s16le', 'wmav2'])('converts %s', async (codec) => {
    const plan = await planRoute(file('/v/film.mp4', { audio: [audio({ codec })] }))
    expect(plan.route).toBe('transcode')
    expect(plan.reason).toContain('audio to AAC')
  })

  it('copies AAC into the segments but never MP3', async () => {
    // MP3 frames hold 1152 samples and cannot be split on a video boundary, so
    // copying them opens holes in the buffer at every seam.
    const withAac = await planRoute(file('/v/film.mkv', { audio: [audio({ codec: 'aac' })] }))
    const withMp3 = await planRoute(file('/v/film.mkv', { audio: [audio({ codec: 'mp3' })] }))
    expect(withAac.copyAudio).toBe(true)
    expect(withMp3.copyAudio).toBe(false)
  })

  it('judges the track that was actually chosen, not the first one', async () => {
    const info = file('/v/film.mkv', {
      audio: [audio({ codec: 'aac', order: 0 }), audio({ codec: 'dts', order: 1, index: 2 })],
    })
    expect((await planRoute(info, 0)).copyAudio).toBe(true)
    expect((await planRoute(info, 1)).copyAudio).toBe(false)
  })
})

describe('several audio tracks', () => {
  it('leaves the direct route even when the browser could play the file', async () => {
    // Chromium gives a page no way to pick a track out of a plain file, so a
    // menu that cannot switch anything would be worse than streaming.
    const info = file('/v/film.mp4', {
      audio: [audio({ order: 0 }), audio({ order: 1, index: 2, language: 'tur', title: 'Türkçe' })],
    })
    expect((await planRoute(info)).route).toBe('transcode')
  })
})

describe('video is never copied on the streaming route', () => {
  it('re-encodes even a perfectly good H.264 stream', async () => {
    // Copying would tie segment boundaries to the source keyframes, and finding
    // those means scanning the file - the wait this app exists to avoid.
    const plan = await planRoute(file('/v/film.mkv'))
    expect(plan.copyVideo).toBe(false)
  })

  it('does not tell the user it is converting H.264 into H.264', async () => {
    // The codec was never the problem here; the container was. Saying otherwise
    // reads as a bug to anyone who knows what is in their file.
    const plan = await planRoute(file('/v/film.mkv'))
    expect(plan.reason).not.toMatch(/H.264 video to H.264/)
    expect(plan.reason).toBe('Repacking MKV for streaming')
  })

  it('names the real codec when the browser genuinely cannot decode it', async () => {
    const plan = await planRoute(file('/v/film.mkv', { video: video({ codec: 'hevc' }) }))
    expect(plan.reason).toBe('Converting HEVC video to H.264 (NVENC hardware)')
  })

  it('mentions the audio alongside, in one sentence', async () => {
    const plan = await planRoute(file('/v/film.mkv', { audio: [audio({ codec: 'ac3' })] }))
    expect(plan.reason).toBe('Repacking MKV for streaming, and its AC-3 audio to AAC')
  })
})

describe('subtitles never change the route', () => {
  it('ignores embedded text subtitles when deciding', async () => {
    const plan = await planRoute(file('/v/film.mp4', { subtitles: [subtitle()] }))
    expect(plan.route).toBe('direct')
  })

  it('ignores image subtitles too, since they are extracted separately', async () => {
    const plan = await planRoute(file('/v/film.mp4', { subtitles: [subtitle({ codec: 'hdmv_pgs_subtitle', textBased: false })] }))
    expect(plan.route).toBe('direct')
  })
})

describe('files with no video', () => {
  it('does not claim it can play them directly', async () => {
    const plan = await planRoute(file('/v/podcast.mp4', { video: null }))
    expect(plan.route).toBe('transcode')
  })
})
