import { describe, expect, it } from 'vitest'
import { parseEncoders } from './ffmpeg'

/**
 * Which encoders this ffmpeg has, read from `ffmpeg -hide_banner -encoders`.
 *
 * The export menu offers a format only when the encoder it needs is here, and
 * the builds shipped for each platform come from different places with
 * different encoders compiled in. The sample is the head and a few rows of the
 * real output of the build this was written against.
 */
const SAMPLE = [
  'Encoders:',
  ' V..... = Video',
  ' A..... = Audio',
  ' S..... = Subtitle',
  ' .F.... = Frame-level multithreading',
  ' ..S... = Slice-level multithreading',
  ' ...X.. = Codec is experimental',
  ' ....B. = Supports draw_horiz_band',
  ' .....D = Supports direct rendering method 1',
  ' ------',
  ' V....D a64multi             Multicolor charset for Commodore 64 (codec a64_multi)',
  ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)',
  ' V....D libvpx-vp9           libvpx VP9 (codec vp9)',
  ' A....D aac                  AAC (Advanced Audio Coding)',
  ' A....D libopus              libopus Opus (codec opus)',
]

describe('reading the encoder list', () => {
  it('lists the encoders and none of the legend above them', () => {
    expect(parseEncoders(SAMPLE.join('\n'))).toEqual(new Set(['a64multi', 'libx264', 'libvpx-vp9', 'aac', 'libopus']))
  })

  it('reads the Windows build, which ends its lines with CRLF', () => {
    expect(parseEncoders(SAMPLE.join('\r\n')).has('libopus')).toBe(true)
  })

  it('finds nothing in output that is not an encoder list', () => {
    expect(parseEncoders('')).toEqual(new Set())
  })
})
