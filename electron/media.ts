import type { MediaAudioTrack, MediaSource, MediaTextTrack, OpenedMedia } from '../shared/api'
import type { GatewayHandle, OpenFile } from './gateway/server'

/** Ceilings offered in the quality menu, highest first. */
const LADDER = [1080, 720, 480]

/**
 * Turns a file the gateway has opened into the props the player understands.
 *
 * The player learns nothing about ffmpeg or routes: it is handed sources,
 * subtitle tracks and an audio list, exactly as a web page would hand them
 * over. That is what keeps one player serving both the browser and the desktop.
 */
export function toMedia(gateway: GatewayHandle, file: OpenFile, audioOrder: number): OpenedMedia {
  const { id, info, plan, sidecars } = file
  const base = `${gateway.origin}/m/${id}`
  const t = `t=${gateway.token}`

  const sources: MediaSource[] = []
  if (plan.route === 'direct') {
    sources.push({ src: `${base}/file?${t}`, label: 'Original', type: 'native' })
  } else {
    const height = info.video?.height ?? 0
    sources.push({
      src: `${base}/index.m3u8?${t}&a=${audioOrder}&h=0`,
      label: height ? `Original (${height}p)` : 'Original',
      type: 'hls',
    })
    for (const cap of LADDER) {
      // A ceiling above the source resolution would upscale, which is a way to
      // spend electricity making a picture worse.
      if (height && cap >= height) continue
      sources.push({
        src: `${base}/index.m3u8?${t}&a=${audioOrder}&h=${cap}`,
        label: `${cap}p`,
        type: 'hls',
      })
    }
  }

  const tracks: MediaTextTrack[] = []
  for (const sub of info.subtitles) {
    if (!sub.textBased) continue
    tracks.push({
      src: `${base}/sub/${sub.index}.vtt?${t}`,
      label: sub.title,
      srclang: sub.language || 'und',
    })
  }
  sidecars.forEach((sidecar, i) => {
    tracks.push({ src: `${base}/sub/x${i}.vtt?${t}`, label: sidecar.label, srclang: 'und' })
  })

  const audioTracks: MediaAudioTrack[] = info.audio.map((a) => ({
    id: a.order,
    label: a.title,
    language: a.language || undefined,
  }))

  return {
    id,
    path: info.path,
    name: info.name,
    duration: info.duration,
    route: plan.route,
    reason: plan.reason,
    videoCodec: info.video?.codec ?? '',
    audioCodec: info.audio[audioOrder]?.codec ?? info.audio[0]?.codec ?? '',
    resolution: info.video ? `${info.video.width}x${info.video.height}` : '',
    sources,
    tracks,
    audioTracks,
    // The direct route plays whatever the file declares first; there is nothing
    // to switch between, so nothing is marked active.
    activeAudioTrack: plan.route === 'direct' ? -1 : audioOrder,
    imageSubtitles: info.subtitles.filter((s) => !s.textBased).map((s) => s.title),
  }
}
