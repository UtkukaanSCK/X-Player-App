import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExportFormat, ExportOption, ExportProgress, OpenedMedia } from '../shared/api'

export interface ExportControls {
  /** The export under way, whichever file it came from, or null. */
  running: ExportProgress | null
  /** What the open file can be exported to; null until asked for. */
  options: ExportOption[] | null
  loadOptions: () => void
  start: (format: ExportFormat) => void
  cancel: () => void
}

interface Handlers {
  /** An export ended - finished, failed or cancelled. */
  onEnded: (progress: ExportProgress) => void
  /** An export was refused before it started. */
  onRefused: (message: string) => void
}

/**
 * The state of exporting, for the Export menu.
 *
 * An export outlives the file it came from: opening the next file does not stop
 * it, so progress is kept here rather than on the media. Options are kept with
 * the file and audio track they were asked for, so a menu opened on the next
 * file never shows the last one's answer.
 */
export function useExport(media: OpenedMedia | null, handlers: Handlers): ExportControls {
  const [running, setRunning] = useState<ExportProgress | null>(null)
  const [asked, setAsked] = useState<{ key: string; options: ExportOption[] } | null>(null)
  const handlersRef = useRef(handlers)

  useEffect(() => {
    handlersRef.current = handlers
  })

  const id = media?.id
  const audioOrder = media?.activeAudioTrack ?? -1
  const key = `${id ?? ''}:${audioOrder}`

  useEffect(
    () =>
      window.desktop.onExportProgress((progress) => {
        if (progress.state === 'running') {
          setRunning(progress)
          return
        }
        setRunning(null)
        // Whether another export is running is part of every answer.
        setAsked(null)
        handlersRef.current.onEnded(progress)
      }),
    [],
  )

  const loadOptions = useCallback(() => {
    if (!id) return
    void window.desktop.exportOptions(id, audioOrder).then((options) => setAsked({ key, options }))
  }, [id, audioOrder, key])

  const start = useCallback(
    (format: ExportFormat) => {
      if (!id) return
      void window.desktop.startExport(id, format, audioOrder).then((result) => {
        if (!result.ok) handlersRef.current.onRefused(result.message)
      })
    },
    [id, audioOrder],
  )

  const cancel = useCallback(() => {
    if (running) void window.desktop.cancelExport(running.jobId)
  }, [running])

  return { running, options: asked?.key === key ? asked.options : null, loadOptions, start, cancel }
}
