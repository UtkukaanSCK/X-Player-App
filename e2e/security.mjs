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

const traversal = new URL(url)
traversal.pathname = '/m/../../../../Windows/win.ini'
const traversalStatus = await status(traversal.toString())
check('a path outside the opened set is refused', traversalStatus === 404 || traversalStatus === 403, String(traversalStatus))

const badSegment = new URL(url)
badSegment.pathname = badSegment.pathname.replace(/\/file$/, '/seg/..%2F..%2Fsecret.ts')
const badSegmentStatus = await status(badSegment.toString())
check('a segment name that is not a number is refused', badSegmentStatus === 400 || badSegmentStatus === 404, String(badSegmentStatus))

const webPreferences = await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  return {
    nodeIntegration: w.webContents.getLastWebPreferences()?.nodeIntegration ?? false,
    contextIsolation: w.webContents.getLastWebPreferences()?.contextIsolation ?? true,
    sandbox: w.webContents.getLastWebPreferences()?.sandbox ?? true,
  }
})
check('node integration is off in the window', webPreferences.nodeIntegration === false)
check('context isolation is on', webPreferences.contextIsolation === true)
check('the window is sandboxed', webPreferences.sandbox === true)

await app.close()

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('\nsecurity: all checks passed')
