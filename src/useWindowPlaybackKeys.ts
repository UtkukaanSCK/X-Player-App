import { useEffect } from 'react'

/**
 * The keys the player owns, copied from the library's own switch so the two
 * cannot drift apart silently.
 */
const PLAYBACK_KEYS = new Set([
  ' ', 'k', 'K',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'j', 'J', 'l', 'L',
  'm', 'M', 'f', 'F', 'i', 'I', 'c', 'C',
  '<', ',', '>', '.',
  'Home', 'End',
])

function isDigit(key: string): boolean {
  return key.length === 1 && key >= '0' && key <= '9'
}

/** Somewhere a keystroke means text, not a command. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * Makes the playback keys work from anywhere in the window.
 *
 * The library binds its shortcuts to the player element on purpose, so an
 * embedded player never steals the host page's keys. That is right for a web
 * page and wrong here: in a desktop app the window *is* the player, and clicking
 * "Queue" or tabbing to a row left Space toggling that button instead of
 * playback, with nothing to return focus but clicking the video.
 *
 * Rather than reimplement the shortcuts, this hands the keystroke to the element
 * that already knows them: focus the player, re-dispatch, let the library
 * decide. Alt, Ctrl and Meta are left alone - Alt with the arrows reorders the
 * queue, and the rest belong to the window manager.
 */
export function useWindowPlaybackKeys(playerRoot: () => HTMLElement | null) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
      if (!PLAYBACK_KEYS.has(e.key) && !isDigit(e.key)) return
      if (typing(e.target)) return

      const root = playerRoot()
      // Inside the player already: the library's own listener has it.
      if (!root || (e.target instanceof Node && root.contains(e.target))) return

      e.preventDefault()
      root.focus({ preventScroll: true })
      root.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, code: e.code, bubbles: true }))
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [playerRoot])
}
