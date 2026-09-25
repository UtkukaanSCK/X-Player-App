import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ExportFormat, ExportOption, ExportProgress, ExportRange, OpenedMedia } from '../shared/api'

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
  /** GIF was chosen with nothing selected: mark a stretch to adjust. */
  onMarkRange: () => void
}

/**
 * The state of exporting, for the Export menu.
 *
 * An export outlives the file it came from: opening the next file does not stop
 * it, so progress is kept here rather than on the media. Options are kept with
 * the file and audio track they were asked for, so a menu opened on the next
 * file never shows the last one's answer.
 */
export function useExport(
  media: OpenedMedia | null,
  range: ExportRange | null,
  handlers: Handlers,
): ExportControls {
  const [running, setRunning] = useState<ExportProgress | null>(null)
  const [asked, setAsked] = useState<{ key: string; options: ExportOption[] } | null>(null)
  const handlersRef = useRef(handlers)

  useEffect(() => {
    handlersRef.current = handlers
  })

  const id = media?.id
  const audioOrder = media?.activeAudioTrack ?? -1
  // The selection is part of the answer too: what a GIF would cost depends on it.
  const key = `${id ?? ''}:${audioOrder}:${range ? `${range.start}-${range.end}` : ''}`

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
    void window.desktop.exportOptions(id, audioOrder, range).then((options) => setAsked({ key, options }))
  }, [id, audioOrder, range, key])

  const start = useCallback(
    (format: ExportFormat) => {
      if (!id) return
      // Choosing GIF with nothing selected is how a selection is made: it marks
      // a few seconds on the bar to adjust, rather than refusing the row.
      if (format === 'gif' && !range) {
        handlersRef.current.onMarkRange()
        return
      }
      void window.desktop.startExport(id, format, audioOrder, range).then((result) => {
        if (!result.ok) handlersRef.current.onRefused(result.message)
      })
    },
    [id, audioOrder, range],
  )

  const cancel = useCallback(() => {
    if (running) void window.desktop.cancelExport(running.jobId)
  }, [running])

  const answered = asked?.key === key ? asked.options : null
  const options = useMemo(() => {
    if (!answered || range) return answered
    // Electron calls GIF unavailable without a selection, and it is right about
    // the export. The row still does something, so it is still offered.
    return answered.map((option) =>
      option.format === 'gif'
        ? { ...option, available: true, note: 'Marks three seconds on the bar to adjust' }
        : option,
    )
  }, [answered, range])

  return { running, options, loadOptions, start, cancel }
}
