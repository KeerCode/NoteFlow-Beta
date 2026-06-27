import { useState, useRef, useEffect, useCallback } from 'react'
import * as alphaTab from '@coderline/alphatab'
import { DEMO_PIECES } from './demoScores'
import { enableMidi, listenToDevice, notesMatch, onDevicesChanged } from './midiInput'
import { startBasicPitchDetection, loadBasicPitchModel, isBasicPitchReady } from './pitchDetector'

const ADVANCE_COOLDOWN_MS = 150
const HINT_DELAY_MS = 3000
const MAX_WRONG_ATTEMPTS = 3
const ALPHATAB_TICKS_PER_QUARTER = 960

const INTERVAL_NAMES = [
  'Unison', 'Minor 2nd', 'Major 2nd', 'Minor 3rd', 'Major 3rd',
  'Perfect 4th', 'Tritone', 'Perfect 5th', 'Minor 6th', 'Major 6th',
  'Minor 7th', 'Major 7th', 'Octave',
]

/** Convert note name like "C#3" to a MIDI-like number for interval math */
function noteToMidi(name) {
  const m = name.match(/^([A-G])(#|b)?(\d+)$/)
  if (!m) return null
  const BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  let semi = BASE[m[1]]
  if (semi == null) return null
  if (m[2] === '#') semi++
  else if (m[2] === 'b') semi--
  return semi + (parseInt(m[3]) + 2) * 12 // +2 to match MIDI convention
}

/** Get interval name between two note names (uses lowest note of each entry) */
function getInterval(prevNotes, curNotes) {
  if (!prevNotes?.length || !curNotes?.length) return null
  const a = noteToMidi(prevNotes[0])
  const b = noteToMidi(curNotes[0])
  if (a == null || b == null) return null
  const diff = Math.abs(b - a)
  if (diff > 12) return `${INTERVAL_NAMES[diff % 12]} +${Math.floor(diff / 12)}oct`
  return INTERVAL_NAMES[diff] ?? `${diff} semitones`
}

// ---------------------------------------------------------------------------
// MusicXML parser — single source of truth for note data
// ---------------------------------------------------------------------------

/**
 * Parse note timeline directly from MusicXML string.
 * Returns { timeline, divisions } where timeline entries have:
 *   { tick, measure, notes: string[] }
 * Ticks are scaled to AlphaTab's 960-per-quarter system for direct comparison.
 * Only parses the first <part> (right hand / treble clef).
 */
function parseNoteTimeline(xmlString) {
  if (!xmlString || typeof xmlString !== 'string') return { timeline: [], divisions: 1 }

  const parser = new DOMParser()
  const doc = parser.parseFromString(xmlString, 'text/xml')

  const part = doc.querySelector('part')
  if (!part) return { timeline: [], divisions: 1 }

  const measures = part.querySelectorAll('measure')
  const timeline = []
  let currentTick = 0
  let divisions = 1

  measures.forEach((measure, measureIndex) => {
    const divEl = measure.querySelector('attributes > divisions')
    if (divEl) divisions = parseInt(divEl.textContent) || 1

    let measureTick = currentTick
    const children = measure.children

    for (let i = 0; i < children.length; i++) {
      const el = children[i]

      // Handle <forward> and <backup> elements
      if (el.tagName === 'forward') {
        const dur = parseInt(el.querySelector('duration')?.textContent) || 0
        measureTick += (dur / divisions) * ALPHATAB_TICKS_PER_QUARTER
        continue
      }
      if (el.tagName === 'backup') {
        const dur = parseInt(el.querySelector('duration')?.textContent) || 0
        measureTick -= (dur / divisions) * ALPHATAB_TICKS_PER_QUARTER
        continue
      }

      if (el.tagName !== 'note') continue

      const duration = parseInt(el.querySelector('duration')?.textContent) || 0
      const isRest = !!el.querySelector('rest')
      const isChord = !!el.querySelector('chord')

      // Skip grace notes (no duration)
      if (el.querySelector('grace')) continue

      if (!isRest) {
        const pitchEl = el.querySelector('pitch')
        if (!pitchEl) {
          if (!isChord) measureTick += (duration / divisions) * ALPHATAB_TICKS_PER_QUARTER
          continue
        }

        const step = pitchEl.querySelector('step')?.textContent || ''
        const xmlOctave = parseInt(pitchEl.querySelector('octave')?.textContent || '4')
        // MusicXML uses middle C = C4, but MIDI/mic detection uses middle C = C3
        // Subtract 1 to align with MIDI convention (octave = midi/12 - 2)
        const octave = xmlOctave - 1
        const alter = pitchEl.querySelector('alter')?.textContent
        const accidental = alter === '1' ? '#' : alter === '-1' ? 'b' : ''
        const noteName = step + accidental + octave

        // Check for ties
        const ties = el.querySelectorAll('tie')
        let hasTieStop = false, hasTieStart = false
        ties.forEach(t => {
          if (t.getAttribute('type') === 'stop') hasTieStop = true
          if (t.getAttribute('type') === 'start') hasTieStart = true
        })

        // Skip notes that only stop a tie (the continuation — not a new note)
        if (hasTieStop && !hasTieStart) {
          if (!isChord) measureTick += (duration / divisions) * ALPHATAB_TICKS_PER_QUARTER
          continue
        }

        if (isChord) {
          if (timeline.length > 0) {
            const prev = timeline[timeline.length - 1]
            if (!prev.notes.includes(noteName)) {
              prev.notes.push(noteName)
            }
            // If any chord tone starts a tie, mark the whole entry
            if (hasTieStart) prev.isTied = true
          }
        } else {
          timeline.push({
            tick: Math.round(measureTick),
            measure: measureIndex + 1,
            notes: [noteName],
            isTied: hasTieStart, // this note ties into the next
          })
          measureTick += (duration / divisions) * ALPHATAB_TICKS_PER_QUARTER
        }
      } else if (!isChord) {
        measureTick += (duration / divisions) * ALPHATAB_TICKS_PER_QUARTER
      }
    }

    currentTick = measureTick
  })

  return { timeline, divisions }
}

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------

function App() {
  const [musicXml, setMusicXml] = useState(null)
  const [filename, setFilename] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [mode, setMode] = useState('idle') // 'idle' | 'listen' | 'practice'
  const [currentNoteIndex, setCurrentNoteIndex] = useState(0)
  const [noteTimeline, setNoteTimeline] = useState([])
  const [detectedNote, setDetectedNote] = useState(null)
  const [completed, setCompleted] = useState(false)
  const [paused, setPaused] = useState(false)
  const [showDemoModal, setShowDemoModal] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showHint, setShowHint] = useState(false)
  const [bpm, setBpm] = useState(null)
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0)
  const [playerReady, setPlayerReady] = useState(false)
  const [playerProgress, setPlayerProgress] = useState(0)
  const [inputError, setInputError] = useState(null)
  const [micPermission, setMicPermission] = useState(null)
  const [showMicPrompt, setShowMicPrompt] = useState(false)

  // Input state
  const [midiSupported, setMidiSupported] = useState(null)
  const [midiDevices, setMidiDevices] = useState([])
  const [selectedDeviceId, setSelectedDeviceId] = useState(null)
  const [anyOctave, setAnyOctave] = useState(false)
  const [inputMode, setInputMode] = useState('midi')
  const [autoscroll, setAutoscroll] = useState(true)
  const [modelLoading, setModelLoading] = useState(false)
  const [modelReady, setModelReady] = useState(false)
  const [showDebug, setShowDebug] = useState(false)
  const [debugLog, setDebugLog] = useState([])

  const fileInputRef = useRef(null)
  const alphaTabRef = useRef(null)
  const apiRef = useRef(null)
  const stopListenerRef = useRef(null)
  const stopMicRef = useRef(null)
  const advanceCooldownRef = useRef(false)
  const wrongTimerRef = useRef(null)

  const currentNoteIndexRef = useRef(0)
  const noteTimelineRef = useRef([])
  const completedRef = useRef(false)
  const pausedRef = useRef(false)
  const anyOctaveRef = useRef(false)
  const modeRef = useRef('idle')
  const heldNotesRef = useRef(new Set())
  const waitingForReleaseRef = useRef(false) // true = correct note played, waiting for release to advance
  const wrongCountRef = useRef(0) // counts wrong attempts for current note
  const lastTickSetRef = useRef(-1)
  const autoscrollRef = useRef(true)
  const playbackSpeedRef = useRef(1.0)

  useEffect(() => { currentNoteIndexRef.current = currentNoteIndex }, [currentNoteIndex])
  useEffect(() => { noteTimelineRef.current = noteTimeline }, [noteTimeline])
  useEffect(() => { completedRef.current = completed }, [completed])
  useEffect(() => { pausedRef.current = paused }, [paused])
  useEffect(() => { anyOctaveRef.current = anyOctave }, [anyOctave])
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => { autoscrollRef.current = autoscroll }, [autoscroll])
  useEffect(() => { playbackSpeedRef.current = playbackSpeed }, [playbackSpeed])

  // Reset hint on note change
  useEffect(() => {
    setShowHint(false)
    clearTimeout(wrongTimerRef.current)
    wrongTimerRef.current = null
  }, [currentNoteIndex])

  // Debug log helper
  const pushDebug = useCallback((type, data) => {
    const entry = { time: Date.now(), type, data }
    console.log(`[NF-DEBUG] ${type}:`, data)
    setDebugLog((prev) => [...prev.slice(-4), entry])
  }, [])

  // Toggle debug panel with "D" key
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'd' && !e.metaKey && !e.ctrlKey && !e.altKey && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
        setShowDebug((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Preload SoundFont
  useEffect(() => {
    fetch('./soundfont/sonivox.sf2', { cache: 'force-cache' }).catch(() => {})
  }, [])

  // Preload Basic Pitch model when mic mode is selected
  useEffect(() => {
    if (inputMode !== 'mic') return
    if (isBasicPitchReady()) {
      setModelReady(true)
      return
    }
    setModelLoading(true)
    loadBasicPitchModel()
      .then(() => { setModelReady(true); setModelLoading(false) })
      .catch((err) => { console.error('[BasicPitch] Model load failed:', err); setModelLoading(false) })
  }, [inputMode])

  // Check microphone permission
  useEffect(() => {
    if (inputMode !== 'mic') return
    async function checkMicPermission() {
      try {
        const status = await navigator.permissions.query({ name: 'microphone' })
        setMicPermission(status.state)
        if (status.state === 'prompt') setShowMicPrompt(true)
        status.addEventListener('change', () => {
          setMicPermission(status.state)
          if (status.state === 'granted') setShowMicPrompt(false)
        })
      } catch {
        setShowMicPrompt(true)
      }
    }
    checkMicPermission()
  }, [inputMode])

  // Probe MIDI on mount
  useEffect(() => {
    enableMidi().then(({ supported, inputs }) => {
      setMidiSupported(supported)
      setMidiDevices(inputs)
      if (inputs.length > 0) {
        setSelectedDeviceId(inputs[0].id)
        setInputMode('midi')
      } else {
        setInputMode('mic')
      }
      const removeListener = onDevicesChanged((updatedInputs) => {
        setMidiDevices(updatedInputs)
        setSelectedDeviceId((prev) => {
          if (prev && updatedInputs.some((d) => d.id === prev)) return prev
          return updatedInputs.length > 0 ? updatedInputs[0].id : null
        })
        if (updatedInputs.length > 0) setInputMode('midi')
      })
      return removeListener
    })
  }, [])

  // ---------------------------------------------------------------------------
  // Parse MusicXML timeline whenever musicXml changes
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!musicXml) {
      setNoteTimeline([])
      return
    }
    let xmlStr = musicXml
    if (musicXml instanceof ArrayBuffer || musicXml instanceof Uint8Array) {
      try {
        xmlStr = new TextDecoder().decode(musicXml)
      } catch {
        xmlStr = null
      }
    }
    if (xmlStr && typeof xmlStr === 'string') {
      const { timeline } = parseNoteTimeline(xmlStr)
      setNoteTimeline(timeline)
      setCurrentNoteIndex(0)
      pushDebug('xmlParsed', {
        count: timeline.length,
        first3: timeline.slice(0, 3).map(e => ({ tick: e.tick, measure: e.measure, notes: e.notes })),
      })
    }
  }, [musicXml, pushDebug])

  // ---------------------------------------------------------------------------
  // AlphaTab — rendering, playback, cursor ONLY
  // ---------------------------------------------------------------------------
  function toLoadData(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    if (typeof data === 'string') return new TextEncoder().encode(data)
    return data
  }

  useEffect(() => {
    if (!alphaTabRef.current || !musicXml) return

    // If API already exists, just load the new score
    if (apiRef.current) {
      setLoading(true)
      apiRef.current.load(toLoadData(musicXml))
      return
    }

    const api = new alphaTab.AlphaTabApi(alphaTabRef.current, {
      core: {
        fontDirectory: './font/',
        logLevel: 1,
      },
      player: {
        enablePlayer: true,
        enableCursor: true,
        enableAnimatedBeatCursor: true,
        enableElementHighlighting: true,
        enableUserInteraction: true,
        soundFont: './soundfont/sonivox.sf2',
        scrollMode: 'off',
      },
      display: {
        layoutMode: 'page',
      },
    })
    apiRef.current = api

    // scoreLoaded: render all tracks, extract BPM, done
    api.scoreLoaded.on((score) => {
      pushDebug('scoreLoaded', {
        tracks: score.tracks.length,
        trackNames: score.tracks.map(t => t.name),
      })

      // Render ALL tracks so both hands are visible
      if (score.tracks.length > 1 && api.tracks.length < score.tracks.length) {
        api.renderTracks(score.tracks)
        return
      }

      setBpm(score.tempo)
      setLoading(false)
      setError(null)
    })

    api.playerReady.on(() => {
      api.playbackSpeed = playbackSpeedRef.current
      setPlayerReady(true)
    })

    // playerPositionChanged: progress bar + listen-mode note sync
    api.playerPositionChanged.on((args) => {
      if (args.endTime > 0) {
        setPlayerProgress(args.currentTime / args.endTime)
      }

      // In listen mode, sync current note index to playback position
      if (modeRef.current === 'listen') {
        const tl = noteTimelineRef.current
        if (tl.length === 0) return
        const tick = args.currentTick

        // Find the note whose tick is <= currentTick, with the next note's tick > currentTick
        let best = 0
        for (let i = 0; i < tl.length; i++) {
          if (tl[i].tick <= tick) best = i
          else break
        }
        setCurrentNoteIndex(best)
      }
    })

    api.playerStateChanged.on((args) => {
      pushDebug('playerStateChanged', { state: args.state })
      if (modeRef.current !== 'listen') return
      if (args.state === alphaTab.synth.PlayerState.Paused) {
        setMode('idle')
      }
    })

    api.error.on((err) => {
      console.error('[AlphaTab]', err)
      pushDebug('error', { message: String(err) })
      // Only show error to user if the score hasn't loaded yet (non-fatal errors like
      // SoundFont issues can fire after the sheet is already rendered successfully)
      if (noteTimelineRef.current.length === 0) {
        setError('Failed to render sheet music. Check the file format.')
        setLoading(false)
      }
    })

    setLoading(true)
    api.load(toLoadData(musicXml))

    return () => {
      api.destroy()
      apiRef.current = null
      setPlayerReady(false)
    }
  }, [musicXml, pushDebug])

  // Sync playback speed
  useEffect(() => {
    if (apiRef.current) apiRef.current.playbackSpeed = playbackSpeed
  }, [playbackSpeed])

  // Sync AlphaTab cursor + autoscroll when note index changes
  useEffect(() => {
    const api = apiRef.current
    if (!api || mode === 'idle') return

    const entry = noteTimeline[currentNoteIndex]
    if (!entry) return

    // Move AlphaTab's cursor to this note's tick (practice mode only)
    if (mode === 'practice' && lastTickSetRef.current !== entry.tick) {
      lastTickSetRef.current = entry.tick
      api.tickPosition = entry.tick
    }

    // Auto-scroll
    if (autoscrollRef.current && alphaTabRef.current) {
      requestAnimationFrame(() => {
        const cursorBar = alphaTabRef.current?.querySelector('.at-cursor-bar')
        if (!cursorBar) return
        const rect = cursorBar.getBoundingClientRect()
        const viewportH = window.innerHeight
        const scrollBehavior = modeRef.current === 'practice' ? 'instant' : 'smooth'
        if (rect.bottom > viewportH - 40 || rect.top < 80) {
          cursorBar.scrollIntoView({ block: 'center', behavior: scrollBehavior })
        }
      })
    }
  }, [mode, currentNoteIndex, noteTimeline])

  // ---------------------------------------------------------------------------
  // Practice mode: advance on correct input
  // ---------------------------------------------------------------------------

  // Advance to the next note, skipping any tied notes
  const doAdvance = useCallback(() => {
    advanceCooldownRef.current = true
    setTimeout(() => { advanceCooldownRef.current = false }, ADVANCE_COOLDOWN_MS)

    let nextIdx = currentNoteIndexRef.current + 1
    const tl = noteTimelineRef.current

    // Auto-skip tied notes (notes connected by curves)
    while (nextIdx < tl.length && nextIdx > 0 && tl[nextIdx - 1].isTied) {
      nextIdx++
    }

    if (nextIdx >= tl.length) {
      setCompleted(true)
    } else {
      wrongCountRef.current = 0
      setShowHint(false)
      clearTimeout(wrongTimerRef.current)
      wrongTimerRef.current = null
      setCurrentNoteIndex(nextIdx)
    }
  }, [])

  // Play the target note(s) via AlphaTab synth as a hint
  const playTargetHint = useCallback(() => {
    const api = apiRef.current
    const target = noteTimelineRef.current[currentNoteIndexRef.current]
    if (!api || !target) return
    // Move cursor to the target tick and play briefly
    api.tickPosition = target.tick
    api.play()
    setTimeout(() => {
      try { api.pause() } catch {}
    }, 1500)
  }, [])

  // Called when notes are detected (MIDI noteOn or mic detection)
  const checkNotes = useCallback(() => {
    if (completedRef.current || pausedRef.current) return
    if (modeRef.current !== 'practice') return
    if (advanceCooldownRef.current) return

    const idx = currentNoteIndexRef.current
    const target = noteTimelineRef.current[idx]
    if (!target) return

    const targetNotes = target.notes
    const anyOct = anyOctaveRef.current
    const held = [...heldNotesRef.current]

    if (held.length === 0) return

    // Check: every target note is held
    const allTargetsHeld = targetNotes.every((tn) =>
      held.some((h) => notesMatch(h, tn, anyOct))
    )

    // Check: no extra notes beyond the target
    const noExtras = held.every((h) =>
      targetNotes.some((tn) => notesMatch(h, tn, anyOct))
    )

    if (allTargetsHeld && noExtras) {
      // Correct — wait for release before advancing
      waitingForReleaseRef.current = true
      clearTimeout(wrongTimerRef.current)
      wrongTimerRef.current = null
      setShowHint(false)
      wrongCountRef.current = 0
    } else {
      // Wrong note(s) played
      waitingForReleaseRef.current = false
      wrongCountRef.current++

      if (wrongCountRef.current >= MAX_WRONG_ATTEMPTS) {
        // Play the target note as a hint
        setShowHint(true)
        playTargetHint()
        wrongCountRef.current = 0
      } else if (!wrongTimerRef.current) {
        wrongTimerRef.current = setTimeout(() => {
          wrongTimerRef.current = null
          setShowHint(true)
        }, HINT_DELAY_MS)
      }
    }
  }, [playTargetHint])

  // Called when all notes are released
  const handleRelease = useCallback(() => {
    if (waitingForReleaseRef.current) {
      waitingForReleaseRef.current = false
      doAdvance()
    }
  }, [doAdvance])

  const handleNoteOff = useCallback((note) => {
    heldNotesRef.current.delete(note)
    if (heldNotesRef.current.size === 0) {
      setDetectedNote(null)
      handleRelease()
    }
  }, [handleRelease])

  // Auto-reconnect MIDI when device changes mid-practice
  useEffect(() => {
    if (mode !== 'practice' || inputMode !== 'midi' || !selectedDeviceId) return

    stopListenerRef.current?.()
    stopListenerRef.current = null

    let cancelled = false
    ;(async () => {
      const stop = await listenToDevice(
        selectedDeviceId,
        (note) => {
          heldNotesRef.current.add(note)
          setDetectedNote(note)
          checkNotes()
        },
        handleNoteOff,
      )
      if (cancelled) { stop?.(); return }
      if (stop) {
        stopListenerRef.current = stop
        setInputError(null)
      }
    })()

    return () => { cancelled = true }
  }, [selectedDeviceId, mode, inputMode, checkNotes, handleNoteOff])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopListenerRef.current?.()
      stopMicRef.current?.()
      clearTimeout(wrongTimerRef.current)
    }
  }, [])

  function stopAllInputs() {
    stopListenerRef.current?.()
    stopListenerRef.current = null
    stopMicRef.current?.()
    stopMicRef.current = null
    clearTimeout(wrongTimerRef.current)
    wrongTimerRef.current = null
    heldNotesRef.current.clear()
    if (apiRef.current) {
      try {
        apiRef.current.stop()
        apiRef.current.tickPosition = 0
      } catch {}
    }
  }

  // ---------------------------------------------------------------------------
  // File handling
  // ---------------------------------------------------------------------------
  function handleUploadClick() {
    fileInputRef.current?.click()
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setFilename(file.name)
    const reader = new FileReader()
    reader.onload = (evt) => setMusicXml(evt.target.result)
    if (file.name.endsWith('.mxl')) {
      reader.readAsArrayBuffer(file)
    } else {
      reader.readAsText(file)
    }
    e.target.value = ''
  }

  function handleSelectDemo(piece) {
    setShowDemoModal(false)
    setFilename(piece.title)
    setMusicXml(piece.xml)
  }

  function handleBack() {
    stopAllInputs()
    setMusicXml(null)
    setFilename('')
    setError(null)
    setNoteTimeline([])
    setMode('idle')
    setPaused(false)
    setCurrentNoteIndex(0)
    setDetectedNote(null)
    setInputError(null)
    setCompleted(false)
    setShowHint(false)
    setBpm(null)
    setPlayerReady(false)
    setPlayerProgress(0)
    if (apiRef.current) {
      apiRef.current.destroy()
      apiRef.current = null
    }
    if (alphaTabRef.current) {
      alphaTabRef.current.innerHTML = ''
    }
  }

  // ---------------------------------------------------------------------------
  // Listen mode
  // ---------------------------------------------------------------------------
  function handleListen() {
    if (mode === 'listen') {
      if (apiRef.current) apiRef.current.stop()
      setMode('idle')
      return
    }
    setMode('listen')
    setCurrentNoteIndex(0)
    setCompleted(false)
    setPaused(false)
    lastTickSetRef.current = -1
    if (apiRef.current) {
      apiRef.current.playbackSpeed = playbackSpeed
      apiRef.current.tickPosition = 0
      apiRef.current.play()
    }
  }

  function handleListenPause() {
    if (apiRef.current) apiRef.current.pause()
    setPaused(true)
  }

  function handleListenResume() {
    if (apiRef.current) apiRef.current.play()
    setPaused(false)
  }

  // ---------------------------------------------------------------------------
  // Practice mode
  // ---------------------------------------------------------------------------
  async function handleStartPractice() {
    if (noteTimeline.length === 0) return

    setCurrentNoteIndex(0)
    setDetectedNote(null)
    setInputError(null)
    setCompleted(false)
    setPaused(false)
    setShowHint(false)
    setMode('practice')
    lastTickSetRef.current = -1

    if (inputMode === 'midi') {
      if (!selectedDeviceId) {
        setInputError(
          midiSupported === false
            ? 'MIDI requires Chrome or Edge. Switch to Microphone in settings.'
            : 'Connect a MIDI keyboard via USB to start.'
        )
        setMode('idle')
        return
      }
      const stop = await listenToDevice(
        selectedDeviceId,
        (note) => {
          heldNotesRef.current.add(note)
          setDetectedNote(note)
          checkNotes()
        },
        handleNoteOff,
      )
      if (stop) {
        stopListenerRef.current = stop
      } else {
        setInputError('Failed to connect to MIDI device. Try reconnecting.')
        setMode('idle')
      }
    } else {
      try {
        const onNotes = (notes) => {
          if (notes && notes.length > 0) {
            heldNotesRef.current.clear()
            for (const n of notes) heldNotesRef.current.add(n)
            setDetectedNote(notes.join(' + '))
            checkNotes()
          } else {
            // All notes released — trigger release logic
            heldNotesRef.current.clear()
            setDetectedNote(null)
            handleRelease()
          }
        }
        const stop = await startBasicPitchDetection(onNotes)
        stopMicRef.current = stop
      } catch {
        setInputError('Microphone access was blocked. Grant permission and try again.')
        setMode('idle')
      }
    }
  }

  function handleStopPractice() {
    stopAllInputs()
    setMode('idle')
    setPaused(false)
    setDetectedNote(null)
    setCompleted(false)
    setShowHint(false)
  }

  function handlePausePractice() {
    setPaused(true)
    clearTimeout(wrongTimerRef.current)
    wrongTimerRef.current = null
    setShowHint(false)
  }

  function handleResumePractice() {
    setPaused(false)
  }

  function handleRestart() {
    setCompleted(false)
    setCurrentNoteIndex(0)
    setDetectedNote(null)
    setPaused(false)
    setShowHint(false)
    clearTimeout(wrongTimerRef.current)
    wrongTimerRef.current = null
    lastTickSetRef.current = -1
    if (apiRef.current) {
      apiRef.current.stop()
      apiRef.current.tickPosition = 0
    }
  }

  // Navigation
  function handlePrevMoment() {
    lastTickSetRef.current = -1
    setCurrentNoteIndex((i) => Math.max(0, i - 1))
  }

  function handleNextMoment() {
    lastTickSetRef.current = -1
    setCurrentNoteIndex((i) => Math.min(noteTimeline.length - 1, i + 1))
  }

  function handlePrevMeasure() {
    const curMeasure = noteTimeline[currentNoteIndex]?.measure ?? 1
    const target = curMeasure - 1
    if (target < 1) return
    const idx = noteTimeline.findIndex((m) => m.measure === target)
    if (idx !== -1) {
      lastTickSetRef.current = -1
      setCurrentNoteIndex(idx)
    }
  }

  function handleNextMeasure() {
    const curMeasure = noteTimeline[currentNoteIndex]?.measure ?? 1
    const target = curMeasure + 1
    const idx = noteTimeline.findIndex((m) => m.measure === target)
    if (idx !== -1) {
      lastTickSetRef.current = -1
      setCurrentNoteIndex(idx)
    }
  }

  // ---------------------------------------------------------------------------
  // Derived display values
  // ---------------------------------------------------------------------------
  const currentEntry = noteTimeline[currentNoteIndex]
  const currentNoteDisplay = currentEntry ? currentEntry.notes.join(' + ') : '---'
  const totalMeasures = noteTimeline.length > 0 ? noteTimeline[noteTimeline.length - 1].measure : 0
  const isMatch = mode === 'practice' && detectedNote && currentEntry &&
    currentEntry.notes.some((tn) =>
      [...heldNotesRef.current].some((held) => notesMatch(held, tn, anyOctave))
    )
  const prevEntry = currentNoteIndex > 0 ? noteTimeline[currentNoteIndex - 1] : null
  const intervalName = currentEntry && prevEntry ? getInterval(prevEntry.notes, currentEntry.notes) : null

  const selectedDevice = midiDevices.find((d) => d.id === selectedDeviceId)

  const chevronLeft = (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
      <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
  const chevronRight = (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
      <path d="M7.5 5L12.5 10L7.5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )

  return (
    <div className="min-h-screen bg-[#0f0f0f] text-white flex flex-col">
      {/* Mobile banner */}
      <div className="sm:hidden bg-[#1a1a1a] border-b border-neutral-800 px-4 py-3 text-center">
        <p className="text-neutral-400 text-xs leading-relaxed">
          Best experienced on desktop with a MIDI keyboard or microphone.
        </p>
      </div>

      <main className="flex-1 flex flex-col items-center px-4 sm:px-6">
        {/* Header */}
        <div className={`flex flex-col items-center w-full ${musicXml ? 'pt-8 sm:pt-10 pb-4 sm:pb-6' : 'justify-center flex-1'}`}>
          <div className={musicXml ? 'mb-3 sm:mb-4' : 'mb-6 sm:mb-8'}>
            <svg
              width={musicXml ? 40 : 72}
              height={musicXml ? 40 : 72}
              viewBox="0 0 72 72"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-label="Noteflow logo"
              className={musicXml ? 'sm:w-12 sm:h-12' : ''}
            >
              <rect x="8" y="20" width="10" height="36" rx="2" fill="white" />
              <rect x="20" y="20" width="10" height="36" rx="2" fill="white" />
              <rect x="32" y="20" width="10" height="36" rx="2" fill="white" />
              <rect x="44" y="20" width="10" height="36" rx="2" fill="white" />
              <rect x="56" y="20" width="10" height="36" rx="2" fill="white" />
              <rect x="15" y="20" width="8" height="22" rx="1.5" fill="#0f0f0f" />
              <rect x="27" y="20" width="8" height="22" rx="1.5" fill="#0f0f0f" />
              <rect x="47" y="20" width="8" height="22" rx="1.5" fill="#0f0f0f" />
              <rect x="59" y="20" width="8" height="22" rx="1.5" fill="#0f0f0f" />
              <circle cx="58" cy="14" r="4" fill="#d4a053" />
              <rect x="62" y="4" width="2.5" height="12" rx="1" fill="#d4a053" />
              <path d="M64.5 4 C64.5 4 70 6 70 9" stroke="#d4a053" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </div>

          <h1 className={`font-bold tracking-tight ${musicXml ? 'text-2xl sm:text-3xl mb-1' : 'text-4xl sm:text-6xl mb-3'}`}>
            Noteflow
          </h1>

          {!musicXml && (
            <>
              <p className="text-base sm:text-lg text-neutral-400 mb-10 sm:mb-12 text-center">
                Practice piano. One note at a time.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 w-full sm:w-auto">
                <button
                  onClick={handleUploadClick}
                  className="px-8 py-3 rounded-lg bg-[#d4a053] text-[#0f0f0f] font-semibold text-base hover:bg-[#e0b56a] transition-colors cursor-pointer"
                >
                  Upload MusicXML / MXL
                </button>
                <button
                  onClick={() => setShowDemoModal(true)}
                  className="px-8 py-3 rounded-lg border border-neutral-700 text-neutral-300 font-semibold text-base hover:border-[#d4a053] hover:text-[#d4a053] transition-colors cursor-pointer"
                >
                  Try a Demo Piece
                </button>
              </div>

              <div className="mt-16 sm:mt-20 max-w-md text-center">
                <p className="text-neutral-500 text-sm leading-relaxed">
                  Noteflow is a free, open-source note-by-note piano practice tool.
                  No paywall. No account. Just play.
                </p>
              </div>
            </>
          )}
        </div>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".xml,.musicxml,.mxl"
          onChange={handleFileChange}
          className="hidden"
        />

        {/* Demo picker modal */}
        {showDemoModal && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4"
            onClick={(e) => { if (e.target === e.currentTarget) setShowDemoModal(false) }}
          >
            <div className="bg-[#1a1a1a] border border-neutral-800 rounded-2xl w-full max-w-lg p-5 sm:p-6">
              <div className="flex items-center justify-between mb-5 sm:mb-6">
                <h2 className="text-lg sm:text-xl font-bold">Choose a Demo Piece</h2>
                <button
                  onClick={() => setShowDemoModal(false)}
                  className="text-neutral-500 hover:text-white transition-colors cursor-pointer"
                  aria-label="Close"
                >
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>

              <div className="flex flex-col gap-3">
                {DEMO_PIECES.map((piece) => (
                  <button
                    key={piece.id}
                    onClick={() => handleSelectDemo(piece)}
                    className="flex items-center justify-between p-4 rounded-xl border border-neutral-800 hover:border-[#d4a053]/50 hover:bg-[#d4a053]/5 transition-all cursor-pointer text-left group"
                  >
                    <div className="min-w-0 mr-3">
                      <div className="font-semibold text-white group-hover:text-[#d4a053] transition-colors truncate">
                        {piece.title}
                      </div>
                      <div className="text-neutral-500 text-sm mt-0.5">{piece.composer}</div>
                    </div>
                    <span className={`text-xs font-medium px-2.5 py-1 rounded-full whitespace-nowrap shrink-0 ${
                      piece.difficulty === 'Beginner'
                        ? 'bg-emerald-900/40 text-emerald-400 border border-emerald-800/50'
                        : 'bg-amber-900/40 text-amber-400 border border-amber-800/50'
                    }`}>
                      {piece.difficulty}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Settings modal */}
        {showSettings && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4"
            onClick={(e) => { if (e.target === e.currentTarget) setShowSettings(false) }}
          >
            <div className="bg-[#1a1a1a] border border-neutral-800 rounded-2xl w-full max-w-sm p-5 sm:p-6">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold">Settings</h2>
                <button
                  onClick={() => setShowSettings(false)}
                  className="text-neutral-500 hover:text-white transition-colors cursor-pointer"
                  aria-label="Close"
                >
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>

              {/* Input Source */}
              <div className="mb-5">
                <label className="text-neutral-400 text-xs uppercase tracking-wider font-medium mb-2 block">Input Source</label>
                <div className="flex rounded-lg border border-neutral-700 overflow-hidden text-sm font-medium">
                  <button
                    onClick={() => setInputMode('midi')}
                    disabled={midiSupported === false}
                    className={`flex-1 px-3 py-2 flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                      inputMode === 'midi' ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="6" width="20" height="14" rx="2"/>
                      <path d="M8 6v8M12 6v8M16 6v8"/>
                    </svg>
                    MIDI
                  </button>
                  <button
                    onClick={() => setInputMode('mic')}
                    className={`flex-1 px-3 py-2 flex items-center justify-center gap-2 transition-colors cursor-pointer ${
                      inputMode === 'mic' ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
                      <path d="M19 10v2a7 7 0 01-14 0v-2"/>
                      <line x1="12" y1="19" x2="12" y2="23"/>
                    </svg>
                    Microphone
                  </button>
                </div>
              </div>

              {/* MIDI Device dropdown */}
              {inputMode === 'midi' && (
                <div className="mb-5">
                  <label className="text-neutral-400 text-xs uppercase tracking-wider font-medium mb-2 block">MIDI Device</label>
                  {midiSupported === false ? (
                    <p className="text-red-400 text-sm">No MIDI support detected.</p>
                  ) : midiDevices.length === 0 ? (
                    <p className="text-neutral-500 text-sm">Connect a MIDI keyboard via USB to start.</p>
                  ) : (
                    <select
                      value={selectedDeviceId ?? ''}
                      onChange={(e) => setSelectedDeviceId(e.target.value)}
                      className="w-full bg-[#0f0f0f] border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#d4a053] transition-colors cursor-pointer"
                    >
                      {midiDevices.map((d) => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {/* Any octave toggle */}
              <div className="mb-5">
                <button
                  onClick={() => setAnyOctave((v) => !v)}
                  className="flex items-center justify-between w-full p-3 rounded-xl border border-neutral-800 hover:border-neutral-600 transition-colors cursor-pointer"
                >
                  <div className="text-left">
                    <div className="text-sm font-medium text-white">Any octave</div>
                    <div className="text-xs text-neutral-500">C3 matches target C4, etc.</div>
                  </div>
                  <div className={`w-10 h-6 rounded-full relative transition-colors ${anyOctave ? 'bg-[#d4a053]' : 'bg-neutral-700'}`}>
                    <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${anyOctave ? 'left-5' : 'left-1'}`} />
                  </div>
                </button>
              </div>

              {/* Tempo / Playback speed */}
              <div className="mb-5">
                <label className="text-neutral-400 text-xs uppercase tracking-wider font-medium mb-2 block">
                  Playback Speed: {Math.round(playbackSpeed * 100)}%
                </label>
                <input
                  type="range"
                  min="0.25"
                  max="2"
                  step="0.05"
                  value={playbackSpeed}
                  onChange={(e) => setPlaybackSpeed(parseFloat(e.target.value))}
                  className="w-full accent-[#d4a053]"
                />
                <div className="flex justify-between text-[10px] text-neutral-600 mt-1">
                  <span>25%</span>
                  <span>100%</span>
                  <span>200%</span>
                </div>
              </div>

              {/* Autoscroll toggle */}
              <div className="mb-5">
                <button
                  onClick={() => setAutoscroll((v) => !v)}
                  className="flex items-center justify-between w-full p-3 rounded-xl border border-neutral-800 hover:border-neutral-600 transition-colors cursor-pointer"
                >
                  <div className="text-left">
                    <div className="text-sm font-medium text-white">Autoscroll</div>
                    <div className="text-xs text-neutral-500">Keep the current bar visible during playback</div>
                  </div>
                  <div className={`w-10 h-6 rounded-full relative transition-colors ${autoscroll ? 'bg-[#d4a053]' : 'bg-neutral-700'}`}>
                    <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${autoscroll ? 'left-5' : 'left-1'}`} />
                  </div>
                </button>
              </div>

              {/* Mic model status */}
              {inputMode === 'mic' && (
                <div className="mb-5">
                  <label className="text-neutral-400 text-xs uppercase tracking-wider font-medium mb-2 block">Detection Engine</label>
                  <p className="text-neutral-300 text-sm">Basic Pitch (Spotify ML)</p>
                  <p className="text-neutral-600 text-[10px] mt-1.5">
                    ML-powered polyphonic note detection. Supports chords.
                  </p>
                  {modelLoading && (
                    <div className="flex items-center gap-2 mt-2 text-[#d4a053] text-xs">
                      <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Loading audio model...
                    </div>
                  )}
                  {modelReady && (
                    <p className="text-emerald-500 text-[10px] mt-2">Model ready</p>
                  )}
                </div>
              )}

              <p className="text-neutral-600 text-xs leading-relaxed">
                {inputMode === 'midi'
                  ? 'MIDI is supported in Chrome, Edge, and Opera.'
                  : 'Microphone works in all browsers. Grant permission when prompted.'}
              </p>
            </div>
          </div>
        )}

        {/* Sheet music display */}
        {musicXml && (
          <div className="w-full max-w-4xl mb-8 sm:mb-12">
            {/* File info bar */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-3 min-w-0">
                <button
                  onClick={handleBack}
                  className="text-neutral-400 hover:text-white transition-colors cursor-pointer shrink-0"
                  aria-label="Go back"
                >
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
                <span className="text-neutral-300 text-sm truncate">{filename}</span>
                {bpm && (
                  <span className="text-neutral-500 text-xs font-mono shrink-0">{bpm} BPM</span>
                )}
              </div>

              <div className="flex items-center gap-2 sm:gap-3 shrink-0">
                {mode === 'idle' && (
                  <button
                    onClick={() => setShowSettings(true)}
                    className="w-8 h-8 flex items-center justify-center rounded-lg border border-neutral-700 text-neutral-400 hover:text-white hover:border-neutral-500 transition-colors cursor-pointer"
                    aria-label="Settings"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3"/>
                      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
                    </svg>
                  </button>
                )}

                {/* Listen button */}
                {mode !== 'practice' && (
                  <button
                    onClick={handleListen}
                    disabled={!playerReady || noteTimeline.length === 0}
                    className={`w-8 h-8 flex items-center justify-center rounded-lg border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                      mode === 'listen'
                        ? 'border-cyan-500 text-cyan-400 hover:text-cyan-300 hover:border-cyan-400'
                        : 'border-neutral-700 text-neutral-400 hover:text-white hover:border-neutral-500'
                    }`}
                    aria-label={mode === 'listen' ? 'Stop listening' : 'Listen'}
                  >
                    {mode === 'listen' ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="6" y="6" width="12" height="12" rx="2"/>
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z"/>
                      </svg>
                    )}
                  </button>
                )}

                {/* Practice buttons */}
                {mode === 'idle' ? (
                  <button
                    onClick={handleStartPractice}
                    disabled={noteTimeline.length === 0}
                    className="px-5 sm:px-6 py-2 rounded-lg bg-[#d4a053] text-[#0f0f0f] font-semibold text-sm hover:bg-[#e0b56a] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Start Practice
                  </button>
                ) : mode === 'practice' ? (
                  <div className="flex items-center gap-2">
                    {!paused ? (
                      <button
                        onClick={handlePausePractice}
                        className="px-3 sm:px-4 py-2 rounded-lg border border-neutral-600 text-neutral-300 font-semibold text-sm hover:border-neutral-400 hover:text-white transition-colors cursor-pointer flex items-center gap-1.5"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                          <rect x="6" y="4" width="4" height="16" rx="1"/>
                          <rect x="14" y="4" width="4" height="16" rx="1"/>
                        </svg>
                        <span className="hidden sm:inline">Pause</span>
                      </button>
                    ) : (
                      <button
                        onClick={handleResumePractice}
                        className="px-3 sm:px-4 py-2 rounded-lg bg-[#d4a053] text-[#0f0f0f] font-semibold text-sm hover:bg-[#e0b56a] transition-colors cursor-pointer flex items-center gap-1.5"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8 5v14l11-7z"/>
                        </svg>
                        <span className="hidden sm:inline">Resume</span>
                      </button>
                    )}
                    <button
                      onClick={handleStopPractice}
                      className="px-3 sm:px-4 py-2 rounded-lg border border-neutral-600 text-neutral-300 font-semibold text-sm hover:border-red-500 hover:text-red-400 transition-colors cursor-pointer flex items-center gap-1.5"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="6" y="6" width="12" height="12" rx="2"/>
                      </svg>
                      <span className="hidden sm:inline">Stop</span>
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            {/* Input error */}
            {inputError && (
              <div className="mb-4 px-4 py-3 rounded-lg bg-red-900/30 border border-red-800 text-red-300 text-sm">
                {inputError}
              </div>
            )}

            {/* Input status bar */}
            <div className="mb-4 flex items-center gap-2 text-xs text-neutral-500">
              {inputMode === 'mic' ? (
                <>
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${modelLoading ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'}`} />
                  <span>
                    Microphone (Basic Pitch)
                    {modelLoading && ' — loading model...'}
                  </span>
                </>
              ) : selectedDevice ? (
                <>
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  <span>MIDI: {selectedDevice.name}</span>
                </>
              ) : midiSupported === false ? (
                <>
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400" />
                  <span>MIDI requires Chrome or Edge &mdash; switch to Microphone in settings</span>
                </>
              ) : (
                <>
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-neutral-600" />
                  <span>Connect a MIDI keyboard via USB to start</span>
                </>
              )}
              {anyOctave && (
                <>
                  <span className="mx-1 text-neutral-700">|</span>
                  <span>Any octave</span>
                </>
              )}
            </div>

            {/* Sheet + practice panel wrapper */}
            <div className="relative">
              {/* Practice panel */}
              {mode === 'practice' && currentEntry && !completed && !paused && (
                <div className="sticky top-0 z-20 rounded-xl border border-neutral-800 bg-neutral-900/95 backdrop-blur-sm px-4 sm:px-6 py-3 mb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 sm:gap-4">
                      {/* Note arrows */}
                      <div className="flex items-center gap-1">
                        <button
                          onClick={handlePrevMoment}
                          disabled={currentNoteIndex === 0}
                          className="w-7 h-7 flex items-center justify-center rounded-md border border-neutral-700 text-neutral-400 hover:text-white hover:border-neutral-500 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                          aria-label="Previous note"
                        >
                          {chevronLeft}
                        </button>
                        <button
                          onClick={handleNextMoment}
                          disabled={currentNoteIndex === noteTimeline.length - 1}
                          className="w-7 h-7 flex items-center justify-center rounded-md border border-neutral-700 text-neutral-400 hover:text-white hover:border-neutral-500 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                          aria-label="Next note"
                        >
                          {chevronRight}
                        </button>
                        <span className="text-neutral-600 text-[10px] uppercase tracking-wider ml-0.5">Note</span>
                      </div>

                      {/* Measure arrows */}
                      <div className="flex items-center gap-1">
                        <button
                          onClick={handlePrevMeasure}
                          disabled={currentEntry.measure <= 1}
                          className="w-7 h-7 flex items-center justify-center rounded-md border border-neutral-700 text-neutral-400 hover:text-white hover:border-neutral-500 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                          aria-label="Previous measure"
                        >
                          {chevronLeft}
                        </button>
                        <button
                          onClick={handleNextMeasure}
                          disabled={currentEntry.measure >= totalMeasures}
                          className="w-7 h-7 flex items-center justify-center rounded-md border border-neutral-700 text-neutral-400 hover:text-white hover:border-neutral-500 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                          aria-label="Next measure"
                        >
                          {chevronRight}
                        </button>
                        <span className="text-neutral-600 text-[10px] uppercase tracking-wider ml-0.5">Bar</span>
                      </div>

                      <div className="flex items-center gap-3">
                        <div className="text-center">
                          <div className="text-neutral-500 text-[10px] uppercase tracking-wider">Target</div>
                          <div className="text-cyan-400 text-lg font-bold font-mono leading-tight">{currentNoteDisplay}</div>
                        </div>
                        <div className="text-center">
                          <div className="text-neutral-500 text-[10px] uppercase tracking-wider">Playing</div>
                          <div className={`text-lg font-bold font-mono leading-tight ${
                            detectedNote ? (isMatch ? 'text-emerald-400' : 'text-red-400') : 'text-neutral-600'
                          }`}>
                            {detectedNote ?? '---'}
                          </div>
                        </div>
                        <div className={`w-3 h-3 rounded-full shrink-0 transition-colors ${
                          !detectedNote ? 'bg-neutral-700' : isMatch ? 'bg-emerald-400' : 'bg-red-400'
                        }`} />
                      </div>

                      {intervalName && (
                        <div className="text-purple-400/80 text-[10px] font-medium uppercase tracking-wider">
                          {intervalName}
                        </div>
                      )}

                      {showHint && (
                        <div className="text-amber-400/80 text-xs font-medium">
                          Play {currentNoteDisplay}
                        </div>
                      )}
                    </div>

                    <div className="text-right">
                      <div className="text-neutral-300 text-sm font-mono">
                        Note {currentNoteIndex + 1} of {noteTimeline.length}
                      </div>
                      <div className="text-neutral-600 text-xs font-mono">
                        Measure {currentEntry.measure} of {totalMeasures}
                      </div>
                    </div>
                  </div>

                  <div className="mt-2.5 h-1 bg-neutral-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-cyan-400 rounded-full transition-all duration-300 ease-out"
                      style={{ width: `${((currentNoteIndex + 1) / noteTimeline.length) * 100}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Paused overlay */}
              {mode === 'practice' && paused && !completed && (
                <div className="sticky top-0 z-20 rounded-xl border border-[#d4a053]/30 bg-[#d4a053]/5 backdrop-blur-sm px-6 py-4 text-center mb-3">
                  <p className="text-[#d4a053] font-semibold">Paused</p>
                  <p className="text-neutral-500 text-sm mt-1">
                    Note {currentNoteIndex + 1} of {noteTimeline.length} &middot; Measure {currentEntry?.measure} of {totalMeasures}
                  </p>
                </div>
              )}

              {/* AlphaTab rendered sheet music */}
              <div
                ref={alphaTabRef}
                className="bg-white rounded-xl p-3 sm:p-6 min-h-[160px] sm:min-h-[200px] overflow-x-auto"
              />

              {loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/80 rounded-xl">
                  <div className="flex items-center gap-3 text-neutral-500">
                    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span>Rendering sheet music...</span>
                  </div>
                </div>
              )}
              {error && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/80 rounded-xl">
                  <p className="text-red-500 text-sm">{error}</p>
                </div>
              )}

              {/* Completion screen */}
              {completed && (
                <div className="mt-4 rounded-xl border border-emerald-800 bg-emerald-900/20 px-6 sm:px-8 py-8 text-center">
                  <div className="text-5xl mb-4">{'\u{1F3B9}'}</div>
                  <p className="text-emerald-400 text-2xl font-bold mb-2">You finished!</p>
                  <p className="text-neutral-400 text-sm mb-1">{filename}</p>
                  <p className="text-neutral-500 text-sm mb-6">
                    {noteTimeline.length} notes &middot; {totalMeasures} measures
                  </p>
                  <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                    <button
                      onClick={handleRestart}
                      className="w-full sm:w-auto px-6 py-2.5 rounded-lg bg-[#d4a053] text-[#0f0f0f] font-semibold text-sm hover:bg-[#e0b56a] transition-colors cursor-pointer"
                    >
                      Play Again
                    </button>
                    <button
                      onClick={handleStopPractice}
                      className="w-full sm:w-auto px-6 py-2.5 rounded-lg border border-neutral-700 text-neutral-300 font-semibold text-sm hover:border-neutral-500 hover:text-white transition-colors cursor-pointer"
                    >
                      Back to Score
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Microphone permission prompt */}
      {showMicPrompt && micPermission !== 'granted' && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-neutral-900/95 backdrop-blur-sm border border-amber-700/50 rounded-xl px-5 py-3 shadow-2xl max-w-md">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#d4a053" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
            <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
            <path d="M19 10v2a7 7 0 01-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-white font-medium">Microphone access needed</p>
            <p className="text-xs text-neutral-400 mt-0.5">
              {micPermission === 'denied'
                ? 'Permission was blocked. Enable it in your browser settings.'
                : 'Grant microphone access to use pitch detection for practice.'}
            </p>
          </div>
          {micPermission !== 'denied' && (
            <button
              onClick={async () => {
                try {
                  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
                  stream.getTracks().forEach((t) => t.stop())
                  setMicPermission('granted')
                  setShowMicPrompt(false)
                } catch {
                  setMicPermission('denied')
                }
              }}
              className="px-3 py-1.5 rounded-lg bg-[#d4a053] text-[#0f0f0f] font-semibold text-xs hover:bg-[#e0b56a] transition-colors cursor-pointer whitespace-nowrap"
            >
              Grant Access
            </button>
          )}
          <button
            onClick={() => setShowMicPrompt(false)}
            className="text-neutral-500 hover:text-white transition-colors cursor-pointer shrink-0"
            aria-label="Dismiss"
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
              <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      )}

      {/* Floating playback controls — listen mode */}
      {mode === 'listen' && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-neutral-900/95 backdrop-blur-sm border border-neutral-700 rounded-xl px-4 py-3 shadow-2xl">
          <div className="text-neutral-400 text-xs font-mono mr-1">
            {currentNoteDisplay}
          </div>

          <button
            onClick={paused ? handleListenResume : handleListenPause}
            className="w-9 h-9 flex items-center justify-center rounded-lg border border-neutral-600 text-neutral-300 hover:text-white hover:border-neutral-400 transition-colors cursor-pointer"
            aria-label={paused ? 'Resume' : 'Pause'}
          >
            {paused ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" rx="1"/>
                <rect x="14" y="4" width="4" height="16" rx="1"/>
              </svg>
            )}
          </button>

          <div className="w-24 h-1 bg-neutral-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-cyan-400 rounded-full transition-all duration-200"
              style={{ width: `${playerProgress * 100}%` }}
            />
          </div>

          <span className="text-neutral-500 text-[10px] font-mono">
            {Math.round(playbackSpeed * 100)}%
          </span>

          <button
            onClick={handleListen}
            className="w-9 h-9 flex items-center justify-center rounded-lg bg-red-500/20 border border-red-500/50 text-red-400 hover:bg-red-500/30 hover:text-red-300 transition-colors cursor-pointer"
            aria-label="Stop"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
          </button>
        </div>
      )}

      {/* Footer */}
      <footer className="w-full border-t border-neutral-800/60 mt-auto">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-neutral-600">
          <div className="flex flex-col sm:flex-row items-center gap-2 sm:gap-4">
            <span>&copy; {new Date().getFullYear()} Noteflow</span>
            <a
              href="https://github.com/KeerCode/NoteFlow-Beta"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-neutral-500 hover:text-[#d4a053] transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
              </svg>
              GitHub
            </a>
          </div>
          <p className="text-center sm:text-right text-neutral-600 max-w-xs leading-relaxed">
            Users are responsible for ensuring they have rights to uploaded MusicXML files.
          </p>
        </div>
      </footer>

      {/* Debug panel */}
      {showDebug && (
        <div className="fixed bottom-4 left-4 z-[100] w-96 max-h-80 bg-black/95 border border-neutral-700 rounded-xl p-3 overflow-y-auto font-mono text-[10px] leading-relaxed shadow-2xl">
          <div className="flex items-center justify-between mb-2">
            <span className="text-amber-400 font-bold text-xs">Debug Log (press D to close)</span>
            <button onClick={() => setDebugLog([])} className="text-neutral-500 hover:text-white text-[10px] cursor-pointer">Clear</button>
          </div>
          {debugLog.length === 0 && <p className="text-neutral-600">No events yet. Load a score and press play.</p>}
          {debugLog.map((entry, i) => (
            <div key={i} className="mb-1.5 border-b border-neutral-800 pb-1.5">
              <span className="text-cyan-400">{entry.type}</span>
              <span className="text-neutral-600 ml-2">{new Date(entry.time).toISOString().slice(11, 23)}</span>
              <pre className="text-neutral-300 whitespace-pre-wrap break-all mt-0.5">{JSON.stringify(entry.data, null, 1)}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default App
