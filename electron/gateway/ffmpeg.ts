import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Where the binaries are.
 *
 * Packaged, they sit in resources/ffmpeg next to the app. In development they
 * come from PATH, which is why `npm run dev` needs ffmpeg installed. The env
 * override exists so a build can be tested against a specific build of ffmpeg.
 */
function resolveBinary(name: 'ffmpeg' | 'ffprobe'): string {
  const override = process.env[name === 'ffmpeg' ? 'XPLAYER_FFMPEG' : 'XPLAYER_FFPROBE']
  if (override) return override

  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const packaged = join(process.resourcesPath ?? '', 'ffmpeg', exe)
  if (process.resourcesPath && existsSync(packaged)) return packaged
  return name
}

export const FFMPEG = resolveBinary('ffmpeg')
export const FFPROBE = resolveBinary('ffprobe')

export interface Capabilities {
  /** H.264 encoder to use, best available first. */
  encoder: string
  /** True when that encoder runs on the GPU. */
  hardware: boolean
  /** Decoder acceleration flag, or null when none is available. */
  hwaccel: string | null
  /** Encoder-specific quality and speed flags. */
  encoderArgs: string[]
  /** Candidates ffmpeg listed but that failed a real encode. */
  rejected: string[]
}

interface Encoder {
  name: string
  hardware: boolean
  /**
   * Quality and speed flags, best first.
   *
   * More than one set because the same encoder does not take the same flags in
   * every ffmpeg build: VideoToolbox accepts constant quality on some and only
   * a bitrate on others. The probe below tries them in order, so a build that
   * refuses the good flags still gets hardware encoding rather than silently
   * dropping the whole machine to software.
   */
  argSets: string[][]
  /** Platforms where this one is worth trying at all. Empty means anywhere. */
  platforms?: NodeJS.Platform[]
}

/**
 * Best first. Software x264 is the floor and is always present.
 *
 * VAAPI is deliberately missing. Encoding through it needs a device flag and a
 * hwupload filter chain that the rest of this file does not build, and shipping
 * an encoder that fails the moment a Linux user opens a file would be worse
 * than falling back to x264 and saying so.
 */
const ENCODERS: Encoder[] = [
  // Constant-quality NVENC. p5 is the middle preset: visibly better than the
  // fast ones and still far quicker than realtime on any modern NVIDIA card.
  { name: 'h264_nvenc', hardware: true, argSets: [['-preset', 'p5', '-rc', 'vbr', '-cq', '21', '-b:v', '0']] },
  // The only hardware encoder on Apple Silicon, and the good one on Intel Macs.
  {
    name: 'h264_videotoolbox',
    hardware: true,
    argSets: [
      ['-q:v', '58', '-realtime', 'false'],
      ['-q:v', '58'],
      // Older builds have no constant-quality mode at all. 6 Mbit is generous
      // for 1080p and the ceiling only binds on detailed footage.
      ['-b:v', '6M'],
    ],
    platforms: ['darwin'],
  },
  { name: 'h264_qsv', hardware: true, argSets: [['-preset', 'medium', '-global_quality', '23'], ['-b:v', '6M']] },
  {
    name: 'h264_amf',
    hardware: true,
    argSets: [['-quality', 'balanced', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '24'], ['-b:v', '6M']],
  },
  { name: 'libx264', hardware: false, argSets: [['-preset', 'veryfast', '-crf', '21']] },
]

const HWACCELS = ['cuda', 'd3d11va', 'videotoolbox', 'vaapi', 'qsv']

let cached: Capabilities | null = null

/**
 * Where the answer is remembered between launches.
 *
 * Probing costs a second or so of process launches, and a machine's encoders do
 * not change between one run and the next. Paying it every time would be worst
 * exactly when it hurts most: double-clicking a film in the file manager starts
 * the app and opens the file in the same breath, and the probe would be
 * competing with it for the disk.
 *
 * The stored answer is keyed by the ffmpeg build, so swapping the binary or
 * updating the app throws it away rather than trusting a stale reading.
 */
let cachePath: string | null = null

export function useCapabilityCache(directory: string) {
  cachePath = join(directory, 'capabilities.json')
}

function readCache(key: string): Capabilities | null {
  if (!cachePath || !existsSync(cachePath)) return null
  try {
    const stored = JSON.parse(readFileSync(cachePath, 'utf8')) as { key?: string; value?: Capabilities }
    return stored.key === key && stored.value ? stored.value : null
  } catch {
    return null
  }
}

function writeCache(key: string, value: Capabilities) {
  if (!cachePath) return
  try {
    writeFileSync(cachePath, JSON.stringify({ key, value }), 'utf8')
  } catch {
    /* an unwritable cache costs a probe next launch, nothing more */
  }
}

/** Identifies the ffmpeg build, so a different one is measured afresh. */
async function buildKey(): Promise<string> {
  try {
    const { stdout } = await run(FFMPEG, ['-hide_banner', '-version'], { maxBuffer: 1 << 20 })
    return `${process.platform}|${process.arch}|${stdout.split(/\r?\n/)[0].trim()}`
  } catch {
    return `${process.platform}|${process.arch}|missing`
  }
}

/**
 * Encodes two frames and throws away the result.
 *
 * Being listed by `ffmpeg -encoders` only means the build was compiled with
 * support, not that this machine can run it: NVENC is listed on a laptop with
 * no NVIDIA card, QSV on a desktop with the iGPU disabled in the BIOS. The
 * difference between listed and working is a black window, so it is measured
 * rather than assumed. It costs one process launch per candidate, at startup,
 * while nobody is waiting for anything.
 */
async function workingArgs(encoder: Encoder): Promise<string[] | null> {
  for (const args of encoder.argSets) {
    try {
      await run(
        FFMPEG,
        [
          '-hide_banner', '-loglevel', 'error', '-nostdin',
          '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=2:duration=1',
          '-frames:v', '2',
          '-c:v', encoder.name, ...args,
          '-pix_fmt', 'yuv420p',
          '-f', 'null', '-',
        ],
        { maxBuffer: 1 << 20, timeout: 20_000 },
      )
      return args
    } catch {
      // Try the next set of flags; only when all of them fail is the encoder
      // itself unusable here.
    }
  }
  return null
}

/**
 * Asks ffmpeg what this machine can do, once per app launch.
 *
 * The answer decides whether the app can convert faster than realtime, which is
 * the difference between smooth playback and a slideshow. It is reported to the
 * user rather than assumed, because on a machine that cannot keep up the honest
 * move is to offer a lower resolution, not to stutter and say nothing.
 */
export async function capabilities(): Promise<Capabilities> {
  if (cached) return cached

  const key = await buildKey()
  const remembered = readCache(key)
  if (remembered) {
    cached = remembered
    return cached
  }

  let encoderList = ''
  let hwaccelList = ''
  try {
    encoderList = (await run(FFMPEG, ['-hide_banner', '-encoders'], { maxBuffer: 8 << 20 })).stdout
    hwaccelList = (await run(FFMPEG, ['-hide_banner', '-hwaccels'], { maxBuffer: 1 << 20 })).stdout
  } catch {
    // ffmpeg is missing or broken. Fall back to the software floor and let the
    // first playback attempt produce a real error message.
  }

  const candidates = ENCODERS.filter(
    (e) => (!e.platforms || e.platforms.includes(process.platform)) && encoderList.includes(` ${e.name} `),
  )

  const floor = ENCODERS[ENCODERS.length - 1]
  const rejected: string[] = []
  let chosen = floor
  let chosenArgs = floor.argSets[0]

  for (const candidate of candidates) {
    // x264 is the floor: if even that fails, something is wrong with ffmpeg
    // itself and the first real playback attempt will say so properly.
    if (!candidate.hardware) {
      chosen = candidate
      chosenArgs = candidate.argSets[0]
      break
    }
    const args = await workingArgs(candidate)
    if (args) {
      chosen = candidate
      chosenArgs = args
      break
    }
    rejected.push(candidate.name)
  }

  const hwaccel = HWACCELS.find((h) => new RegExp(`^${h}$`, 'm').test(hwaccelList)) ?? null

  cached = {
    encoder: chosen.name,
    hardware: chosen.hardware,
    // Software encoding plus hardware decoding is a fine combination, but
    // pairing an unrelated hwaccel with libx264 costs a GPU->CPU copy for no
    // gain on some setups. Only accelerate decoding when encoding is on the GPU.
    hwaccel: chosen.hardware ? hwaccel : null,
    encoderArgs: chosenArgs,
    rejected,
  }
  writeCache(key, cached)
  return cached
}

/** True when ffmpeg can be executed at all. Checked once at startup. */
export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run(FFMPEG, ['-hide_banner', '-version'], { maxBuffer: 1 << 20 })
    return true
  } catch {
    return false
  }
}
