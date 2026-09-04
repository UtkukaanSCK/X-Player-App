import type { Diagnostics, RecentEntry } from '../../shared/api'

interface Props {
  busy: boolean
  problem: string | null
  recent: RecentEntry[]
  diagnostics: Diagnostics | null
  onOpenFiles: () => void
  onOpenFolder: () => void
  onOpenRecent: (path: string) => void
  onClearRecent: () => void
}

/** Formats absolute for today, dated after that. Nobody needs "3 days ago". */
function when(at: number): string {
  const date = new Date(at)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function EmptyState({
  busy,
  problem,
  recent,
  diagnostics,
  onOpenFiles,
  onOpenFolder,
  onOpenRecent,
  onClearRecent,
}: Props) {
  return (
    <div className="empty">
      <div className="empty-main">
        <h1>Drop a video anywhere</h1>
        <p className="empty-sub">
          MKV, AVI, TS, MOV, HEVC, DTS - whatever it is, it starts playing. Nothing is converted in
          advance and nothing is written next to your file.
        </p>

        <div className="empty-actions">
          <button type="button" className="primary" onClick={onOpenFiles} disabled={busy}>
            Open a file
          </button>
          <button type="button" className="ghost" onClick={onOpenFolder} disabled={busy}>
            Open a folder
          </button>
        </div>

        {/*
          Opens Settings rather than claiming to change anything.

          The installer takes the file types nothing else had claimed, which is
          the whole of what is possible: since Windows 8 the choice for a type
          that already has an owner is protected, and an app that says it has
          changed it has either failed quietly or broken the association. So the
          offer here is a shortcut to the page, honestly labelled.
        */}
        {diagnostics && (diagnostics.platform === 'windows' || diagnostics.platform === 'macos') && (
          <p className="empty-default">
            Want every video file to open here?{' '}
            <button type="button" className="link" onClick={() => void window.desktop.openDefaultAppsSettings()}>
              Open default apps settings
            </button>
          </p>
        )}

        {problem && (
          <p className="empty-problem" role="alert">
            {problem}
          </p>
        )}
      </div>

      {recent.length > 0 && (
        <div className="empty-recent">
          <div className="empty-recent-head">
            <h2>Recent</h2>
            <button type="button" className="link" onClick={onClearRecent}>
              Clear
            </button>
          </div>
          <ul>
            {recent.map((entry) => (
              <li key={entry.path}>
                <button type="button" onClick={() => onOpenRecent(entry.path)} title={entry.path}>
                  <span className="recent-name">{entry.name}</span>
                  <span className="recent-when">{when(entry.at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {diagnostics && (
        <p className="empty-diag">
          {!diagnostics.ffmpeg ? (
            <span className="diag-bad">
              ffmpeg was not found, so only MP4 and WebM files will open.
            </span>
          ) : diagnostics.hardware ? (
            <>
              Converting on the GPU with <code>{diagnostics.encoder}</code>
              {diagnostics.hwaccel ? (
                <>
                  {' '}
                  and <code>{diagnostics.hwaccel}</code> decoding
                </>
              ) : null}
              .
            </>
          ) : (
            <>
              No hardware encoder here, so conversion runs on the CPU with{' '}
              <code>{diagnostics.encoder}</code>. Large files may need a lower quality setting.
            </>
          )}
          {/* Named rather than hidden: "NVENC is listed but does not run here"
              is the one clue that explains an unexpectedly busy CPU. */}
          {diagnostics.rejected.length > 0 && (
            <>
              {' '}
              {diagnostics.rejected.map((r) => (
                <code key={r}>{r}</code>
              ))}{' '}
              {diagnostics.rejected.length === 1 ? 'was' : 'were'} offered by ffmpeg but failed to run on
              this machine.
            </>
          )}
        </p>
      )}
    </div>
  )
}
