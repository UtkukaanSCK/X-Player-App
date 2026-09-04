/**
 * The queue, and the reordering added to it.
 *
 * Reordering is the one part of this app where the visible order and the thing
 * being played can disagree, so the assertions below check both together: the
 * order of the rows, and that the row marked as playing is still the file the
 * player actually has open.
 *
 * Files arrive the way the operating system delivers them, and the rows are
 * moved the way a person moves them - a real drag, and the keyboard equivalent.
 * There are no test-only hooks in the app.
 */
import { join } from 'node:path'
import { deliver, FIXTURES, launchApp } from './launch.mjs'

/** Small and fast to open: this suite is about the list, not about decoding. */
const FILES = ['vp9-opus.webm', 'h264-aac.mkv', 'xvid-mp3.avi']

const failures = []

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

/** The file names in the order the queue shows them. */
async function order(page) {
  return page.locator('.queue-list .queue-name').allInnerTexts()
}

/** The row the app says is playing. */
async function playingRow(page) {
  const rows = await page.locator('.queue-list li').all()
  for (let i = 0; i < rows.length; i += 1) {
    if ((await rows[i].getAttribute('aria-current')) === 'true') return i
  }
  return -1
}

const { app, page } = await launchApp()
const pageErrors = []
page.on('pageerror', (err) => pageErrors.push(String(err.message)))

try {
  /* ------------------------------------------------------------- filling it */

  for (const file of FILES) {
    await deliver(app, join(FIXTURES, file))
    // The first file has to actually open before the second can append to it.
    if (file === FILES[0]) {
      await page.waitForFunction(
        () => {
          const v = document.querySelector('video.xp-video')
          return v && v.readyState >= 2
        },
        null,
        { timeout: 15_000 },
      )
    } else {
      await page.waitForTimeout(300)
    }
  }

  await page.locator('.status-actions button', { hasText: 'Queue' }).click()
  await page.waitForSelector('.queue-list')
  await page.waitForFunction(() => document.querySelectorAll('.queue-list li').length === 3, null, {
    timeout: 10_000,
  })

  check('three files queue up in the order they arrived', String(await order(page)) === String(FILES), String(await order(page)))
  check('the first file is the one playing', (await playingRow(page)) === 0)

  /* ------------------------------------------------- the same file, again */

  await deliver(app, join(FIXTURES, FILES[0]))
  await page.waitForTimeout(400)
  check('re-dropping a queued file adds no second row', (await page.locator('.queue-list li').count()) === 3)
  const said = await page.locator('.banner').innerText().catch(() => '')
  check('and says so rather than swallowing the drop', /already in the queue/i.test(said), `saw "${said}"`)

  /* ----------------------------------------------------- keyboard reorder */

  await page.locator('.queue-list .queue-row').first().focus()
  await page.keyboard.press('Alt+ArrowDown')
  await page.waitForTimeout(200)

  const afterKey = await order(page)
  check(
    'Alt+ArrowDown moves the first row down one',
    String(afterKey) === String([FILES[1], FILES[0], FILES[2]]),
    String(afterKey),
  )
  check('the playing file keeps its mark after a keyboard move', (await playingRow(page)) === 1)
  check(
    'and the moved row keeps the focus',
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.queue-list .queue-row')]
      return rows.indexOf(document.activeElement) === 1
    }),
  )

  /* --------------------------------------------------------- drag reorder */

  // The last row onto the top half of the first, which is the gap above it.
  const rows = page.locator('.queue-list li')
  await rows.nth(2).dragTo(rows.nth(0), { targetPosition: { x: 40, y: 3 } })
  await page.waitForTimeout(300)

  const afterDrag = await order(page)
  check(
    'dragging the last row to the top reorders the queue',
    String(afterDrag) === String([FILES[2], FILES[1], FILES[0]]),
    String(afterDrag),
  )
  check('the playing file still holds its mark after a drag', (await playingRow(page)) === 2)

  /* -------------------------------------- a bad file keeps the picture */

  /*
   * Opening something unplayable used to clear the stage, so one corrupt row in
   * a long queue cost you the film that was playing perfectly well. The subtitle
   * fixture is a real file with no video stream, which is exactly that case.
   */
  await deliver(app, join(FIXTURES, 'embedded.srt'))
  await page.waitForTimeout(800)
  check(
    'a file that cannot be opened leaves the video alone',
    await page.evaluate(() => {
      const v = document.querySelector('video.xp-video')
      return Boolean(v) && !v.error
    }),
  )
  const complaint = await page.locator('.banner').innerText().catch(() => '')
  check('and says what went wrong', complaint.length > 0, complaint.replace(/s+/g, ' ').slice(0, 60))

  /* ------------------------------------------------ keys from anywhere */

  /*
   * The playback keys are bound to the player element by the library, on purpose.
   * In this window that left Space toggling whichever button was last clicked, so
   * the app forwards them. Pressing Space with the Queue button focused has to
   * reach playback and must not also toggle the panel it is focused on.
   */
  const queueButton = page.locator('.status-actions button', { hasText: 'Queue' })
  await queueButton.focus()
  const pausedBefore = await page.evaluate(() => document.querySelector('video.xp-video').paused)
  const panelBefore = await page.locator('.queue-list').count()
  await page.keyboard.press('Space')
  await page.waitForTimeout(400)
  const pausedAfter = await page.evaluate(() => document.querySelector('video.xp-video').paused)
  check('Space reaches playback even when a toolbar button has focus', pausedAfter !== pausedBefore, `${pausedBefore} -> ${pausedAfter}`)
  check('and does not also press the button it was focused on', (await page.locator('.queue-list').count()) === panelBefore)
  await page.keyboard.press('Space')
  await page.waitForTimeout(400)

  /* ------------------------------------------- volume outlives the file */

  /*
   * Volume belongs to the viewer, not to the file. The player is remounted for
   * every file and only remembers position, so without the app carrying this
   * across, every episode started at full volume however quietly the last one
   * was playing.
   */
  await page.evaluate(() => {
    const v = document.querySelector('video.xp-video')
    v.volume = 0.35
    v.dispatchEvent(new Event('volumechange'))
  })
  await page.waitForTimeout(700)

  const playingNow = await playingRow(page)
  const other = playingNow === 0 ? 1 : 0
  await page.locator('.queue-list .queue-row').nth(other).click()
  await page.waitForFunction(
    () => {
      const v = document.querySelector('video.xp-video')
      return v && v.readyState >= 2
    },
    null,
    { timeout: 15_000 },
  )
  const carried = await page.evaluate(() => document.querySelector('video.xp-video').volume)
  check('volume carries over to the next file', Math.abs(carried - 0.35) < 0.02, String(carried.toFixed(2)))

  /* --------------------------------------------------------- the drop prompt */

  /*
   * The prompt is driven by real drag events rather than by a test hook. The
   * files carried are synthetic, so nothing is ever opened by this - what is
   * being checked is what the window says while something is over it, and that
   * it stops saying it afterwards.
   */
  const dragOver = (count) =>
    page.evaluate((n) => {
      const dt = new DataTransfer()
      for (let i = 0; i < n; i += 1) dt.items.add(new File([''], `clip${i}.mkv`, { type: 'video/x-matroska' }))
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }))
    }, count)

  await dragOver(2)
  await page.waitForSelector('.veil-card')
  const prompt = (await page.locator('.veil-card').innerText()).trim()
  check(
    'the prompt says what a drop would actually do',
    prompt === 'Add 2 files to the queue',
    `saw "${prompt}"`,
  )

  // Leaving the window reports no element being entered, which is the case the
  // depth counter alone gets wrong.
  await page.evaluate(() => {
    window.dispatchEvent(new DragEvent('dragleave', { relatedTarget: null, bubbles: true }))
  })
  await page.waitForTimeout(150)
  check('and clears when the drag leaves the window', (await page.locator('.veil-card').count()) === 0)

  await dragOver(1)
  await page.waitForSelector('.veil-card')
  await page.evaluate(() => window.dispatchEvent(new DragEvent('dragend', { bubbles: true })))
  await page.waitForTimeout(150)
  check('and clears when the drag is abandoned', (await page.locator('.veil-card').count()) === 0)

  /* -------------------------------------------------- the picture survives */

  const stillPlaying = await page.evaluate(() => {
    const v = document.querySelector('video.xp-video')
    return Boolean(v) && !v.error
  })
  check('reordering never disturbed the video', stillPlaying)

  check('no uncaught errors in the window', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await app.close()
}

console.log(`\n${'='.repeat(64)}`)
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('queue: all checks passed')
