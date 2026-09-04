import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Builds the set of files the end-to-end suite plays.
 *
 * Everything is produced locally from the clip already in the player
 * repository, so the suite has no network dependency and the fixtures cannot
 * change under it. Each one is chosen to exercise a different reason a browser
 * refuses a file.
 */
const SOURCE = resolve(import.meta.dirname, '../../public/media/demo-480p.mp4')
const OUT = resolve(import.meta.dirname, '../fixtures')

/** Kept short: the suite plays 20 seconds of each and seeks to 75%. */
const DURATION = 40

const SUBTITLE_SRT = `1
00:00:01,000 --> 00:00:05,000
Embedded subtitle, first line.

2
00:00:06,000 --> 00:00:12,000
Still here, second line.
`

const CASES = [
  {
    file: 'h264-aac.mkv',
    why: 'Compatible codecs in a container Chromium refuses',
    args: ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k'],
  },
  {
    file: 'hevc10-ac3.mkv',
    why: 'HEVC 10-bit video and AC-3 audio: neither decodes in a browser',
    args: [
      '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-preset', 'ultrafast', '-crf', '30',
      '-c:a', 'ac3', '-b:a', '192k',
    ],
  },
  {
    file: 'xvid-mp3.avi',
    why: 'MPEG-4 ASP in AVI, the shape of an old download',
    args: ['-c:v', 'mpeg4', '-vtag', 'xvid', '-q:v', '6', '-c:a', 'libmp3lame', '-b:a', '128k'],
  },
  {
    file: 'mpeg2.ts',
    why: 'MPEG-2 in a transport stream, the shape of a TV recording',
    args: ['-c:v', 'mpeg2video', '-b:v', '2M', '-c:a', 'mp2', '-b:a', '192k'],
  },
  {
    file: 'hd720.mkv',
    why: 'Tall enough for the quality ladder to have something below it',
    args: ['-vf', 'scale=1280:-2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-b:a', '128k'],
  },
  {
    file: 'vp9-opus.webm',
    why: 'Already playable: this one must not be converted at all',
    args: ['-c:v', 'libvpx-vp9', '-b:v', '600k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus'],
  },
]

async function ffmpeg(args) {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 32 << 20 })
}

async function main() {
  if (!existsSync(SOURCE)) {
    console.error(`Source clip not found: ${SOURCE}`)
    process.exit(1)
  }
  mkdirSync(OUT, { recursive: true })

  const srtPath = join(OUT, 'embedded.srt')
  writeFileSync(srtPath, SUBTITLE_SRT, 'utf8')

  for (const c of CASES) {
    const target = join(OUT, c.file)
    if (existsSync(target)) {
      console.log(`= ${c.file.padEnd(18)} already there`)
      continue
    }
    process.stdout.write(`+ ${c.file.padEnd(18)} ${c.why} ... `)
    // -stream_loop makes a 40 second clip out of a shorter source, so seeking
    // to 75% lands somewhere the encoder has not been yet.
    await ffmpeg(['-stream_loop', '-1', '-i', SOURCE, '-t', String(DURATION), ...c.args, target])
    console.log(`${(statSync(target).size / 1024 / 1024).toFixed(1)} MB`)
  }

  // Two audio tracks and an embedded subtitle: the file that exercises the
  // audio menu, the subtitle extraction and position keeping across a switch.
  const multi = join(OUT, 'multi.mkv')
  if (existsSync(multi)) {
    console.log(`= ${'multi.mkv'.padEnd(18)} already there`)
  } else {
    process.stdout.write(`+ ${'multi.mkv'.padEnd(18)} Two audio tracks plus an embedded subtitle ... `)
    await ffmpeg([
      '-stream_loop', '-1', '-i', SOURCE,
      '-f', 'lavfi', '-t', String(DURATION), '-i', 'sine=frequency=440:sample_rate=48000',
      '-i', srtPath,
      '-t', String(DURATION),
      '-map', '0:v:0', '-map', '0:a:0', '-map', '1:a:0', '-map', '2:s:0',
      '-c:v', 'copy',
      '-c:a:0', 'aac', '-b:a:0', '128k',
      '-c:a:1', 'ac3', '-b:a:1', '128k',
      '-c:s', 'srt',
      '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English',
      '-metadata:s:a:1', 'language=tur', '-metadata:s:a:1', 'title=Commentary',
      '-metadata:s:s:0', 'language=eng',
      multi,
    ])
    console.log(`${(statSync(multi).size / 1024 / 1024).toFixed(1)} MB`)
  }

  console.log(`\nFixtures in ${OUT}`)
}

main().catch((err) => {
  console.error(`\n${err.stderr || err.message}`)
  process.exit(1)
})
