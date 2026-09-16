import { describe, expect, it } from 'vitest'
import { progressReader } from './progress'

/**
 * How far an export has got, read from ffmpeg's `-progress pipe:1` output.
 *
 * ffmpeg writes a block of key=value lines and closes each with `progress=`.
 * The pipe hands those over in arbitrary chunks, so a value can arrive cut in
 * half, and the first blocks of a run say `N/A` rather than a time.
 */

function collect(duration: number) {
  const seen: { fraction: number; ended: boolean }[] = []
  const push = progressReader(duration, (fraction, ended) => seen.push({ fraction, ended }))
  return { seen, push }
}

describe('reading export progress', () => {
  it('reports the share of the duration written so far', () => {
    const { seen, push } = collect(10)
    push('frame=60\nout_time_us=2500000\nprogress=continue\n')
    expect(seen).toEqual([{ fraction: 0.25, ended: false }])
  })

  it('puts a value back together when the pipe splits it', () => {
    const { seen, push } = collect(10)
    push('out_time_us=25')
    push('00000\nprogress=con')
    push('tinue\n')
    expect(seen).toEqual([{ fraction: 0.25, ended: false }])
  })

  it('reads Windows line endings', () => {
    const { seen, push } = collect(10)
    push('out_time_us=5000000\r\nprogress=continue\r\n')
    expect(seen).toEqual([{ fraction: 0.5, ended: false }])
  })

  it('reports the end as complete, whatever the last time said', () => {
    const { seen, push } = collect(10)
    push('out_time_us=9960000\nprogress=end\n')
    expect(seen.at(-1)).toEqual({ fraction: 1, ended: true })
  })

  it('never reports more than all of it', () => {
    const { seen, push } = collect(10)
    // The last audio packet can end past the probed duration.
    push('out_time_us=10400000\nprogress=continue\n')
    expect(seen).toEqual([{ fraction: 1, ended: false }])
  })

  it('treats a time ffmpeg does not know yet as no progress', () => {
    const { seen, push } = collect(10)
    push('out_time_us=N/A\nprogress=continue\n')
    expect(seen).toEqual([{ fraction: 0, ended: false }])
  })

  it('reports nothing but the end for a file whose duration is unknown', () => {
    const { seen, push } = collect(0)
    push('out_time_us=4000000\nprogress=continue\nout_time_us=8000000\nprogress=end\n')
    expect(seen).toEqual([
      { fraction: 0, ended: false },
      { fraction: 1, ended: true },
    ])
  })
})
