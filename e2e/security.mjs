/**
 * The gateway is an HTTP server on the user's machine that can read files.
 *
 * That is a dangerous thing to have running, and these checks are the reason it
 * is safe: without the launch token nothing is served, and an id that was never
 * opened cannot be named. If any of these ever start failing, the app has
 * become a way to read someone's disk from a web page.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, parse, sep } from 'node:path'
import { deliver, FIXTURES, launchApp } from './launch.mjs'
/** The direct route keeps a plain HTTP URL on the element, which is what we probe. */
const FIXTURE = 'vp9-opus.webm'

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

if (!existsSync(join(FIXTURES, FIXTURE))) {
  console.error(`Fixture missing: ${FIXTURE}\nRun: npm run fixtures`)
  process.exit(1)
}

const { app, page } = await launchApp()
await deliver(app, join(FIXTURES, FIXTURE))

await page.waitForFunction(() => {
  const v = document.querySelector('video.xp-video')
  return v && v.readyState >= 2 && v.currentSrc.startsWith('http://127.0.0.1')
}, undefined, { timeout: 40_000 })

const url = await page.evaluate(() => document.querySelector('video.xp-video').currentSrc)
check('the direct route serves over 127.0.0.1', url.startsWith('http://127.0.0.1:'), url.split('?')[0])

/** Runs a request from inside the window and reports only the status. */
const status = (target) =>
  page.evaluate(async (t) => {
    try {
      const res = await fetch(t, { method: 'GET', headers: { range: 'bytes=0-64' } })
      return res.status
    } catch (err) {
      return `threw: ${String(err)}`
    }
  }, target)

const parsed = new URL(url)
const token = parsed.searchParams.get('t')

check('the real URL is served', (await status(url)) === 206 || (await status(url)) === 200)

const noToken = new URL(url)
noToken.searchParams.delete('t')
check('no token is refused', (await status(noToken.toString())) === 403)

const badToken = new URL(url)
badToken.searchParams.set('t', 'f'.repeat(64))
check('a wrong token is refused', (await status(badToken.toString())) === 403)

check('the token is long enough to be unguessable', (token?.length ?? 0) >= 64, `${token?.length} chars`)

const unknownFile = new URL(url)
unknownFile.pathname = '/m/00000000-0000-4000-8000-000000000000/file'
check('an id that was never opened is not found', (await status(unknownFile.toString())) === 404)

const badSegment = new URL(url)
badSegment.pathname = badSegment.pathname.replace(/\/file$/, '/seg/..%2F..%2Fsecret.ts')
const badSegmentStatus = await status(badSegment.toString())
check('a segment name that is not a number is refused', badSegmentStatus === 400 || badSegmentStatus === 404, String(badSegmentStatus))

/*
 * The checks below send their requests from this process rather than from the
 * window, with the path and headers exactly as written.
 *
 * Two of them were quietly impossible from `status` above. A fetch from the page
 * goes through the URL API, which resolves `..` before the request leaves: the
 * traversal check used to write /m/../../../../Windows/win.ini, the browser sent
 * /Windows/win.ini, and the gateway refused it as an unknown scope. The check
 * passed without ever presenting a traversal - and passed, when tried, against a
 * server built to hand the file out. And Host is a forbidden header in fetch, so
 * the guard against DNS rebinding could not be exercised from the window at all.
 */
const raw = (path, headers = {}) =>
  new Promise((done) => {
    const req = request(
      { host: '127.0.0.1', port: parsed.port, path, method: 'GET', headers: { range: 'bytes=0-64', ...headers } },
      (res) => {
        // Enough of the body to tell a leaked canary from any other 200; the
        // range header keeps a served file to 65 bytes in any case.
        let body = ''
        res.on('data', (chunk) => {
          if (body.length < 256) body += chunk.toString()
        })
        res.on('end', () => done({ status: res.statusCode, body }))
      },
    )
    req.on('error', (err) => done({ status: `threw: ${err.message}`, body: '' }))
    req.end()
  })

/*
 * First, that this requester reaches the file at all. Every refusal below is
 * only evidence if the same request, unaltered, would have been served - a
 * requester that was being turned away for its host or its token would make
 * every one of them pass while testing nothing.
 */
const realPath = `${parsed.pathname}${parsed.search}`
const rawReal = await raw(realPath)
check('a request from outside the window reaches the file', rawReal.status === 206 || rawReal.status === 200, String(rawReal.status))

/*
 * Traversal, tested against canaries this process plants rather than a file
 * that happens to be on disk.
 *
 * The earlier version aimed fixed-depth climbs at package.json. Whether that
 * caught a leaking gateway depended entirely on where the gateway rooted its
 * join and what sat above it: on this machine a stray package.json in the home
 * directory made it pass, and on a fresh runner nothing did, so the check was
 * green while testing nothing - the same accident as the "never been run"
 * comment, one layer down. A canary removes the accident. The test writes a
 * file, aims the request exactly at it, and only a gateway that served THAT
 * file - proven by reading its own token back - counts as a leak.
 *
 * Two canaries, one beside the fixture and one in the temp directory, because a
 * hosted runner can put the workspace and the temp dir on different drives and
 * the gateway joins onto one of them. The climb is `..` thirty-two times: the
 * extra steps stop at the drive root, so the request reaches the canary from
 * wherever on that drive the gateway starts. Both %2F and %5C, because the app
 * ships on Windows and a backslash walks straight past a filter written for
 * forward slashes.
 *
 * Each canary is a precondition, not an assumption. If planting failed, or the
 * file is not exactly where the request climbs to, every request 404s for a
 * missing file and the checks pass having proven nothing - the hole the setup
 * check above closes for the requester, closed here for the target. So before
 * any traversal request the canary must exist and read its own token back. And
 * 400/404 alone is not enough: a 200 is inspected for the token, so a leak that
 * happens to carry an ordinary success code is still caught.
 */
const fileBase = parsed.pathname.replace(/\/file$/, '')
const canaryToken = randomBytes(16).toString('hex')
const driveless = (p) => p.slice(parse(p).root.length).split(sep).join('/')
const canaryTemp = mkdtempSync(join(tmpdir(), 'xp-canary-'))
const canaries = [
  { where: 'beside the fixture', path: join(FIXTURES, `xp-canary-${canaryToken}.txt`) },
  { where: 'in the temp directory', path: join(canaryTemp, `xp-canary-${canaryToken}.txt`) },
]
try {
  for (const canary of canaries) {
    writeFileSync(canary.path, canaryToken)
    const planted = existsSync(canary.path) && readFileSync(canary.path, 'utf8') === canaryToken
    check(`the canary ${canary.where} is planted before its traversal is tried`, planted, canary.path)
    if (!planted) continue

    const abs = driveless(canary.path)
    for (const [label, climb, target] of [
      ['percent-encoded separators', '..%2F'.repeat(32), abs],
      ['percent-encoded backslashes', '..%5C'.repeat(32), abs.split('/').join('%5C')],
    ]) {
      const got = await raw(`${fileBase}/${climb}${target}${parsed.search}`)
      const leaked = got.status === 200 && got.body.includes(canaryToken)
      check(
        `a climb to the canary ${canary.where} is refused (${label})`,
        !leaked && (got.status === 400 || got.status === 404),
        leaked ? `leaked ${got.body.slice(0, 40)}` : String(got.status),
      )
    }
  }
} finally {
  for (const canary of canaries) rmSync(canary.path, { force: true })
  rmSync(canaryTemp, { recursive: true, force: true })
}

/*
 * A page that resolves its own hostname to 127.0.0.1 reaches this port with its
 * own Host header. Same path and token as the request above that was served, so
 * a refusal here is the host guard and nothing else.
 */
const otherHost = await raw(realPath, { host: 'evil.example.com' })
check('a request naming another host is refused', otherHost.status === 403, String(otherHost.status))
const rebinding = await raw(realPath, { host: `attacker.test:${parsed.port}` })
check('a rebinding host on the right port is refused', rebinding.status === 403, String(rebinding.status))

/*
 * No defaults on these. They used to read `?.nodeIntegration ?? false` and
 * `?? true`, every default being the passing value, so if the preferences were
 * ever missing all three would report a locked-down window. They are present
 * today - measured, fifteen keys - which is exactly why the fallback was never
 * noticed doing nothing.
 */
const webPreferences = await app.evaluate(({ BrowserWindow }) => {
  const prefs = BrowserWindow.getAllWindows()[0]?.webContents.getLastWebPreferences()
  if (!prefs) return null
  return { nodeIntegration: prefs.nodeIntegration, contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox }
})
check('the window reports its web preferences at all', webPreferences !== null)
check('node integration is off in the window', webPreferences?.nodeIntegration === false)
check('context isolation is on', webPreferences?.contextIsolation === true)
check('the window is sandboxed', webPreferences?.sandbox === true)

await app.close()

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('\nsecurity: all checks passed')
