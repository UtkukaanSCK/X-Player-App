import type { DragState } from '../useDroppedFiles'

interface Props {
  drag: DragState
  /** Whether something is already playing, which changes what a drop does. */
  queued: boolean
}

/**
 * Shown while files are being dragged over the window.
 *
 * The wording is the actual outcome rather than a generic invitation: a drop on
 * an empty player starts playing, and a drop while a queue exists appends to it.
 * Saying "Drop to play" in the second case would be a small lie every time.
 */
export function DropVeil({ drag, queued }: Props) {
  if (!drag.active) return null
  const many = drag.count > 1 ? `${drag.count} files` : 'file'
  return (
    <div className="veil" role="presentation">
      <div className="veil-card">{queued ? `Add ${many} to the queue` : 'Drop to play'}</div>
    </div>
  )
}
