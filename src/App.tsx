import { useCallback, useEffect, useRef, useState } from 'react'
import { XPlayer } from 'x-player'
import type { XPlayerApi } from 'x-player'
import 'x-player/style.css'
import type { Diagnostics, OpenedMedia, Preferences, RecentEntry } from '../shared/api'
import { DropVeil } from './ui/DropVeil'
import { EmptyState } from './ui/EmptyState'
import { Queue } from './ui/Queue'
import { StatusBar } from './ui/StatusBar'
import { useDroppedFiles } from './useDroppedFiles'
import { useWindowPlaybackKeys } from './useWindowPlaybackKeys'

export function App() {
  const [queue, setQueue] = useState<string[]>([])
  const [index, setIndex] = useState(0)
  const [media, setMedia] = useState<OpenedMedia | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  /** Something worth saying that is not a failure. */
  const [notice, setNotice] = useState<string | null>(null)
  const [recent, setRecent] = useState<RecentEntry[]>([])
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)
  const [queueOpen, setQueueOpen] = useState(false)
  const [onTop, setOnTop] = useState(false)

  const apiRef = useRef<XPlayerApi | null>(null)
  /** The queue as it stands, so a drop can read it without re-arming the
      window-wide drop listeners on every queue change. */
  const queueRef = useRef<string[]>([])
  /** Where to pick playback up after the source is rebuilt behind our back. */
  const resumeAtRef = useRef(0)
  /** Volume and speed, which belong to the viewer rather than to any one file. */
  const prefsRef = useRef<Preferences | null>(null)
  const saveTimer = useRef<number | null>(null)
  const resumePlayingRef = useRef(false)

  const refreshRecent = useCallback(() => {
    void window.desktop.recent().then(setRecent)
  }, [])

  useEffect(() => {
    refreshRecent()
    void window.desktop.diagnostics().then(setDiagnostics)
    void window.desktop.preferences().then((p) => {
      prefsRef.current = p
    })
  }, [refreshRecent])

  useEffect(() => {
    queueRef.current = queue
  }, [queue])

  /*
   * The streaming engine is deliberately not preloaded here.
   *
   * It looks like an easy win - almost every file becomes a stream - but it was
   * measured and it is not. Parsing half a megabyte of JavaScript takes the main
   * thread at whatever moment it lands, and opening a file is dominated by
   * ffprobe and the first segment rather than by fetching the engine. Preloading
   * at mount cost a directly-playable file 900 ms; deferring it to an idle
   * callback moved the cost onto the streaming files instead. Letting the player
   * fetch it when it meets its first HLS source is faster than both.
   */

  /* ------------------------------------------------------------------ opening */

  /** Resolves true when something is now playing. */
  const openPath = useCallback(
    async (path: string): Promise<boolean> => {
      setBusy(true)
      setProblem(null)
      setNotice(null)
      const result = await window.desktop.open(path)
      setBusy(false)
      if (!result.ok) {
        // Deliberately not clearing media. Clicking a corrupt row used to swap
        // the stage back to the empty state, so one bad file in a long queue
        // cost you your place in the film that was playing perfectly well.
        setProblem(`${result.name || 'This file'} could not be opened: ${result.message}`)
        return false
      }
      resumeAtRef.current = 0
      setMedia(result.media)
      refreshRecent()
      return true
    },
    [refreshRecent],
  )

  /** Replaces the queue and starts at the given position. */
  const play = useCallback(
    (paths: string[], at = 0) => {
      if (paths.length === 0) return
      setQueue(paths)
      setIndex(at)
      void openPath(paths[at])
    },
    [openPath],
  )

  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next >= queue.length) return
      // The mark moves at once so the click feels answered, and moves back if
      // the file turns out not to open - otherwise the queue would point at a
      // row that is not the one still playing.
      const previous = index
      setIndex(next)
      void openPath(queue[next]).then((ok) => {
        if (!ok) setIndex(previous)
      })
    },
    [queue, index, openPath],
  )

  const addPaths = useCallback(
    async (paths: string[]) => {
      const files = await window.desktop.expand(paths)
      if (files.length === 0) {
        setProblem('Nothing playable was in there.')
        return
      }
      // A drop while something is already playing extends the queue rather than
      // interrupting it; an empty player starts playing straight away.
      const current = queueRef.current
      if (current.length === 0) {
        play(files)
        return
      }
      // A path is a row's identity in the queue, so the same file arriving twice
      // would land two rows that cannot be told apart. Saying so beats silently
      // growing the queue with something already in it.
      const fresh = files.filter((path) => !current.includes(path))
      if (fresh.length === 0) {
        setProblem(files.length === 1 ? 'That one is already in the queue.' : 'Those are already in the queue.')
        return
      }
      setProblem(null)
      setQueue([...current, ...fresh])
    },
    [play],
  )

  /**
   * Moves a queued file to a different position.
   *
   * The index follows the file rather than the slot: reordering the queue must
   * never change what is on screen, and the row being played is usually the one
   * people drag around.
   */
  const reorder = useCallback(
    (from: number, to: number) => {
      if (from < 0 || from >= queue.length) return
      const playing = queue[index]
      const next = [...queue]
      const [row] = next.splice(from, 1)
      next.splice(to > from ? to - 1 : to, 0, row)
      setQueue(next)
      const moved = next.indexOf(playing)
      if (moved !== -1) setIndex(moved)
    },
    [queue, index],
  )

  const drag = useDroppedFiles(addPaths)

  /*
   * The player element, for the window-wide shortcut handler. The library binds
   * its keys to this element rather than the document, which is right for an
   * embedded player and wrong for a window that is nothing but a player.
   */
  const playerRoot = useCallback(
    () => (apiRef.current?.getVideo()?.closest('.xp-root') as HTMLElement | null) ?? null,
    [],
  )
  useWindowPlaybackKeys(playerRoot)

  // Files the OS hands over: a double-clicked .mkv, or a second launch.
  useEffect(() => window.desktop.onOpenPaths((paths) => void addPaths(paths)), [addPaths])

  /* ------------------------------------------------------------ audio switch */

  const changeAudio = useCallback(
    async (order: number) => {
      if (!media) return
      const video = apiRef.current?.getVideo()
      resumeAtRef.current = video?.currentTime ?? 0
      resumePlayingRef.current = video ? !video.paused : false

      const result = await window.desktop.setAudio(media.id, order)
      if (result.ok) setMedia(result.media)
      else setProblem(result.message)
    },
    [media],
  )

  /**
   * Restores the position after the source was rebuilt.
   *
   * Changing the audio track means a new stream from the gateway, which the
   * player quite reasonably treats as a new source. Nobody wants to be sent
   * back to the start of a film for changing the language.
   */
  const onReady = useCallback((video: HTMLVideoElement) => {
    // Give the player the keyboard, so space and the arrow keys work at once.
    ;(video.closest('.xp-root') as HTMLElement | null)?.focus({ preventScroll: true })

    /*
     * Put the viewer's volume and speed back.
     *
     * A new file remounts the player, and the library only remembers position,
     * so every episode used to start at full volume however quietly the last
     * one was playing. The listeners below die with the element on the next
     * remount, and the write is delayed because holding the arrow key nudges
     * the volume in 5% steps and each one would otherwise be a disk write.
     */
    const prefs = prefsRef.current
    if (prefs) {
      video.volume = prefs.volume
      // Matching the library's own coupling: it treats volume 0 as muted.
      video.muted = prefs.volume === 0
      video.playbackRate = prefs.rate
    }
    const remember = () => {
      const next: Preferences = { volume: video.volume, rate: video.playbackRate }
      prefsRef.current = next
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null
        void window.desktop.savePreferences(next)
      }, 400)
    }
    video.addEventListener('volumechange', remember)
    video.addEventListener('ratechange', remember)

    const at = resumeAtRef.current
    if (at <= 0.5) return
    resumeAtRef.current = 0
    video.currentTime = at
    if (resumePlayingRef.current) void video.play().catch(() => {})
  }, [])

  /* ----------------------------------------------------------------- controls */

  const openFiles = useCallback(async () => {
    const paths = await window.desktop.pick()
    if (paths.length > 0) play(await window.desktop.expand(paths))
  }, [play])

  const openFolder = useCallback(async () => {
    const paths = await window.desktop.pickFolder()
    if (paths.length > 0) play(paths)
  }, [play])

  const toggleOnTop = useCallback(() => {
    void window.desktop.setAlwaysOnTop(!onTop).then(setOnTop)
  }, [onTop])

  const hasNext = index < queue.length - 1

  return (
    <div className="shell" data-dragging={drag.active ? 'true' : 'false'}>
      <StatusBar
        media={media}
        busy={busy}
        position={queue.length > 1 ? { index, total: queue.length } : null}
        queueOpen={queueOpen}
        onTop={onTop}
        onToggleQueue={() => setQueueOpen((v) => !v)}
        onToggleOnTop={toggleOnTop}
        onOpen={openFiles}
      />

      <div className="body">
        <main className="stage">
          {media ? (
            <XPlayer
              key={media.path}
              sources={media.sources}
              tracks={media.tracks}
              audioTracks={media.audioTracks}
              activeAudioTrack={media.activeAudioTrack}
              onAudioTrack={(order) => void changeAudio(order)}
              apiRef={apiRef}
              title={media.name}
              storageKey={media.path}
              // The brand amber, kept for the player alone. The library default is a
              // cool blue; here the case around the picture is graphite with no accent
              // of its own, so the seek bar and the player’s focus ring carry the one
              // colour the product has, drawn over the footage.
              accent="#ffb020"
              autoPlay
              onReady={onReady}
              // Without this a gateway that dies mid-film just stops the
              // picture: every other failure in this app says what happened.
              onError={(message) => setProblem(message)}
              onEnded={() => {
                if (hasNext) goTo(index + 1)
                else if (queue.length > 1) setNotice('That was the last file in the queue.')
              }}
            />
          ) : (
            <EmptyState
              busy={busy}
              problem={problem}
              recent={recent}
              diagnostics={diagnostics}
              onOpenFiles={openFiles}
              onOpenFolder={openFolder}
              onOpenRecent={(path) => play([path])}
              onClearRecent={() => void window.desktop.clearRecent().then(refreshRecent)}
            />
          )}
          {media && (problem ?? notice) && (
            <div className={problem ? 'banner banner-bad' : 'banner'} role={problem ? 'alert' : 'status'}>
              <span>{problem ?? notice}</span>
              <button
                type="button"
                className="banner-close"
                aria-label="Dismiss"
                onClick={() => {
                  setProblem(null)
                  setNotice(null)
                }}
              >
                &times;
              </button>
            </div>
          )}
        </main>

        {queueOpen && (
          <Queue
            items={queue}
            index={index}
            onPick={goTo}
            onReorder={reorder}
            onAdd={openFiles}
            onClear={() => {
              setQueue(media ? [media.path] : [])
              setIndex(0)
            }}
          />
        )}
      </div>

      <DropVeil drag={drag} queued={queue.length > 0} />
    </div>
  )
}
