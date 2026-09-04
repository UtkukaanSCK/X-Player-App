import { useEffect, useRef, useState } from 'react'

interface Props {
  items: string[]
  index: number
  onPick: (index: number) => void
  onAdd: () => void
  onClear: () => void
  /** Moves the item at `from` so it sits before the original slot `to`. */
  onReorder: (from: number, to: number) => void
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/**
 * The queue, reorderable by dragging a row onto the gap it should sit in.
 *
 * The rows carry a private drag type. The window-wide file drop listens for
 * "Files" and ignores anything else, so dragging a row never raises the
 * drop-a-file prompt over the whole app.
 */
const ROW_TYPE = 'application/x-xplayer-queue-row'

export function Queue({ items, index, onPick, onAdd, onClear, onReorder }: Props) {
  /** The row being dragged, and the gap it would land in. */
  const [from, setFrom] = useState<number | null>(null)
  const [at, setAt] = useState<number | null>(null)
  const listRef = useRef<HTMLOListElement | null>(null)
  /** Where the focus belongs once the reordered list has rendered. */
  const focusRef = useRef<number | null>(null)

  useEffect(() => {
    const row = focusRef.current
    if (row === null) return
    focusRef.current = null
    listRef.current?.querySelectorAll<HTMLButtonElement>('.queue-row')[row]?.focus()
  }, [items])

  /** True when the move was a real one, so the caller can undo its intent. */
  const move = (source: number, target: number) => {
    if (target === source || target === source + 1) return false
    onReorder(source, target)
    return true
  }

  /* A dragged row is under the pointer, but a row moved with the keyboard has
     to be followed or the next keystroke lands somewhere else entirely. */
  const moveByKey = (source: number, target: number) => {
    focusRef.current = target > source ? target - 1 : target
    if (!move(source, target)) focusRef.current = null
  }

  const end = () => {
    setFrom(null)
    setAt(null)
  }

  return (
    <aside className="queue" aria-label="Playback queue">
      <div className="queue-head">
        <h2>Queue</h2>
        <div className="queue-head-actions">
          <button type="button" className="link" onClick={onAdd}>
            Add
          </button>
          <button type="button" className="link" onClick={onClear} disabled={items.length < 2}>
            Clear
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="queue-empty">Drop a folder to queue everything in it.</p>
      ) : (
        <>
          <ol className="queue-list" ref={listRef} onDragLeave={() => setAt(null)}>
            {items.map((path, i) => (
              <li
                key={path}
                aria-current={i === index ? 'true' : undefined}
                data-dragging={from === i ? 'true' : undefined}
                data-drop={at === i ? 'before' : at === i + 1 && i === items.length - 1 ? 'after' : undefined}
                draggable={items.length > 1}
                onDragStart={(e) => {
                  setFrom(i)
                  e.dataTransfer.effectAllowed = 'move'
                  // Some value has to be set or Firefox refuses to start a drag.
                  e.dataTransfer.setData(ROW_TYPE, String(i))
                }}
                onDragEnd={end}
                onDragOver={(e) => {
                  if (from === null) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  // The gap nearest the pointer, so a row can be sent to the end.
                  const box = e.currentTarget.getBoundingClientRect()
                  setAt(e.clientY < box.top + box.height / 2 ? i : i + 1)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  /*
                   * Everything a drop needs is taken off the event.
                   *
                   * Reading the gap out of state instead meant trusting that the
                   * last dragover had already been rendered. A drop landing in
                   * the same tick as that dragover read a stale value and did
                   * nothing at all - silently, which is the worst version of it.
                   * The row being dragged travels in the dataTransfer, which is
                   * what it is for, and the gap is measured here.
                   */
                  const carried = e.dataTransfer.getData(ROW_TYPE)
                  const source = carried === '' ? from : Number(carried)
                  if (source === null || !Number.isInteger(source)) return
                  const box = e.currentTarget.getBoundingClientRect()
                  move(source, e.clientY < box.top + box.height / 2 ? i : i + 1)
                  end()
                }}
              >
                <button
                  type="button"
                  className="queue-row"
                  onClick={() => onPick(i)}
                  title={path}
                  onKeyDown={(e) => {
                    // Dragging is the obvious way and the only one that needs a
                    // mouse; these give the same reach from the keyboard.
                    if (!e.altKey || items.length < 2) return
                    if (e.key === 'ArrowUp' && i > 0) {
                      e.preventDefault()
                      moveByKey(i, i - 1)
                    } else if (e.key === 'ArrowDown' && i < items.length - 1) {
                      e.preventDefault()
                      moveByKey(i, i + 2)
                    }
                  }}
                >
                  <span className="queue-num">{String(i + 1).padStart(2, '0')}</span>
                  <span className="queue-name">{fileName(path)}</span>
                </button>
              </li>
            ))}
          </ol>
          {items.length > 1 && <p className="queue-hint">Drag to reorder, or Alt with the arrow keys.</p>}
        </>
      )}
    </aside>
  )
}
