import { basename, dirname, extname, join } from 'node:path'
import type { ExportFormat } from '../../shared/api'

/**
 * The path an export is written to.
 *
 * Beside the file it came from, under the same name with the new extension, so
 * it is found where the person last saw the original. A file already there is
 * never replaced: the export is numbered "(1)", "(2)" instead, the way a file
 * manager names a copy.
 */
export function outputPathFor(source: string, format: ExportFormat, exists: (path: string) => boolean): string {
  const dir = dirname(source)
  const stem = basename(source, extname(source))
  let candidate = join(dir, `${stem}.${format}`)
  for (let n = 1; exists(candidate); n++) candidate = join(dir, `${stem} (${n}).${format}`)
  return candidate
}
