/**
 * Turns ffmpeg's `-progress pipe:1` stream into how much of an export is done.
 *
 * ffmpeg writes blocks of key=value lines and closes each one with `progress=`,
 * which is when a reading is reported. The pipe splits those lines wherever it
 * likes, so an unfinished line is held until the rest of it arrives. Returns the
 * function to feed each chunk to.
 */
export function progressReader(
  duration: number,
  emit: (fraction: number, ended: boolean) => void,
): (chunk: string) => void {
  let pending = ''
  let fraction = 0

  return (chunk) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''

    for (const raw of lines) {
      const line = raw.trim()
      const eq = line.indexOf('=')
      if (eq < 0) continue
      const key = line.slice(0, eq)
      const value = line.slice(eq + 1)

      if (key === 'out_time_us') {
        // "N/A" until the first packet is written. With no duration there is
        // nothing to divide by, and a guess would be a number that lies.
        const us = Number(value)
        if (Number.isFinite(us) && duration > 0) fraction = Math.min(1, Math.max(0, us / 1_000_000 / duration))
      } else if (key === 'progress') {
        const ended = value === 'end'
        emit(ended ? 1 : fraction, ended)
      }
    }
  }
}
