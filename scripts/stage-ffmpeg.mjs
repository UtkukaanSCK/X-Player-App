import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * Puts ffmpeg and ffprobe where electron-builder can pack them.
 *
 * By default they come from this machine's PATH, which is right for a local
 * build: the binaries that ship are the ones the tests were run against, and
 * build day does not depend on a third party being up.
 *
 * `--from <dir>` takes them from somewhere else instead, which is what the
 * release workflow needs - a CI runner has no ffmpeg worth shipping, and the one
 * a package manager installs is dynamically linked against libraries that exist
 * only on that runner.
 *
 * Either way the staged binaries are then run and inspected, because a build
 * that ships an ffmpeg which cannot start on a user's machine fails in the worst
 * possible way: silently, on their computer, looking like the app is broken.
 */
const OUT = 'resources/ffmpeg'
const WINDOWS = process.platform === 'win32'
const EXE = (name) => (WINDOWS ? `${name}.exe` : name)

const fromIndex = process.argv.indexOf('--from')
const fromDir = fromIndex === -1 ? null : process.argv[fromIndex + 1]

function locate(name) {
  if (fromDir) {
    const path = join(fromDir, EXE(name))
    if (!existsSync(path)) throw new Error(`${path} does not exist`)
    return path
  }
  const finder = WINDOWS ? 'where' : 'which'
  const found = execFileSync(finder, [name], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (found.length === 0) throw new Error(`${name} is not on PATH`)
  return found[0]
}

/** Paths that exist on a build machine and nowhere else. */
const NOT_PORTABLE = ['/opt/homebrew', '/usr/local/Cellar', '/home/linuxbrew', '/usr/local/opt']

/**
 * Checks the staged binary can actually run, and is not quietly tied to the
 * machine that built it.
 *
 * A Homebrew or apt ffmpeg looks perfect here and dies on a user's laptop with a
 * missing dylib. `ldd` and `otool` are how you find that out before shipping
 * rather than after.
 */
function verify(path) {
  execFileSync(path, ['-hide_banner', '-version'], { stdio: 'ignore', timeout: 30_000 })

  if (WINDOWS) return []
  const tool = process.platform === 'darwin' ? 'otool' : 'ldd'
  const args = process.platform === 'darwin' ? ['-L', path] : [path]
  let links = ''
  try {
    links = execFileSync(tool, args, { encoding: 'utf8', timeout: 30_000 })
  } catch {
    // Statically linked binaries make `ldd` exit non-zero saying so, which is
    // exactly the result we want.
    return []
  }
  return NOT_PORTABLE.filter((prefix) => links.includes(prefix))
}

mkdirSync(OUT, { recursive: true })

let total = 0
const problems = []

for (const name of ['ffmpeg', 'ffprobe']) {
  let source
  try {
    source = locate(name)
  } catch (err) {
    console.error(`stage-ffmpeg: ${err instanceof Error ? err.message : String(err)}`)
    console.error(fromDir ? `Looked in ${fromDir}.` : 'Install ffmpeg, or pass --from <dir>.')
    process.exit(1)
  }
  const target = join(OUT, EXE(name))
  copyFileSync(source, target)
  // copyFileSync creates the destination with default permissions, so on macOS
  // and Linux the copy comes out non-executable and the packaged app cannot run
  // it. The failure looks like ffmpeg being missing, which it is not.
  if (!WINDOWS) chmodSync(target, 0o755)

  const borrowed = verify(target)
  if (borrowed.length > 0) problems.push(`${name} links against ${borrowed.join(', ')}`)

  const size = statSync(target).size
  total += size
  console.log(`${name.padEnd(8)} ${(size / 1024 / 1024).toFixed(1).padStart(6)} MB  runs  <- ${basename(source)}`)
}

if (problems.length > 0) {
  console.error('\nThese binaries will not run on a machine that is not this one:')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error('\nStage a static build instead, with --from <dir>.')
  process.exit(1)
}

console.log(`\nStaged ${(total / 1024 / 1024).toFixed(1)} MB into ${OUT}.`)
