/**
 * The gateway is an HTTP server on the user's machine that can read files.
 *
 * That is a dangerous thing to have running, and these checks are the reason it
 * is safe: without the launch token nothing is served, and an id that was never
 * opened cannot be named. If any of these ever start failing, the app has
 * become a way to read someone's disk from a web page.
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { request } from 'node:http'
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
        res.resume()
        done(res.statusCode)
      },
    )
    req.on('error', (err) => done(`threw: ${err.message}`))
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
check('a request from outside the window reaches the file', rawReal === 206 || rawReal === 200, String(rawReal))

/*
 * Paths that climb out of the opened file, each carrying the valid token and the
 * right host, so the only thing that can refuse them is the routing.
 *
 * 403 is deliberately not accepted. With a good token and a good host, a 403
 * would mean one of those guards had fired for some other reason, and a check
 * that counts that as success is back to passing on the wrong grounds.
 */
const fileBase = parsed.pathname.replace(/\/file$/, '')
for (const [label, path] of [
  ['dot segments', `${fileBase}/../../../../package.json${parsed.search}`],
  ['percent-encoded dots', `${fileBase}/%2e%2e/%2e%2e/%2e%2e/package.json${parsed.search}`],
  ['percent-encoded separators', `${fileBase}/..%2F..%2F..%2Fpackage.json${parsed.search}`],
]) {
  const got = await raw(path)
  check(`a path that climbs out of the opened file is refused (${label})`, got === 400 || got === 404, String(got))
}

/*
 * A page that resolves its own hostname to 127.0.0.1 reaches this port with its
 * own Host header. Same path and token as the request above that was served, so
 * a refusal here is the host guard and nothing else.
 */
const otherHost = await raw(realPath, { host: 'evil.example.com' })
check('a request naming another host is refused', otherHost === 403, String(otherHost))
const rebinding = await raw(realPath, { host: `attacker.test:${parsed.port}` })
check('a rebinding host on the right port is refused', rebinding === 403, String(rebinding))

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
