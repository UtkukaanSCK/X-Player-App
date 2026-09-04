import { useEffect, useState } from 'react'

export interface DragState {
  /** True while files are over the window. */
  active: boolean
  /** How many files are being carried, so the prompt can name them. */
  count: number
}

const IDLE: DragState = { active: false, count: 0 }

/**
 * Whole-window drag and drop.
 *
 * Listening on the window rather than a drop zone means the target is the
 * entire app, including the video itself - people aim at what they can see, not
 * at a dashed rectangle. The counter exists because dragenter and dragleave
 * fire for every element the pointer crosses, and a naive boolean flickers.
 */
export function useDroppedFiles(onPaths: (paths: string[]) => void): DragState {
  const [drag, setDrag] = useState<DragState>(IDLE)

  useEffect(() => {
    let depth = 0
    const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    /* Only the file entries count. A drag out of Explorer also carries text. */
    const fileCount = (e: DragEvent) =>
      Array.from(e.dataTransfer?.items ?? []).filter((item) => item.kind === 'file').length

    const settle = () => {
      depth = 0
      setDrag(IDLE)
    }

    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return
      depth += 1
      setDrag({ active: true, count: fileCount(e) })
    }
    const onOver = (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault()
    }
    const onLeave = (e: DragEvent) => {
      // Leaving the window itself reports no element being entered. Trusting the
      // counter alone leaves the prompt on screen when a drag crosses the edge
      // faster than the enter and leave events pair up.
      if (e.relatedTarget === null) return settle()
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDrag(IDLE)
    }
    const onDrop = (e: DragEvent) => {
      settle()
      if (!carriesFiles(e)) return
      e.preventDefault()
      const paths = Array.from(e.dataTransfer?.files ?? [])
        .map((file) => {
          try {
            return window.desktop.pathForFile(file)
          } catch {
            return ''
          }
        })
        .filter(Boolean)
      if (paths.length > 0) onPaths(paths)
    }

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    // A drag abandoned with Escape ends without ever leaving the window.
    window.addEventListener('dragend', settle)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', settle)
    }
  }, [onPaths])

  return drag
}
