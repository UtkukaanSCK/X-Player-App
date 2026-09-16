import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { outputPathFor } from './names'

/**
 * Where an export lands.
 *
 * Next to the file it came from, under the same name with the new extension -
 * and never on top of anything already there. The existence check is handed
 * in, so these cases describe folders without touching a disk.
 */

const DIR = join(sep, 'videos')
const present = (...names: string[]) => (path: string) => names.some((n) => join(DIR, n) === path)

describe('choosing the name of an export', () => {
  it('keeps the name and swaps the extension', () => {
    expect(outputPathFor(join(DIR, 'film.mkv'), 'mp4', present())).toBe(join(DIR, 'film.mp4'))
  })

  it('numbers the copy rather than overwriting a file of that name', () => {
    expect(outputPathFor(join(DIR, 'film.mkv'), 'mp4', present('film.mp4'))).toBe(join(DIR, 'film (1).mp4'))
  })

  it('keeps counting past every number already taken', () => {
    const taken = present('film.mp4', 'film (1).mp4', 'film (2).mp4')
    expect(outputPathFor(join(DIR, 'film.mkv'), 'mp4', taken)).toBe(join(DIR, 'film (3).mp4'))
  })

  it('replaces only the last extension of a name with dots in it', () => {
    expect(outputPathFor(join(DIR, 'holiday.2024.cut.mkv'), 'webm', present())).toBe(join(DIR, 'holiday.2024.cut.webm'))
  })

  it('adds an extension to a name that has none', () => {
    expect(outputPathFor(join(DIR, 'recording'), 'mov', present())).toBe(join(DIR, 'recording.mov'))
  })
})
