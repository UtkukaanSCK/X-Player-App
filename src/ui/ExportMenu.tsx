import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ExportOption } from '../../shared/api'
import type { ExportControls } from '../useExport'

interface Props {
  controls: ExportControls
  /** False when nothing is open. A running export can still be watched and cancelled. */
  canExport: boolean
  /** Given only while a stretch is marked on the seek bar. */
  onClearRange?: () => void
}

/**
 * Save a copy of the open file in another format, from beside its name.
 *
 * Not "Convert": the strip already uses that word for how a file is being
 * played, and a person reading "Converting" there should never wonder whether
 * something is being written to their disk.
 *
 * A menu button in the WAI-ARIA sense. The keys it handles are kept from the
 * window, which otherwise sends arrows, space and letters to the player - so
 * moving through the menu never seeks or pauses the video behind it.
 */
export function ExportMenu({ controls, canExport, onClearRange }: Props) {
  const { running, options, loadOptions, start, cancel } = controls
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  /** Which end the menu opens at: the last row when it was ArrowUp that opened it. */
  const openAt = useRef<'first' | 'last'>('first')

  const percent = running ? Math.round(running.fraction * 100) : 0
  // The button's text is its accessible name, and a name that changes four
  // times a second is read out four times a second. Steps of five are enough
  // to show it is moving.
  const coarse = Math.round(percent / 5) * 5

  const items = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
  const focusItem = (index: number) => {
    const list = items()
    if (list.length > 0) list[(index + list.length) % list.length].focus()
  }

  const close = (returnFocus: boolean) => {
    openAt.current = 'first'
    setOpen(false)
    if (returnFocus) buttonRef.current?.focus()
  }

  // What the file can become is asked each time, since the answer changes with
  // the audio track and with whether an export is already running.
  const busy = running !== null
  useEffect(() => {
    if (open && !busy && canExport) loadOptions()
  }, [open, busy, canExport, loadOptions])

  // Focus enters the menu when it opens, and follows what it holds when that
  // changes under it - but only when it is not already on a row, so an export
  // ending elsewhere never drags focus back to the first format.
  const contents = running ? 'running' : options ? 'options' : 'loading'
  useEffect(() => {
    if (!open) return
    const active = document.activeElement
    if (active && menuRef.current?.contains(active) && active.getAttribute('role') === 'menuitem') return
    const list = items()
    if (list.length === 0) menuRef.current?.focus()
    else list[openAt.current === 'last' ? list.length - 1 : 0].focus()
  }, [open, contents])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current?.contains(event.target as Node)) return
      // Focus is on a row that is about to be removed, so it is handed back
      // rather than left on the body, where the next Tab starts over.
      close(!!menuRef.current?.contains(document.activeElement))
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  // The strip is a window drag region, and a drag region swallows the click
  // that would otherwise close the menu. While the menu is open the strip is
  // an ordinary surface again, so clicking beside it behaves as it looks.
  useEffect(() => {
    if (!open) return
    document.documentElement.classList.add('menu-open')
    return () => document.documentElement.classList.remove('menu-open')
  }, [open])

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'Escape') {
      if (!open) return
      event.preventDefault()
      close(true)
      return
    }
    // ArrowUp as well as ArrowDown: on a menu button both open it, and either
    // one left unhandled is a key the window hands to the player instead.
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openAt.current = event.key === 'ArrowUp' ? 'last' : 'first'
      setOpen(true)
    }
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      // Focus goes to the button first: Tab then carries on from there, to the
      // next control in the strip, instead of from wherever the browser puts
      // it once the row holding focus is removed.
      close(true)
      return
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    const list = items()
    const at = list.indexOf(document.activeElement as HTMLElement)
    switch (event.key) {
      case 'ArrowDown':
        focusItem(at + 1)
        break
      case 'ArrowUp':
        focusItem(at - 1)
        break
      case 'Home':
        focusItem(0)
        break
      case 'End':
        focusItem(list.length - 1)
        break
      case 'Escape':
        close(true)
        break
      case 'Enter':
      case ' ':
        ;(document.activeElement as HTMLElement | null)?.click()
        break
    }
  }

  const choose = (option: ExportOption) => {
    if (!option.available) return
    start(option.format)
    close(true)
  }

  return (
    <div className="export" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="ghost export-button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!canExport && !running}
        title={running ? `${running.sourceName} → ${running.outputName}` : 'Save a copy of this file in another format'}
        onClick={() => {
          openAt.current = 'first'
          setOpen((value) => !value)
        }}
        onKeyDown={onButtonKeyDown}
      >
        {running ? `Exporting ${coarse}%` : 'Export'}
        <svg className="export-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden focusable="false">
          <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          ref={menuRef}
          className="export-menu"
          role="menu"
          aria-label="Export"
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
        >
          {running ? (
            <>
              {/*
                * A group, not a menuitem: it cannot be chosen, and a row that
                * holds focus while its percentage climbs is read out again on
                * every reading. The Cancel below it is what focus lands on.
                */}
              <div className="export-status" role="group" aria-label={`${running.outputName}, ${coarse} percent`}>
                <span className="export-status-name">{running.outputName}</span>
                <span className="export-status-percent">{percent}%</span>
                <span className="export-bar" aria-hidden>
                  <span style={{ transform: `scaleX(${running.fraction})` }} />
                </span>
              </div>
              <button
                type="button"
                className="export-item export-cancel"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  cancel()
                  close(true)
                }}
              >
                Cancel export
              </button>
            </>
          ) : options && options.length > 0 ? (
            <>
              {options.map((option) => (
                <button
                  key={option.format}
                  type="button"
                  className="export-item"
                  role="menuitem"
                  tabIndex={-1}
                  aria-disabled={!option.available}
                  onClick={() => choose(option)}
                >
                  <span className="export-format">{option.label}</span>
                  <span className="export-note">{option.note}</span>
                </button>
              ))}
              {onClearRange && (
                <button
                  type="button"
                  className="export-item"
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => {
                    onClearRange()
                    close(true)
                  }}
                >
                  <span className="export-format">Clear</span>
                  <span className="export-note">Takes the marked stretch off the bar</span>
                </button>
              )}
            </>
          ) : (
            <div className="export-status" role="group">
              {options ? 'There is nothing to export' : 'Checking what this file can become…'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
