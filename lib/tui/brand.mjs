// The wallet's face inside the full-screen UI: the wordmark on the way in, and the crest
// the menu wears once it is there.
//
// Everything drawn here is decoration, which is exactly why it is in a file of its own and
// not in components.mjs. Nothing else in this UI is allowed to cost a row it cannot pay
// for: both components below take the height they are given, decide whether the thing they
// would draw fits in it, and draw a smaller thing or nothing at all rather than pushing a
// balance or the way out of a screen off the bottom.
import { text, row, column } from './element.mjs'
import { useState, useEffect, useInput } from './runtime.mjs'
import { useInterval } from './hooks.mjs'
import { WORDMARK, COMPACT, SIGIL, STRAP, CREED, neon, tint, glitch, detectLevel } from '../art.mjs'

// Asked once, at import, because the answer is about the terminal this process was started
// in and cannot change under it. Screens do not have to thread it through their props.
const LEVEL = detectLevel(true)

// The wordmark resolving out of noise, then held for a beat.
//
// Twenty frames of decay and thirteen of stillness at 60ms is a hair under two seconds —
// long enough to be a thing that happened and to be read, short enough that nobody waiting
// to see a balance resents it. Any key skips it, which is the part that matters: an
// animation that cannot be dismissed is a delay with a picture on it.
//
// The hold is most of the second half on purpose. Stretching the decay instead would spend
// the extra time on frames nobody can read, and the finished wordmark is the thing worth
// looking at.
const FRAME_MS = 60
const DECAY_FRAMES = 20
const HOLD_FRAMES = 13
const FRAMES = DECAY_FRAMES + HOLD_FRAMES

export function Splash({ columns = 80, height = 24, version = '', onDone }) {
  const [frame, setFrame] = useState(0)
  useInterval(() => setFrame((at) => at + 1), frame < FRAMES ? FRAME_MS : null)

  // Any key at all skips to the wallet, and the key is eaten rather than passed on: the
  // root's own handler is behind this one and would read the same press as a quit.
  // Ctrl-C is the exception, because it has to reach that handler from everywhere.
  useInput((key, { stop }) => {
    if (key.name === 'ctrl-c') return
    stop()
    onDone?.()
  })

  // Ending is an effect rather than something the timer does, so the last frame is on
  // screen before the menu replaces it — a splash that unmounted from inside its own tick
  // would skip the one frame it spent the whole animation arriving at.
  const finished = frame >= FRAMES
  useEffect(() => {
    if (finished) onDone?.()
  }, [finished])

  const art = columns >= WORDMARK[0].length ? WORDMARK : COMPACT
  // Squared off at the end so the last frames are almost still: a linear countdown spends
  // half the animation in a state that already reads as finished.
  const left = Math.max(0, (DECAY_FRAMES - frame) / DECAY_FRAMES)
  const lines = neon(glitch(art, left * left, frame + 1), LEVEL)

  // Centred in whatever it was given, with the strap under it — and the vertical padding
  // computed against the block's real height, so a short terminal loses the padding rather
  // than the wordmark.
  const block = [...lines, '', tint(STRAP, 0.15, LEVEL), tint(CREED, 0.8, LEVEL, { dim: true })]
  const above = Math.max(0, Math.floor((height - block.length) / 2))

  return column(
    { height },
    ...Array.from({ length: above }, (unused, at) => text('', { key: `above-${at}` })),
    ...block.map((line, at) => text(line, { align: 'center', wrap: false, key: at })),
    version ? text('') : null,
    version
      ? text(tint(version, 0.5, LEVEL, { dim: true }), { align: 'center', wrap: false })
      : null
  )
}

// What the wordmark costs in rows, at each size it comes in. The menu asks before it makes
// room, rather than making room and finding out.
const CREST_ROWS = COMPACT.length
const STRIP_ROWS = 1

// The name and what this thing is, above the balance — in the three-row box-drawing
// wordmark when the terminal is tall enough for it, in one line when it is not, and not at
// all on a terminal short enough that the row is worth more as an action.
//
// `room` is how many rows are going spare below, which only the screen laying itself out
// knows. Nothing here guesses at it from the terminal's height: the log pane and the hint
// line have already been taken out by the time this is asked.
export function Crest({ columns = 80, room = 0 }) {
  if (room >= CREST_ROWS + 1 && columns >= COMPACT[0].length + 4 + CREED.length) {
    // The blank line is part of what this costs, and is counted in the `room` asked for
    // above: the wordmark sitting straight on top of the balance pane's border reads as
    // one thing with a lid on it rather than as a name over a number.
    return column(
      {},
      row(
        { gap: 2 },
        column({}, ...neon(COMPACT, LEVEL).map((line, at) => text(line, { wrap: false, key: at }))),
        column(
          { grow: 1 },
          text(tint(STRAP, 0.4, LEVEL), { wrap: false }),
          text(tint(CREED, 0.85, LEVEL, { dim: true }), { wrap: false })
        )
      ),
      text('')
    )
  }
  if (room >= STRIP_ROWS && columns >= SIGIL.length + 3 + CREED.length) {
    return row(
      { gap: 2 },
      text(tint(SIGIL, 0.1, LEVEL), { wrap: false }),
      text(tint(CREED, 0.85, LEVEL, { dim: true }), { grow: 1, wrap: false })
    )
  }
  return null
}

// The name in the top bar, wearing the same ramp as everything else here so the corner of
// the screen and the middle of it are recognisably one thing.
export function Mark({ label }) {
  return text(neon([label], LEVEL)[0], { wrap: false })
}

// A short run of text in the ramp, for the one number on a screen that is the reason the
// screen was opened. Everything else here draws a picture; this colours something the
// wallet said, so it is a function rather than a component — the caller still decides
// where it goes and what else is true of it.
export function glow(said) {
  return neon([said], LEVEL)[0]
}
