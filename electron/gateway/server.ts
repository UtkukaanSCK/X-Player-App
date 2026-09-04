import { randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname } from 'node:path'
import { planRoute } from './plan'
import { probe } from './probe'
import { keyOf, Session, type SessionKey } from './session'
import { convertSidecar, extractSubtitle, findSidecars, type SidecarSubtitle } from './subtitles'
import type { MediaInfo, RoutePlan } from './types'

/** Sessions kept warm at once. Each one owns an ffmpeg process and a temp dir. */
const MAX_SESSIONS = 4

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
}

export interface OpenFile {
  id: string
  info: MediaInfo
  plan: RoutePlan
  sidecars: SidecarSubtitle[]
}

export interface GatewayHandle {
  port: number
  token: string
  origin: string
  open(path: string): Promise<OpenFile>
  /** Starts encoding the opening segment before the player asks for it. */
  warm(id: string, audioOrder: number): void
  /** Drops a file and kills any encoder still working on it. */
  release(id: string): void
  get(id: string): OpenFile | undefined
  close(): Promise<void>
}

/**
 * The local media gateway.
 *
 * Everything it can reach is something the user explicitly opened. URLs carry
 * opaque ids rather than paths, so a request cannot name a file that was never
 * opened, and every request must present the launch token. Without both of
 * those, this server would be a way for any web page the user has open to read
 * their disk.
 */
export async function startGateway(): Promise<GatewayHandle> {
  const token = randomBytes(32).toString('hex')
  const files = new Map<string, OpenFile>()
  /*
   * Promises, not sessions.
   *
   * Building a session awaits planRoute, so two callers for the same key both
   * missed the map and both constructed one; the second overwrote the first and
   * the orphan - already spawning ffmpeg via warm() - was in no map and so was
   * never disposed. Storing the in-flight promise makes the second caller wait
   * for the first instead of racing it.
   */
  const sessions = new Map<string, Promise<Session>>()
  const subtitleCache = new Map<string, string>()

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(message)
    })
  })

  await listen(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('the gateway did not get a port')
  const port = address.port
  const origin = `http://127.0.0.1:${port}`

  function disposeSession(pending: Promise<Session>) {
    void pending.then((s) => s.dispose()).catch(() => {})
  }

  function sessionFor(key: SessionKey): Promise<Session> {
    const id = keyOf(key)
    const existing = sessions.get(id)
    if (existing) {
      // Move it to the end. A Map iterates in insertion order, so re-inserting
      // on every use turns that order into a genuine least-recently-used one.
      //
      // Insertion order alone was a bug: the session you are watching is the
      // oldest one the moment you have switched quality and audio a few times,
      // so a fifth switch would kill the ffmpeg process feeding the picture and
      // delete its segments from under it.
      sessions.delete(id)
      sessions.set(id, existing)
      return existing
    }

    if (sessions.size >= MAX_SESSIONS) {
      const stalest = sessions.keys().next().value
      if (stalest) {
        const evicted = sessions.get(stalest)
        if (evicted) disposeSession(evicted)
        sessions.delete(stalest)
      }
    }

    const file = files.get(key.fileId)
    if (!file) return Promise.reject(new Error('unknown file'))
    // The plan is recomputed per audio track: whether the audio can be copied
    // depends on which track was picked, and the second track is often the one
    // in a codec browsers refuse.
    const pending = planRoute(file.info, key.audioOrder).then(
      (plan) => new Session(key, file.info, plan),
    )
    sessions.set(id, pending)
    // A failed plan must not stay cached, or the file could never be opened
    // again for the rest of the run.
    pending.catch(() => {
      if (sessions.get(id) === pending) sessions.delete(id)
    })
    return pending
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', origin)

    // Defence in depth against DNS rebinding: a page that resolves its own
    // hostname to 127.0.0.1 still cannot present the right Host header.
    const host = req.headers.host ?? ''
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(403).end('bad host')
      return
    }
    if (url.searchParams.get('t') !== token) {
      res.writeHead(403).end('bad token')
      return
    }

    const parts = url.pathname.split('/').filter(Boolean)
    const [scope, fileId, kind, tail] = parts
    if (scope !== 'm' || !fileId || !files.has(fileId)) {
      res.writeHead(404).end('not found')
      return
    }
    const file = files.get(fileId)!

    if (kind === 'file') {
      await serveFile(req, res, file.info.path)
      return
    }

    if (kind === 'index.m3u8') {
      const key: SessionKey = {
        fileId,
        audioOrder: Number(url.searchParams.get('a') ?? 0) || 0,
        maxHeight: Number(url.searchParams.get('h') ?? 0) || 0,
      }
      const session = await sessionFor(key)
      const query = `?t=${token}&a=${key.audioOrder}&h=${key.maxHeight}`
      const body = session.playlist((n) => `seg/${n}.ts${query}`)
      res.writeHead(200, {
        'content-type': 'application/vnd.apple.mpegurl',
        'cache-control': 'no-store',
      })
      res.end(body)
      return
    }

    if (kind === 'seg' && tail) {
      const n = Number(tail.replace('.ts', ''))
      if (!Number.isInteger(n)) {
        res.writeHead(400).end('bad segment')
        return
      }
      const key: SessionKey = {
        fileId,
        audioOrder: Number(url.searchParams.get('a') ?? 0) || 0,
        maxHeight: Number(url.searchParams.get('h') ?? 0) || 0,
      }
      const path = await (await sessionFor(key)).segment(n)
      const info = await stat(path)
      res.writeHead(200, {
        'content-type': 'video/mp2t',
        'content-length': String(info.size),
        'cache-control': 'no-store',
      })
      pipeFile(res, path)
      return
    }

    if (kind === 'sub' && tail) {
      const name = tail.replace('.vtt', '')
      const cacheKey = `${fileId}|${name}`
      let body = subtitleCache.get(cacheKey)
      if (body === undefined) {
        if (name.startsWith('x')) {
          const sidecar = file.sidecars[Number(name.slice(1))]
          if (!sidecar) {
            res.writeHead(404).end('no such subtitle')
            return
          }
          body = await convertSidecar(sidecar.path)
        } else {
          body = await extractSubtitle(file.info, Number(name))
        }
        subtitleCache.set(cacheKey, body)
      }
      res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
      return
    }

    res.writeHead(404).end('not found')
  }

  return {
    port,
    token,
    origin,
    async open(path: string): Promise<OpenFile> {
      const existing = [...files.values()].find((f) => f.info.path === path)
      if (existing) return existing

      const info = await probe(path)
      const plan = await planRoute(info)
      const sidecars = await findSidecars(path)
      const entry: OpenFile = { id: randomUUID(), info, plan, sidecars }
      files.set(entry.id, entry)
      return entry
    },
    warm(id: string, audioOrder: number) {
      const file = files.get(id)
      if (!file || file.plan.route !== 'transcode') return
      // Runs while the window is still building the player and fetching the
      // playlist. By the time the first segment is asked for it is usually
      // already on disk, which is most of the difference between opening in
      // half a second and opening in one and a half.
      void sessionFor({ fileId: id, audioOrder, maxHeight: 0 })
        .then((session) => session.segment(0))
        .catch(() => {
          // A failure here is not the user's problem yet: the real request for
          // this segment is moments away and will report it properly.
        })
    },
    release(id: string) {
      // Session keys start with the file id, so this catches every audio track
      // and quality rung that was ever built for it.
      for (const [key, pending] of sessions) {
        if (key.startsWith(id + '|')) {
          disposeSession(pending)
          sessions.delete(key)
        }
      }
      files.delete(id)
    },
    get: (id: string) => files.get(id),
    async close() {
      for (const pending of sessions.values()) disposeSession(pending)
      sessions.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * Pipes a file to the response without letting it take the process down.
 *
 * An unhandled 'error' on a stream throws, and in the main process that is a
 * crash rather than a 500. Two things reach it: a drive removed mid-playback,
 * and a segment pruned between the stat that sized it and the read here.
 *
 * The close handler is not optional either - hls.js abandons fragments on every
 * seek, and without it each abandoned request leaves a descriptor open.
 */
function pipeFile(res: ServerResponse, path: string, range?: { start: number; end: number }) {
  const stream = range ? createReadStream(path, range) : createReadStream(path)
  stream.on('error', () => {
    res.destroy()
  })
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // Port 0 asks the OS for a free port, and 127.0.0.1 keeps it off the network.
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

/** Byte-range file serving, which is what makes seeking work on the direct route. */
async function serveFile(req: IncomingMessage, res: ServerResponse, path: string) {
  const info = await stat(path)
  const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
  const range = req.headers.range

  if (!range) {
    res.writeHead(200, {
      'content-type': type,
      'content-length': String(info.size),
      'accept-ranges': 'bytes',
    })
    pipeFile(res, path)
    return
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  if (!match) {
    res.writeHead(416, { 'content-range': `bytes */${info.size}` }).end()
    return
  }

  const start = match[1] ? Number(match[1]) : 0
  const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1
  if (start >= info.size || start > end) {
    res.writeHead(416, { 'content-range': `bytes */${info.size}` }).end()
    return
  }

  res.writeHead(206, {
    'content-type': type,
    'content-length': String(end - start + 1),
    'content-range': `bytes ${start}-${end}/${info.size}`,
    'accept-ranges': 'bytes',
  })
  pipeFile(res, path, { start, end })
}
