# X-Player Desktop

Opens any video file and starts playing. No "converting, 37%" screen, no
codec pack, nothing written next to your file.

This is a separate project from the player library it uses. The library lives in
the parent folder and is consumed here as `x-player`; during development a Vite
alias points at the sibling working copy, so a change to the player shows up
here without publishing anything.

## Why an app at all

A browser cannot play most of what people actually have. Chromium accepts MP4,
WebM and Ogg containers with H.264, VP8/9, AV1, AAC, MP3, Opus, Vorbis or FLAC
inside. An H.264 video is rejected outright the moment it sits in an MKV, even
though the identical stream inside an MP4 plays.

Electron does not change that, and neither would Tauri: both use the system
webview and inherit its decoders. What opens those files is the **media gateway**
in `electron/gateway` - ffprobe to find out what the file is, ffmpeg to turn it
into something the player already understands.

## How a file gets played

`electron/gateway/plan.ts` picks the cheapest route that actually works:

| Route | When | What runs |
| --- | --- | --- |
| **Direct** | MP4/WebM/MOV with codecs the browser accepts, one audio track | Nothing. The file is served with byte ranges and played untouched |
| **Streaming** | Everything else | ffmpeg, producing HLS segments on demand |

Files with several audio tracks take the streaming route even when the browser
could play them, because Chromium offers no way to pick a track out of a plain
file. A menu that cannot switch anything is worse than the small cost of
streaming.

### What makes it start instantly

The playlist is written from the duration alone, before anything is encoded. All
of it - every segment of a two hour film - is declared up front, so hls.js has
the whole timeline from the first moment and can seek anywhere immediately.
Asking for a segment is what causes it to be produced.

Each ffmpeg run covers a two minute window and then exits; the next one starts
as playback approaches the end of the current one. That is the throttle, and it
is why the app never encodes a film nobody is watching. Segments behind the
playhead are kept for a while, so short rewinds cost nothing.

### Two things that had to be learned the hard way

**NVENC ignores `-force_key_frames` on its own.** It follows its own GOP length
instead and quietly produces ten second segments while the playlist promises
four, which sends the player's clock backwards. Stating the interval in frames
as well (`-g`, derived from the source frame rate) leaves it no room to decide.

**Copied MP3 audio drifts out of the segments.** MP3 frames hold 1152 samples
and cannot be split where a video segment ends, so the gap between the audio and
video boundaries widens until the buffer has holes and playback stops dead at
the seam. Only AAC is copied into a segment; everything else is re-encoded,
which costs almost nothing next to the video.

### What it costs

Video is always re-encoded on the streaming route, even when the codec would
have been fine. Copying it would tie segment boundaries to the source keyframes,
and finding those means scanning the file for several seconds - which is exactly
the wait this app exists to avoid. A mismatch there makes seeking land in the
wrong place, which is worse than a generation of quality loss. On hardware with
an encoder this is close to free; without one the app says so and offers a
resolution ceiling.

## Getting files in, and the queue

Files arrive four ways, and all four end at the same place: drop them anywhere on
the window, use **Open a file** or **Open a folder**, double-click one in
Explorer, or launch the app a second time with a file as its argument.

The drop target is the whole window, including the video itself. A drop zone
drawn as a dashed rectangle asks people to aim at something other than what they
can see. The prompt that appears while files are over the window says what a drop
will actually do rather than a generic invitation - a drop onto an empty player
starts playing, and a drop while a queue exists appends to it, so it reads
"Add 3 files to the queue" in the second case.

Dropping a folder queues everything playable inside it, sorted so that
"Episode 2" comes before "Episode 10". Dropping a file already in the queue says
so instead of adding a second row that cannot be told apart from the first: a
path is a row's identity here.

Rows can be reordered by dragging one onto the gap it should sit in, or with
**Alt** and the arrow keys, which is the same reach without a mouse.

The playback keys work from anywhere in the window. The player library binds its
shortcuts to the player element so an embedded player never steals the host
page's keys; that is right on a web page and wrong here, where the window is
nothing but a player - clicking **Queue** used to leave Space toggling that
button instead of playback. The app forwards the keystroke to the player rather
than reimplementing the shortcuts, and leaves Alt, Ctrl and Meta alone.

Volume and speed are remembered across files and launches. They belong to the
viewer rather than to any one film, and the player is rebuilt for every file, so
without this every episode started at full volume however quietly the last one
was playing. Mute deliberately is not remembered - it is a momentary thing, and a
file that opens silent for no reason you can name is worse than re-pressing M.
Wanting silence is volume 0, which is remembered. Two things
that reordering deliberately does *not* do:

- **Change what is playing.** The mark that says which row is open follows the
  file, not the slot. Dragging the row you are watching to the bottom of a queue
  moves the row and leaves the picture alone.
- **Raise the file-drop prompt.** The rows carry a private drag type, and the
  window-wide drop listens only for `Files`, so shuffling a queue never dims the
  app as though something were about to be opened.

## Security

The gateway is an HTTP server on your machine that can read files, so it is
built to be uninteresting to anything else:

- Bound to `127.0.0.1` on a port the OS picks, with a fresh 64-character token
  each launch. No token, no answer.
- URLs carry opaque ids, never paths. A request cannot name a file that was
  never opened.
- The `Host` header is checked, so a page that resolves its own name to
  127.0.0.1 still gets nothing.
- The window runs sandboxed with context isolation on and node integration off,
  and reaches the outside world only through the narrow bridge in `preload.ts`.

`e2e/security.mjs` asserts every one of these against the running app.

## Running it

Requires ffmpeg and ffprobe on `PATH` in development. Packaged builds carry
their own copies.

```bash
npm install
npm run dev        # Vite with hot reload, Electron pointed at it
npm run start      # build, then run the way a user would
```

Changing anything under `electron/` needs a restart: the main process cannot
reload itself.

## Hardware, and how it is decided

The app measures what this machine can do rather than assuming it. Being listed
by `ffmpeg -encoders` only means the build was compiled with support: NVENC is
listed on a laptop with no NVIDIA card, QSV on a desktop with the iGPU turned
off in the BIOS. So each candidate is asked to encode two frames, in order, and
the first that actually succeeds is the one used:

| | Encoder | Decode |
| --- | --- | --- |
| NVIDIA, any OS | `h264_nvenc` | `cuda` |
| Apple Silicon and Intel Macs | `h264_videotoolbox` | `videotoolbox` |
| Intel iGPU | `h264_qsv` | `qsv` |
| AMD on Windows | `h264_amf` | `d3d11va` |
| Anything else | `libx264` | none |

Flags are probed the same way, because the same encoder does not take the same
options in every ffmpeg build - VideoToolbox accepts constant quality on some
and only a bitrate on others. A build that refuses the good flags still gets
hardware encoding rather than quietly dropping the machine to software.

VAAPI is deliberately absent. Encoding through it needs a device flag and a
hwupload filter chain this code does not build, so a Linux machine without NVENC
or QSV falls back to x264 and the app says so on the opening screen.

Whatever is decided is written to the user's data directory and keyed by the
ffmpeg build, so only the first ever launch pays for the probe. Swap the binary
and it measures again.

## Tests

```bash
npm run fixtures   # builds the test files with ffmpeg, from the player's demo clip
npm run e2e
```

Three suites run: `playback` opens each fixture and measures it, `queue` drives
the list and its reordering, and `security` prods the gateway from the page.

The fixtures are produced locally, so the suite has no network dependency and
the files cannot change underneath it. Each one exercises a different reason a
browser refuses a file: H.264 in the wrong container, HEVC 10-bit with AC-3,
MPEG-4 ASP in AVI, MPEG-2 in a transport stream, and a VP9 file that must not be
converted at all.

What the suite measures is not that a video element exists. It plays each file
for twenty seconds, samples the clock four times a second, and fails if playback
ever paused for more than 500 ms. It seeks to 75% and checks that frames flow
again within a second and that it landed where it was asked.

Reported timings from a run on an RTX 5060 Ti:

| | first frame |
| --- | --- |
| Direct route | ~0.7 s |
| Streaming route | ~1.5 s |

About half a second of the streaming figure is ffprobe's own startup: on this
machine `ffprobe -version` costs as much as probing a film, while spawning a
trivial process costs 16 ms. That floor belongs to the binary, not to this code.
Opening a file that is already open skips it.

## Packaging

```bash
npm run ffmpeg       # copies ffmpeg and ffprobe from PATH into resources/
npm run dist         # for the platform you are on
npm run dist:win     # NSIS installer
npm run dist:mac     # dmg and zip, arm64 and x64
npm run dist:linux   # AppImage and deb
```

ffmpeg is staged from the machine doing the build rather than downloaded, so the
binaries that ship are the ones the tests were run against and build day does not
depend on a third party being up. The cost of that choice is that **each platform
has to be built on itself** - there is no cross-building here, and producing a
macOS package on Windows would put Windows binaries inside it.

`electron-builder.yml` registers the file associations for all three, so a
double-clicked `.mkv` opens here. On Linux that works from the `.deb`; an
AppImage registers nothing unless the desktop has `appimaged` or the user
integrates it by hand.

### Size

Measured, from a Windows build with the full GPL ffmpeg used here:

| | |
| --- | --- |
| `X-Player-1.0.0-Setup.exe` | **188 MB** |
| Unpacked | 679 MB, of which 286 MB is ffmpeg |

ffmpeg dominates: 143 MB per binary, twice. Nothing in the app needs the full
GPL build - it uses H.264, AAC and the common decoders - so a leaner ffmpeg cuts
this sharply. Put one first on `PATH` before `npm run ffmpeg`, or point
`XPLAYER_FFMPEG` and `XPLAYER_FFPROBE` at it.

### Releasing

```bash
npm run preflight   # everything that has to be true first
npm run release     # preflight, build, and publish a draft
```

Preflight checks the things that only surface after an installer is in
someone's hands: a missing icon, an ffmpeg that cannot start, a version on the
download page that does not match the one being built.

`.github/workflows/release.yml` builds all three platforms on a `v*` tag and
attaches the artefacts to a draft release. It exists because there is no
cross-building, so without it only the platform on your desk can ever ship.
**It has never been run** - the first go should be a `workflow_dispatch` on a
throwaway tag rather than a real release.

The workflow fetches a **static** ffmpeg per platform rather than using the
runner's package manager. What `brew` or `apt` installs is linked against
libraries that exist on that runner and nowhere else, so a package built with it
dies on a user's machine with a missing library and looks like the app is
broken. `stage-ffmpeg.mjs` inspects the staged binaries with `otool` and `ldd`
and fails the build rather than shipping one of those.

Those sources publish rolling builds, not stable versioned URLs, so the ffmpeg
that ships is whatever was current on build day. The binaries are run before
packaging, which is the part that can be checked.

### macOS signing

The mac build is unsigned: this project has no Apple Developer identity. It runs,
but Gatekeeper blocks the first launch, and the way through is right-click, Open,
then Open again. Anything else would need a paid identity and notarisation.

## File associations, and what "default" can mean

The installer asks. A page after the install location offers **Open video files
with X-Player**, ticked by default; leaving it unticked still puts X-Player in
the "Open with" menu without taking anything over.

Ticking it claims MKV, MP4, AVI, MOV, WebM, M4V, TS, M2TS, WMV, FLV, MPG and
MPEG — **for the types that do not already have an owner**. That limit is not a
shortcut:

> Since Windows 8 the default for a file type lives behind a hashed `UserChoice`
> key, specifically so applications cannot set it for you. Installers that claim
> to make themselves the default for an already-claimed type are either failing
> quietly or corrupting the association until Windows resets it.

So the app does the two things that are real. The installer registers
`Capabilities` and `RegisteredApplications`, without which Windows will not
list the app under Settings › Default apps at all. And the opening screen offers
one click through to that page, labelled as what it is — a shortcut to where you
decide, not a claim to have decided for you.

Uninstalling removes both registry entries.

## Known limits

- **Only the Windows build has been run.** The code is written for all three and
  the packaging targets exist for all three, but macOS and Linux have not been
  executed once - not the packages, not the encoders, not the file associations.
  Treat them as untested rather than working. The encoder probe is the reason to
  expect them to behave: it measures instead of assuming, so a machine this code
  has never seen still lands on something that runs.
- The installer's association page has been compiled but not stepped through:
  the NSIS script builds clean and the installer is produced, but nobody has run
  it and confirmed the checkbox behaves.
- Image-based subtitles (PGS, VOBSUB) cannot become WebVTT. They are listed and
  marked, not silently dropped.
- ASS and SSA subtitles keep their text and lose their styling.
- No library, no metadata fetching, no ISO or DRM support.
