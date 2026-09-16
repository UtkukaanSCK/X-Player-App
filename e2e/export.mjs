/**
 * Exporting the open file to another format, driven the way a person does it:
 * the Export button in the top-left of the strip, a format from its menu, and
 * the file that appears next to the original.
 *
 * Every file here is a copy in a temporary folder. The fixtures folder is left
 * alone - the security suite plants canaries beside it - and an export writes
 * next to the file it came from, so the copies are what it writes next to.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deliver, FIXTURES, launchApp } from './launch.mjs'

const failures = []

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

const work = mkdtempSync(join(tmpdir(), 'xplayer-export-'))
for (const name of ['h264-aac.mkv', 'hd720.mkv']) copyFileSync(join(FIXTURES, name), join(work, name))
// Three seconds, so a re-encode to VP9 finishes inside the suite's patience.
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(work, 'h264-aac.mkv'), '-t', '3', '-c', 'copy', join(work, 'short.mkv')])

/** Codec of each stream and the duration, as ffprobe reads the file. */
function probe(path) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', path])
  const json = JSON.parse(out.toString())
  return { codecs: json.streams.map((s) => s.codec_name), duration: Number(json.format.duration) }
}

async function openFile(app, page, path) {
  await deliver(app, path)
  await page.waitForFunction(
    (name) => document.querySelector('.status-name')?.textContent === name && document.querySelector('video.xp-video')?.readyState >= 2,
    path.split(/[\\/]/).pop(),
    { timeout: 40_000 },
  )
}

const exportButton = (page) => page.locator('.status-id').getByRole('button', { name: /^Export/ })
const exportMenu = (page) => page.getByRole('menu', { name: 'Export' })

async function exportTo(page, label) {
  await exportButton(page).click()
  await exportMenu(page).getByRole('menuitem', { name: new RegExp(`^${label}`) }).click()
}

/** Waits for the export to end and returns what the banner says about it. */
async function finished(page, timeout = 60_000) {
  await page.waitForFunction(() => /^Export\b(?!ing)/.test(document.querySelector('.status-id button')?.textContent ?? ''), undefined, { timeout }).catch(() => {})
  await page.waitForFunction(() => !!document.querySelector('.banner'), undefined, { timeout: 5_000 }).catch(() => {})
  return (await page.locator('.banner').textContent().catch(() => '')) ?? ''
}

const { app, page } = await launchApp()
const pageErrors = []
page.on('pageerror', (err) => pageErrors.push(err.message))

try {
  /* ------------------------------------------------------------ the control */

  await openFile(app, page, join(work, 'h264-aac.mkv'))
  check('an Export button sits in the top-left of the strip', await exportButton(page).isVisible())

  await exportButton(page).click()
  check('clicking it opens the Export menu', await exportMenu(page).isVisible())

  const mkvItem = exportMenu(page).getByRole('menuitem', { name: /^MKV/ })
  check("the file's own format cannot be chosen", (await mkvItem.getAttribute('aria-disabled')) === 'true')

  // The window sends arrow keys to the player; inside the menu they must not seek.
  const before = await page.evaluate(() => document.querySelector('video.xp-video').currentTime)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  const after = await page.evaluate(() => document.querySelector('video.xp-video').currentTime)
  const focusInMenu = await page.evaluate(() => document.activeElement?.getAttribute('role') === 'menuitem')
  check('arrow keys move through the menu instead of seeking', focusInMenu && Math.abs(after - before) < 1, `${before.toFixed(1)} -> ${after.toFixed(1)}`)

  await page.keyboard.press('Escape')
  const escaped = await page.evaluate(() => /^Export/.test(document.activeElement?.textContent ?? ''))
  check('Escape closes the menu and hands focus back to the button', !(await exportMenu(page).isVisible()) && escaped)

  await page.keyboard.press('Enter')
  const opensByKey = await exportMenu(page).isVisible()
  check('the keyboard opens it too, with focus on the first format', opensByKey && (await page.evaluate(() => document.activeElement?.getAttribute('role') === 'menuitem')))
  await page.keyboard.press('Escape')

  // Tab leaves for the next control in the strip, rather than wherever the
  // browser puts focus after the item holding it is removed.
  await exportButton(page).click()
  await page.keyboard.press('Tab')
  const afterTab = await page.evaluate(() => document.activeElement?.textContent ?? '')
  check('Tab leaves the menu for the next control', !(await exportMenu(page).isVisible()) && afterTab === 'Open', afterTab)

  // ArrowUp on a menu button opens it at the last item. Without that it is one
  // of the keys the window sends to the player, which would raise the volume.
  const volumeBefore = await page.evaluate(() => document.querySelector('video.xp-video').volume)
  await exportButton(page).focus()
  await page.keyboard.press('ArrowUp')
  const onLast = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
    return items.length > 0 && items.at(-1) === document.activeElement
  })
  const volumeAfter = await page.evaluate(() => document.querySelector('video.xp-video').volume)
  check('ArrowUp opens the menu at its last format, and leaves the volume alone', onLast && volumeAfter === volumeBefore, `volume ${volumeBefore} -> ${volumeAfter}`)
  await page.keyboard.press('Escape')

  /* ------------------------------------------------------------- copying */

  await exportTo(page, 'MP4')
  const banner = await finished(page)
  const mp4 = join(work, 'h264-aac.mp4')
  check('an MP4 export lands next to the original', existsSync(mp4), banner)
  if (existsSync(mp4)) {
    const source = probe(join(work, 'h264-aac.mkv'))
    const result = probe(mp4)
    check('it holds the same H.264 and AAC, at the same length', result.codecs.join() === 'h264,aac' && Math.abs(result.duration - source.duration) < 0.5, `${result.codecs} ${result.duration}s`)
  }
  check('the banner says where it went and offers to show it', /Saved/.test(banner) && (await page.locator('.banner').getByRole('button', { name: 'Show in folder' }).isVisible()))
  check('nothing partial is left beside it', !readdirSync(work).some((f) => f.endsWith('.part')))

  await exportTo(page, 'MP4')
  await finished(page)
  check('exporting again numbers the copy instead of overwriting', existsSync(join(work, 'h264-aac (1).mp4')))

  /* ---------------------------------------------------------- re-encoding */

  await openFile(app, page, join(work, 'short.mkv'))
  await exportTo(page, 'WebM')
  await finished(page, 120_000)
  const webm = join(work, 'short.webm')
  check('a WebM export re-encodes into VP9 and Opus', existsSync(webm) && probe(webm).codecs.join() === 'vp9,opus', existsSync(webm) ? String(probe(webm).codecs) : 'no file')

  /* ----------------------------------------------------------- cancelling */

  await openFile(app, page, join(work, 'hd720.mkv'))
  await exportTo(page, 'WebM')
  const started = await page
    .waitForFunction(() => /Exporting/.test(document.querySelector('.status-id button')?.textContent ?? ''), undefined, { timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  // The partial file is the thing the cancel has to clean up. Without waiting
  // for it, "nothing was left behind" would pass on an export that never began.
  let partial = false
  for (let wait = 0; wait < 100 && !partial; wait++) {
    partial = readdirSync(work).some((f) => f.startsWith('hd720') && f.endsWith('.part'))
    if (!partial) await page.waitForTimeout(100)
  }
  check('the export about to be cancelled really started', started && partial, readdirSync(work).join(', '))

  await exportButton(page).click()
  await exportMenu(page).getByRole('menuitem', { name: 'Cancel export' }).click()
  await finished(page, 20_000)
  check('cancelling leaves neither the export nor a partial file', !existsSync(join(work, 'hd720.webm')) && !readdirSync(work).some((f) => f.startsWith('hd720') && f !== 'hd720.mkv'), readdirSync(work).join(', '))

  /* ------------------------------------------------------------ the bridge */

  const refused = await page.evaluate(async (path) => {
    const opened = await window.desktop.open(path)
    const id = opened.ok ? opened.media.id : ''
    const answers = await Promise.all([
      window.desktop.startExport('no-such-file', 'mp4', 0),
      window.desktop.startExport(id, 'exe', 0),
      window.desktop.startExport(id, 'mp4', 99),
    ])
    return answers.map((a) => a.ok)
  }, join(work, 'short.mkv'))
  check('the bridge refuses an unknown file, a format off the list and a track that is not there', refused.every((ok) => ok === false), JSON.stringify(refused))

  // Two asked for in the same breath. Both used to pass the "one at a time"
  // check while the first was still deciding, and then write the same file.
  const together = await page.evaluate(async (path) => {
    const opened = await window.desktop.open(path)
    const id = opened.ok ? opened.media.id : ''
    const answers = await Promise.all([
      window.desktop.startExport(id, 'webm', 0),
      window.desktop.startExport(id, 'webm', 0),
    ])
    for (const answer of answers) if (answer.ok) await window.desktop.cancelExport(answer.jobId)
    return answers.map((answer) => (answer.ok ? 'started' : answer.message))
  }, join(work, 'short.mkv'))
  check(
    'two exports asked for at once start only one',
    together.filter((answer) => answer === 'started').length === 1,
    together.join(' | '),
  )
  await finished(page, 20_000)

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await app.close()
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nexport: all checks passed')
