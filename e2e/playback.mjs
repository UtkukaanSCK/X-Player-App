/**
 * The claim this app makes is "any file, playing in a second, without a stall".
 * This suite is that claim written as assertions.
 *
 * It drives the app the way a person does - files arrive the way a double-click
 * in Explorer delivers them, and the audio track is changed by clicking through
 * the menu. There are no test-only hooks in the app: a back door wide enough to
 * drive the player from a page would be a back door wide enough to abuse.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { deliver, FIXTURES, launchApp } from './launch.mjs'

/** Twenty seconds of playback, sampled four times a second. */
const PLAY_MS = 20_000
const SAMPLE_MS = 250
/** A pause longer than this is a stall a person would notice. */
const MAX_STALL_MS = 500
/*
 * Opening budgets, measured from the file arriving to the first frame.
 *
 * Two numbers because two different things happen. The direct route touches no
 * external process at all. The streaming route pays for ffprobe, and on this
 * machine ffprobe spends about half a second starting up before it reads a
 * byte - `ffprobe -version` costs the same as probing a film, while spawning a
 * trivial process costs 16 ms. That floor belongs to the binary, not to this
 * code, so the budget states it rather than pretending it away.
 */
const MAX_OPEN_DIRECT_MS = 1000
const MAX_OPEN_STREAM_MS = 2000
/** How long a seek may take before frames flow again. */
const MAX_SEEK_MS = 1000

const CASES = [
  { file: 'vp9-opus.webm', route: 'Direct' },
  { file: 'h264-aac.mkv', route: 'Converting' },
  { file: 'hevc10-ac3.mkv', route: 'Converting' },
  { file: 'xvid-mp3.avi', route: 'Converting' },
  { file: 'mpeg2.ts', route: 'Converting' },
  { file: 'hd720.mkv', route: 'Converting' },
  { file: 'multi.mkv', route: 'Converting' },
]

const failures = []
const timings = []

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

/* ------------------------------------------------------------------- driving */

async function openFile(app, page, path) {
  const started = Date.now()
  await deliver(app, path)
  await page.waitForFunction(
    () => {
      const v = document.querySelector('video.xp-video')
      // readyState 2 is HAVE_CURRENT_DATA: a frame exists at the current time.
      return v instanceof HTMLVideoElement && v.readyState >= 2
    },
    undefined,
    { timeout: 40_000 },
  )
  return Date.now() - started
}

/**
 * Plays and watches the clock.
 *
 * Sampling currentTime is the only honest measure of whether video is playing:
 * the `waiting` event fires when nothing is wrong and stays silent when
 * everything is, which is exactly why the player samples too.
 */
function measurePlayback(page, ms) {
  return page.evaluate(
    ({ ms, sample }) =>
      new Promise((done) => {
        const video = document.querySelector('video.xp-video')
        if (!video) {
          done({ error: 'no video element' })
          return
        }
        video.muted = true

        const begin = () => {
          const startTime = video.currentTime
          const startWall = performance.now()
          let last = video.currentTime
          let lastMovedAt = startWall
          let longestStall = 0

          const id = setInterval(() => {
            const now = performance.now()
            if (video.currentTime > last) {
              last = video.currentTime
              lastMovedAt = now
            } else {
              longestStall = Math.max(longestStall, now - lastMovedAt)
            }
            if (now - startWall >= ms) {
              clearInterval(id)
              done({
                advanced: video.currentTime - startTime,
                longestStall,
                error: video.error ? `media error code ${video.error.code}` : null,
              })
            }
          }, sample)
        }

        video.play().then(begin, (err) => done({ error: `play() was rejected: ${String(err)}` }))
      }),
    { ms, sample: SAMPLE_MS },
  )
}

/** Seeks to a fraction of the file and times how long until frames flow again. */
function measureSeek(page, fraction) {
  return page.evaluate(
    (fraction) =>
      new Promise((done) => {
        const video = document.querySelector('video.xp-video')
        if (!video || !Number.isFinite(video.duration)) {
          done({ error: 'no duration' })
          return
        }
        const target = video.duration * fraction
        const began = performance.now()
        const from = video.currentTime
        video.currentTime = target

        const id = setInterval(() => {
          const moved = video.currentTime > target + 0.15 || (video.currentTime > from + 0.15 && video.currentTime < target)
          if (moved && !video.paused) {
            clearInterval(id)
            done({
              resumed: true,
              took: performance.now() - began,
              landedNear: Math.abs(video.currentTime - target) < 5,
              error: video.error ? `media error code ${video.error.code}` : null,
            })
          } else if (performance.now() - began > 15_000) {
            clearInterval(id)
            done({
              resumed: false,
              took: performance.now() - began,
              landedNear: false,
              error: video.error ? `media error code ${video.error.code}` : 'never resumed',
            })
          }
        }, 50)
      }),
    fraction,
  )
}

/** Opens the settings menu and walks into one of its panels. */
async function openPanel(page, label) {
  await page.locator('.xp-root').hover()
  await page.locator('.xp-settings .xp-btn').click()
  await page.locator('.xp-menu-item', { hasText: label }).click()
}

/* ------------------------------------------------------------------ the run */

const absent = CASES.map((c) => c.file).filter((f) => !existsSync(join(FIXTURES, f)))
if (absent.length > 0) {
  console.error(`Fixtures are missing: ${absent.join(', ')}\nRun: npm run fixtures`)
  process.exit(1)
}

const { app, page } = await launchApp()

const pageErrors = []
page.on('pageerror', (err) => pageErrors.push(String(err.message)))

for (const testCase of CASES) {
  const path = join(FIXTURES, testCase.file)
  console.log(`\n--- ${testCase.file}`)

  // A clean window per fixture, so a queue left over from the last one cannot
  // change what "opening a file" means.
  await page.reload()
  await page.waitForSelector('.shell')

  let openMs
  try {
    openMs = await openFile(app, page, path)
  } catch (err) {
    check(`${testCase.file}: opens`, false, String(err).split('\n')[0])
    continue
  }

  // The chip is uppercased in CSS, and innerText reports what is rendered.
  const route = (await page.locator('.status-meta .chip').last().innerText()).trim().toLowerCase()
  check(
    `${testCase.file}: routed as "${testCase.route}"`,
    route === testCase.route.toLowerCase(),
    `got "${route}"`,
  )
  const budget = testCase.route === 'Direct' ? MAX_OPEN_DIRECT_MS : MAX_OPEN_STREAM_MS
  check(`${testCase.file}: first frame within ${budget} ms`, openMs < budget, `${openMs} ms`)
  timings.push({ file: testCase.file, openMs, route })

  const play = await measurePlayback(page, PLAY_MS)
  check(`${testCase.file}: no media error`, !play.error, play.error ?? '')
  check(
    `${testCase.file}: played through`,
    (play.advanced ?? 0) >= (PLAY_MS / 1000) * 0.9,
    `advanced ${(play.advanced ?? 0).toFixed(1)} s`,
  )
  check(
    `${testCase.file}: never stalled over ${MAX_STALL_MS} ms`,
    (play.longestStall ?? Infinity) <= MAX_STALL_MS,
    `longest ${Math.round(play.longestStall ?? -1)} ms`,
  )

  const seek = await measureSeek(page, 0.75)
  check(`${testCase.file}: seek to 75% resumed`, seek.resumed === true, seek.error ?? '')
  check(`${testCase.file}: seek landed where asked`, seek.landedNear === true)
  check(
    `${testCase.file}: seek took under ${MAX_SEEK_MS} ms`,
    (seek.took ?? Infinity) < MAX_SEEK_MS,
    `${Math.round(seek.took ?? -1)} ms`,
  )
}

/* ----------------------------------------------- opening the same file twice */

console.log('\n--- reopening: the second time costs no probe')
// Each open needs a fresh window, or the second one finds the video element
// from the first already loaded and measures nothing at all.
await page.reload()
await page.waitForSelector('.shell')
const reopenFirst = await openFile(app, page, join(FIXTURES, 'h264-aac.mkv'))
await page.reload()
await page.waitForSelector('.shell')
const reopenSecond = await openFile(app, page, join(FIXTURES, 'h264-aac.mkv'))
check(
  'a file already open skips the probe the second time',
  reopenSecond < reopenFirst,
  `${reopenFirst} ms then ${reopenSecond} ms`,
)

/* --------------------------------------------------- the quality ladder */

console.log('\n--- hd720.mkv: choosing a lower quality')
await page.reload()
await page.waitForSelector('.shell')
await openFile(app, page, join(FIXTURES, 'hd720.mkv'))

await page.locator('.xp-root').hover()
const qualityButton = page.locator('.xp-quality .xp-btn')
check('hd720.mkv: the quality button is offered', (await qualityButton.count()) === 1)

await qualityButton.click()
const qualityOptions = await page.locator('.xp-quality .xp-menu-option').allInnerTexts()
check(
  'hd720.mkv: the ladder names the real resolutions',
  qualityOptions.length === 2 && qualityOptions[0].includes('720') && qualityOptions[1].includes('480'),
  JSON.stringify(qualityOptions),
)
// Reading the list left the menu open; clicking the button again would only
// close it.
await page.keyboard.press('Escape')

await page.evaluate(async () => {
  const video = document.querySelector('video.xp-video')
  video.muted = true
  await video.play()
  video.currentTime = 10
})
await page.waitForTimeout(2500)
const qBefore = await page.evaluate(() => document.querySelector('video.xp-video').currentTime)

await page.locator('.xp-root').hover()
await qualityButton.click()
await page.locator('.xp-quality .xp-menu-option').nth(1).click()
await page.waitForTimeout(5000)

const qAfter = await page.evaluate(() => ({
  time: document.querySelector('video.xp-video').currentTime,
  height: document.querySelector('video.xp-video').videoHeight,
  error: document.querySelector('video.xp-video').error?.code ?? null,
  paused: document.querySelector('video.xp-video').paused,
}))
check(
  'hd720.mkv: dropping quality kept the position',
  Math.abs(qAfter.time - qBefore) < 6,
  `${qBefore.toFixed(1)} s -> ${qAfter.time.toFixed(1)} s`,
)
check('hd720.mkv: the picture really is smaller now', qAfter.height === 480, `${qAfter.height}p`)
check('hd720.mkv: it kept playing', qAfter.error === null && qAfter.paused === false)

/* -------------------------------------------- the file with two audio tracks */

console.log('\n--- multi.mkv: tracks, switching, and keeping your place')
await page.reload()
await page.waitForSelector('.shell')
await openFile(app, page, join(FIXTURES, 'multi.mkv'))

const trackCount = await page.evaluate(() => document.querySelectorAll('video.xp-video track').length)
check('multi.mkv: the embedded subtitle is offered', trackCount >= 1, `${trackCount} track element(s)`)

await openPanel(page, 'Audio track')
const audioOptions = await page.locator('.xp-menu-option').allInnerTexts()
check('multi.mkv: both audio tracks are listed', audioOptions.length === 2, JSON.stringify(audioOptions))
await page.keyboard.press('Escape')

// Get into the file, then change language and check we stayed where we were.
await page.evaluate(async () => {
  const video = document.querySelector('video.xp-video')
  video.muted = true
  await video.play()
  video.currentTime = 12
})
await page.waitForTimeout(2500)
const before = await page.evaluate(() => document.querySelector('video.xp-video').currentTime)

await openPanel(page, 'Audio track')
await page.locator('.xp-menu-option').nth(1).click()
await page.waitForTimeout(5000)

const after = await page.evaluate(() => ({
  time: document.querySelector('video.xp-video').currentTime,
  error: document.querySelector('video.xp-video').error?.code ?? null,
  subtitlesStillThere: document.querySelectorAll('video.xp-video track').length,
}))

check(
  'multi.mkv: the audio switch kept the position',
  Math.abs(after.time - before) < 6,
  `${before.toFixed(1)} s -> ${after.time.toFixed(1)} s`,
)
check('multi.mkv: the audio switch played on', after.error === null, `error ${after.error}`)
check('multi.mkv: subtitles survived the switch', after.subtitlesStillThere >= 1)

check('no uncaught errors in the window', pageErrors.length === 0, pageErrors.join(' | '))

await app.close()

console.log('\nTime from the file arriving to the first frame')
for (const t of timings) {
  console.log(`  ${t.file.padEnd(18)} ${String(t.openMs).padStart(5)} ms   ${t.route}`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('\nplayback: all checks passed')
