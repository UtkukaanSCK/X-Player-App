import type { OpenedMedia } from '../../shared/api'

interface Props {
  media: OpenedMedia | null
  busy: boolean
  position: { index: number; total: number } | null
  queueOpen: boolean
  onTop: boolean
  onToggleQueue: () => void
  onToggleOnTop: () => void
  onOpen: () => void
}

/**
 * The strip above the video.
 *
 * Its job is to answer "what is this app doing to my file right now" without
 * being asked. Most players hide that; when the fan spins up you are left
 * guessing whether something is wrong.
 */
export function StatusBar({ media, busy, position, queueOpen, onTop, onToggleQueue, onToggleOnTop, onOpen }: Props) {
  return (
    <header className="status">
      <div className="status-id">
        <span className="wordmark">
          <Mark />
          X-Player
        </span>
        {media && <span className="status-name" title={media.path}>{media.name}</span>}
        {position && (
          <span className="status-pos">
            {position.index + 1}/{position.total}
          </span>
        )}
      </div>

      <div className="status-meta">
        {busy && <span className="chip chip-busy">Opening</span>}
        {media && (
          <span className={`chip chip-${media.route}`} title={media.reason}>
            <span className="chip-dot" aria-hidden />
            {media.route === 'direct' ? 'Direct' : 'Converting'}
          </span>
        )}
        {media && (
          <span className="status-tech">
            {[media.videoCodec.toUpperCase(), media.resolution, media.audioCodec.toUpperCase()]
              .filter(Boolean)
              .map((fact, index) => (
                <span key={index}>{fact}</span>
              ))}
          </span>
        )}
        {/*
          * Two facts about the file that the interface used to keep to itself.
          *
          * A silent file left the volume control fully live, so the reasonable
          * conclusion was that the player was broken. And imageSubtitles has
          * always been computed and carried all the way here - the field exists
          * so those tracks "are not silently missing" - and then nothing ever
          * read it, which is precisely the outcome it was added to prevent.
          */}
        {media && !media.audioCodec && (
          <span className="chip chip-quiet" title="This file contains no audio stream">
            No audio
          </span>
        )}
        {media && media.imageSubtitles.length > 0 && (
          <span
            className="chip chip-quiet"
            title={`Picture-based subtitles cannot be turned into text: ${media.imageSubtitles.join(', ')}`}
          >
            {media.imageSubtitles.length} image subtitle{media.imageSubtitles.length > 1 ? 's' : ''}
          </span>
        )}
      </div>

      <div className="status-actions">
        <button type="button" className="ghost" onClick={onOpen}>
          Open
        </button>
        <button type="button" className="ghost" aria-pressed={queueOpen} onClick={onToggleQueue}>
          Queue
        </button>
        <button type="button" className="ghost" aria-pressed={onTop} onClick={onToggleOnTop}>
          On top
        </button>
      </div>
    </header>
  )
}

/**
 * The app icon at strip size: the amber cross from build/icon.png.
 *
 * The square behind it is a step lighter than the strip rather than the icon's
 * own near-black, which on a dark strip would vanish and leave a floating cross.
 */
function Mark() {
  return (
    <svg className="mark" width="18" height="18" viewBox="0 0 22 22" aria-hidden focusable="false">
      <rect width="22" height="22" rx="5.5" fill="#2c2c31" />
      <path d="M7.5 7.5l7 7M14.5 7.5l-7 7" stroke="#ffb020" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  )
}
