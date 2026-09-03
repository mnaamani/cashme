// The wordmark and the colours it wears.
//
// Two things here can break the screen rather than merely look wrong, and they are what
// these are mostly about: a row of the wordmark that is not the same width as the others
// puts a ragged edge through every box beside it, and a gradient that survives `strip()`
// as anything but the original characters means the layout is measuring escape sequences
// as columns and every pane on the screen is drawn wide.
import test from 'brittle'
import {
  WORDMARK,
  COMPACT,
  SIGIL,
  CREED,
  neon,
  tint,
  glitch,
  banner,
  colorLevel,
  NONE,
  BASIC,
  EXTENDED,
  TRUE_COLOR
} from '../lib/art.mjs'
import { strip, width } from '../lib/tui/style.mjs'

test('every row of the wordmark is the same width as every other', (t) => {
  for (const [name, art] of [
    ['wordmark', WORDMARK],
    ['compact', COMPACT]
  ]) {
    const widths = new Set(art.map((line) => [...line].length))
    t.is(widths.size, 1, `${name}: one width across ${art.length} rows`)
  }
  t.ok(WORDMARK[0].length <= 78, 'and the big one fits an eighty-column terminal')
})

test('colour is invisible to anything measuring columns', (t) => {
  for (const level of [BASIC, EXTENDED, TRUE_COLOR]) {
    const painted = neon(WORDMARK, level)
    t.alike(
      painted.map(strip),
      WORDMARK,
      `level ${level}: the characters come back exactly as they went in`
    )
    t.alike(
      painted.map(width),
      WORDMARK.map((line) => line.length),
      `level ${level}: and take the same number of columns`
    )
  }
  t.is(strip(tint(CREED, 0.5, TRUE_COLOR)), CREED, 'and the same for a single tinted line')
})

test('a terminal that wants no colour is given none', (t) => {
  t.is(colorLevel({ tty: false, env: { COLORTERM: 'truecolor' } }), NONE, 'not a terminal')
  t.is(colorLevel({ tty: true, env: { NO_COLOR: '' } }), NONE, 'NO_COLOR, even empty')
  t.is(colorLevel({ tty: true, env: { TERM: 'dumb' } }), NONE, 'a dumb terminal')
  t.is(colorLevel({ tty: true, env: { TERM: 'xterm-256color' } }), EXTENDED, '256 colours')
  t.is(colorLevel({ tty: true, env: { COLORTERM: 'truecolor' } }), TRUE_COLOR, '24-bit')
  t.is(colorLevel({ tty: true, env: { TERM: 'xterm' } }), BASIC, 'and the sixteen otherwise')

  t.alike(neon(WORDMARK, NONE), WORDMARK, 'and at no colour the art is left alone')
  t.is(tint(SIGIL, 0.5, NONE), SIGIL, 'strap lines too')
  t.absent(
    banner({ columns: 80, level: NONE }).some((line) => line.includes('\x1b')),
    'so a piped banner is plain characters'
  )
})

test('the glitch keeps the shape it is taking apart', (t) => {
  const noisy = glitch(WORDMARK, 0.5, 7)
  t.alike(
    noisy.map((line) => line.length),
    WORDMARK.map((line) => line.length),
    'every row is still as wide as it was'
  )
  for (let row = 0; row < WORDMARK.length; row++) {
    const spaces = (line) => [...line].map((character, at) => (character === ' ' ? at : -1))
    t.alike(spaces(noisy[row]), spaces(WORDMARK[row]), `row ${row}: the gaps are where they were`)
  }
  t.alike(glitch(WORDMARK, 0.5, 7), noisy, 'the same seed gives the same frame')
  t.unlike(glitch(WORDMARK, 0.5, 8), noisy, 'and a different one does not')
  t.alike(glitch(WORDMARK, 0, 7), WORDMARK, 'nothing left to decay is the wordmark itself')
})

test('the banner fits the terminal it was given, however narrow', (t) => {
  for (const columns of [120, 80, 60, 40, 20]) {
    const lines = banner({ columns, level: TRUE_COLOR, version: 'v9.9.9' })
    const wide = lines.filter((line) => width(line) > columns)
    t.is(wide.length, 0, `${columns} columns: nothing overflows`)
    t.ok(lines.length > 1, `${columns} columns: and there is still something to look at`)
  }
})
