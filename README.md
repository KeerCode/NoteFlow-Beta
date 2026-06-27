# Noteflow

A free, open-source vibe-coded note-by-note piano practice desktop app built with Tauri. Upload any MusicXML file or try a built-in demo piece, and Noteflow will guide you through each note using real-time pitch detection from your microphone or MIDI keyboard.

Everything is run locally and currently, no progress is saved.

No paywall. No account. Just play.

## Features

- **Sheet music rendering** — Upload `.xml`, `.musicxml`, or `.mxl` files rendered via AlphaTab with cursor tracking
- **Built-in demo pieces** — Start practicing immediately with included beginner and intermediate pieces
- **Strict practice mode** — Must play exactly the target note(s) with no extra keys, then release to advance
- **Chord support** — Detects and requires full chords (all notes held simultaneously)
- **Tied note handling** — Notes connected by ties are automatically skipped
- **Interval display** — Shows the interval between consecutive notes (Minor 3rd, Perfect 5th, etc.)
- **Wrong note hints** — After 3 wrong attempts, Noteflow plays the target note for you
- **Microphone detection** — ML-powered polyphonic pitch detection via Spotify's Basic Pitch
- **MIDI keyboard support** — Connect a MIDI keyboard for instant, precise note detection
- **Listen mode** — Play back the full piece with cursor following along
- **Playback speed control** — Slow down or speed up playback (25%–200%)
- **Any-octave mode** — Optional toggle to accept correct note name regardless of octave
- **Auto-scroll** — Sheet music scrolls to keep the current bar visible
- **Progress tracking** — Note and measure progress with a visual progress bar

## Known Limitations

- **Microphone detection is a bit slow** — Basic Pitch runs ML inference in the browser, so there is roughly a 250–500ms delay between playing a note and detection. For the most responsive experience, use a MIDI keyboard.
- **Mic may hallucinate notes occasionally** — Especially octave doublings on lower notes. Thresholds are tuned conservatively but not perfect.
- **macOS microphone access** — Tauri's WKWebView requires codesigned entitlements for mic access. Use `npm run tauri:mic` to build with the correct entitlements (see below).
- **Right hand only** — The MusicXML parser reads the first `<part>` only (typically treble clef / right hand). Both hands are rendered visually.

## Download

Go to the [Releases](https://github.com/KeerCode/NoteFlow-Beta/releases) page and download the latest version for your platform:

| Platform | File | Notes |
|---|---|---|
| **macOS (Apple Silicon)** | `.dmg` (arm64) | Open the `.dmg` and drag Noteflow to Applications |
| **macOS (Intel)** | `.dmg` (x64) | Open the `.dmg` and drag Noteflow to Applications |
| **Windows** | `.msi` or `.exe` | Run the installer |

> **macOS note:** The app is not notarized, so on first launch you may need to right-click the app and select **Open**, then click **Open** again in the dialog. You only need to do this once.

## Build from Source

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install) (for Tauri)
- [Tauri CLI prerequisites](https://v2.tauri.app/start/prerequisites/)

### Clone & Run

1. Clone the repository:
   ```bash
   git clone https://github.com/KeerCode/NoteFlow-Beta.git
   cd NoteFlow-Beta/NoteFlow
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the app in dev mode:
   ```bash
   npm run tauri dev
   ```

### Build for macOS (with microphone support)

```bash
# Build, codesign with mic entitlements, and open
npm run tauri:mic
```

This runs a debug build, codesigns the app with `Entitlements.plist` (which includes `com.apple.security.device.audio-input`), and opens it.

### Production build

```bash
npm run tauri build
```

## Tech Stack

| Technology | Purpose |
|---|---|
| [Tauri 2](https://v2.tauri.app) | Desktop app framework (Rust backend + webview) |
| [React](https://react.dev) | UI framework |
| [Vite](https://vite.dev) | Build tool & dev server |
| [Tailwind CSS](https://tailwindcss.com) | Styling |
| [AlphaTab](https://alphatab.net) | Sheet music rendering, playback, and cursor |
| [Basic Pitch](https://github.com/spotify/basic-pitch) | ML-powered polyphonic pitch detection (Spotify) |
| Web MIDI API | MIDI keyboard input (via Tauri) |

## How It Works

1. **MusicXML parsing** — Notes are parsed directly from the MusicXML file (not from AlphaTab events). The parser handles chords, ties, rests, grace notes, forward/backup elements, and scales ticks to AlphaTab's internal 960-per-quarter system.
2. **AlphaTab** — Used only for rendering sheet music, playback audio, and cursor display. Not used for note data.
3. **Practice mode** — Compares held notes against the target. Requires an exact match (all target notes held, no extras) and waits for full release before advancing. Tied notes are auto-skipped.
4. **Pitch detection** — Basic Pitch (Spotify's ML model) runs at 22050Hz with a 0.5s buffer and 250ms inference interval. An octave ghost filter removes harmonic doublings.

## Finding Sheet Music

Public domain MusicXML files can be found at:

- [IMSLP](https://imslp.org) — Large collection of public domain scores
- [MuseScore](https://musescore.com) — Community-uploaded scores exportable as MusicXML

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run the build to check for errors (`npm run build`)
5. Commit and push your branch
6. Open a pull request

## License

MIT
