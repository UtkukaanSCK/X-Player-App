import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Everything that has to be true before cutting a release.
 *
 * Each of these has a failure mode that only shows up after the installer is in
 * someone's hands: an icon that never got generated, an ffmpeg that cannot run,
 * a version on the download page that does not match the one being built.
 */
const WINDOWS = process.platform === 'win32'
const EXE = (name) => (WINDOWS ? `${name}.exe` : name)

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

/* --------------------------------------------------------------- what ships */

check('the app has a licence', existsSync('LICENSE'))
const hasIcon = existsSync(join('build', 'icon.png'))
check('the icon has been generated', hasIcon, hasIcon ? '' : 'run: npm run icon')

const staged = ['ffmpeg', 'ffprobe'].map((name) => join('resources', 'ffmpeg', EXE(name)))
const allStaged = staged.every(existsSync)
check('ffmpeg is staged', allStaged, allStaged ? '' : 'run: npm run ffmpeg')

if (allStaged) {
  let runs = true
  try {
    execFileSync(staged[0], ['-hide_banner', '-version'], { stdio: 'ignore', timeout: 30_000 })
  } catch {
    runs = false
  }
  check('the staged ffmpeg runs', runs, runs ? `${(statSync(staged[0]).size / 1024 / 1024).toFixed(0)} MB` : '')
}

/* ------------------------------------------------------------ configuration */

const builder = readFileSync('electron-builder.yml', 'utf8')
check('a publish target is configured', /provider:\s*github/.test(builder))
check('all three platforms have targets', ['win:', 'mac:', 'linux:'].every((key) => builder.includes(key)))
check('file associations are declared', /fileAssociations:/.test(builder))

/* ------------------------------------------------- the version people will see */

const sitePath = join('..', 'web', 'lib', 'releases.ts')
if (existsSync(sitePath)) {
  const site = readFileSync(sitePath, 'utf8')
  const advertised = /APP_VERSION = '([^']+)'/.exec(site)?.[1]
  check(
    'the site advertises the version being built',
    advertised === pkg.version,
    `site says ${advertised}, app is ${pkg.version}`,
  )

  const published = /export const published = (true|false)/.exec(site)?.[1]
  console.log(
    published === 'true'
      ? '      the site is offering downloads; make sure the release exists'
      : '      the site is not offering downloads yet; set published: true once the release is up',
  )
} else {
  console.log('      the site is not beside this folder, so its version was not checked')
}

/* ------------------------------------------------------------------ the code */

for (const [name, script] of [
  ['types check out', 'typecheck'],
  ['the linter is clean', 'lint'],
  ['the unit tests pass', 'test'],
]) {
  let ok = true
  try {
    // A fixed command string through the shell. execFile cannot run npm.cmd on
    // Windows at all - it fails with EINVAL, which looks exactly like the script
    // itself failing - and passing arguments alongside shell: true earns a
    // deprecation warning that this has no need to provoke.
    execSync(`npm run ${script}`, { stdio: 'ignore', timeout: 300_000 })
  } catch {
    ok = false
  }
  check(name, ok, ok ? '' : `run: npm run ${script}`)
}

/* -------------------------------------------------------- the gateway's guard */

/*
 * The security suite is the only thing standing between this app and "a way to
 * read someone's disk from a web page", in its own words, and until now it ran
 * in no gate at all - not here, not in the release workflow. Everything above
 * could pass while the gateway served files it should refuse.
 *
 * Only the security suite, not the whole e2e. It has no timing thresholds, so it
 * passes or fails on what the gateway does rather than on how fast this machine
 * is. The playback suite does have them - first frame, seek and stall budgets -
 * and it failed a local run for a reason not yet diagnosed; gating a release on
 * it before that is understood would block releases on a clock.
 *
 * It launches the built app, so it builds first. That also means the app being
 * checked is the one compiled from the source in front of you, not whatever an
 * earlier build happened to leave in out/.
 */
const SECURITY_FIXTURE = join('fixtures', 'vp9-opus.webm')
const hasSecurityFixture = existsSync(SECURITY_FIXTURE)
check('the security fixture exists', hasSecurityFixture, hasSecurityFixture ? '' : 'run: npm run fixtures')

if (hasSecurityFixture) {
  let ok = true
  try {
    execSync('npm run build', { stdio: 'ignore', timeout: 300_000 })
    execSync('node e2e/security.mjs', { stdio: 'ignore', timeout: 300_000 })
  } catch {
    ok = false
  }
  check("the gateway's security checks pass", ok, ok ? '' : 'run: npm run build && node e2e/security.mjs')
}

console.log()
if (failures.length > 0) {
  console.error(`Not ready: ${failures.length} check(s) failed.`)
  process.exit(1)
}
console.log('Ready to build. Run `npm run dist` on each platform you intend to ship,')
console.log('or push a v* tag and let .github/workflows/release.yml do all three.')
