/**
 * Adding to the queue, and dropping after a file failed to open.
 *
 * Two things that used to go wrong:
 *  - the queue's Add button replaced the queue and restarted playback;
 *  - after a broken file failed with nothing playing, the next drop was
 *    appended silently and the empty screen stayed up.
 *
 * Files arrive as the operating system delivers them. The native file dialog
 * cannot be driven, so the main process's dialog is answered with a fixed list.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deliver, FIXTURES, launchApp } from './launch.mjs'

const failures = []

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

const ready = (page) =>
  page.waitForFunction(
    () => {
      const v = document.querySelector('video.xp-video')
      return v && v.readyState >= 2
    },
    null,
    { timeout: 15_000 },
  )

/** A suite that throws still ends with a summary, like its siblings. */
function crashed(scenario, err) {
  check(`${scenario} ran to the end`, false, String(err?.message ?? err).slice(0, 160))
}

const rowCount = (page) => page.locator('.queue-list li').count()

/** Makes the next file dialog answer with these paths. */
const answerDialog = (app, paths) =>
  app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files })
  }, paths)

const first = join(FIXTURES, 'vp9-opus.webm')
const second = join(FIXTURES, 'h264-aac.mkv')
const third = join(FIXTURES, 'xvid-mp3.avi')

/* ------------------------------------------------------ Add keeps the queue */

{
  const { app, page } = await launchApp({ isolated: true })
  try {
    await deliver(app, first)
    await ready(page)
    await deliver(app, second)
    await page.locator('.status-actions button', { hasText: 'Queue' }).click()
    await page.waitForFunction(() => document.querySelectorAll('.queue-list li').length === 2, null, {
      timeout: 10_000,
    })
    const srcBefore = await page.evaluate(() => document.querySelector('video.xp-video').currentSrc)
    check('setup: the video is playing the first file', srcBefore.length > 0)

    await answerDialog(app, [third])
    await page.locator('.queue-head button', { hasText: 'Add' }).click()
    // Positive: wait for the row instead of guessing how long the append takes.
    // A timeout is not an error here, the check below reports the row count.
    await page
      .waitForFunction(() => document.querySelectorAll('.queue-list li').length >= 3, null, { timeout: 10_000 })
      .catch(() => {})
    // Negative: "did not interrupt the film" has no event to wait for, so this
    // wait is bounded on purpose. It gives a wrongful restart time to show up
    // in currentSrc before it is read.
    await page.waitForTimeout(1000)

    check('Add appends to the queue instead of replacing it', (await rowCount(page)) === 3, `${await rowCount(page)} rows`)
    const names = await page.locator('.queue-list .queue-name').allInnerTexts()
    check('and keeps the order, new file last', names[0] === 'vp9-opus.webm' && names[2] === 'xvid-mp3.avi', String(names))
    const srcAfter = await page.evaluate(() => document.querySelector('video.xp-video')?.currentSrc)
    check('and does not interrupt what is playing', srcAfter === srcBefore)
    check(
      'and the first row is still the one marked as playing',
      (await page.locator('.queue-list li').first().getAttribute('aria-current')) === 'true',
    )
  } catch (err) {
    crashed('Add keeps the queue', err)
  } finally {
    await app.close()
  }
}

/* ------------------------------------------- a drop after a failed open plays */

{
  const { app, page } = await launchApp({ isolated: true })
  const scratch = mkdtempSync(join(tmpdir(), 'xplayer-broken-'))
  try {
    // A video by name and nothing else: it is queued, and then fails to open.
    const broken = join(scratch, 'broken.mp4')
    writeFileSync(broken, 'this is not a video')
    await deliver(app, broken)
    await page.waitForSelector('text=could not be opened', { timeout: 10_000 })
    check('setup: the broken file failed with nothing playing', (await page.locator('video.xp-video').count()) === 0)

    await deliver(app, first)
    let played = true
    try {
      await ready(page)
    } catch {
      played = false
    }
    check('the next drop starts playing', played)
  } catch (err) {
    crashed('a drop after a failed open', err)
  } finally {
    await app.close()
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

console.log(`\n${'='.repeat(64)}`)
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('add: all checks passed')
