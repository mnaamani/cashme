// What the wallet looks like before it says anything: the wordmark, the colours it wears,
// and the glitch the UI opens on.
//
// This is the one module that emits colour by hand rather than through lib/tui/style.mjs.
// The named styles there cover the sixteen a terminal has agreed on since the eighties,
// which is the right palette for a balance or an error and the wrong one for a gradient —
// a wordmark that fades cyan to magenta needs a colour per column, and there are only two
// of those in the sixteen. So the ramp is built here, at whatever depth the terminal
// admits to, and everything it returns is a plain string with the escapes already in it.
//
// Which is safe to hand to the layout: width(), cut() and pad() all measure with the SGR
// sequences stripped, so a gradient line is exactly as wide as the characters in it. The
// one rule is that these lines are placed with `wrap: false` — wrap() would break a line
// between a colour and the character it was opened for.
import process from 'bare-process'

// Cyan to magenta, through the blues in between. Two stops rather than three because the
// straight line in RGB already passes through violet, which is the part that reads as neon.
const START = [0x22, 0xf0, 0xff]
const END = [0xff, 0x2b, 0xd6]

// How much colour this terminal will take. Kept as a number so a caller can compare, and
// so the no-colour case is falsy.
export const NONE = 0
export const BASIC = 1
export const EXTENDED = 2
export const TRUE_COLOR = 3

// `tty` is the caller's business: this module never asks whether a stream is a terminal,
// because the CLI asks about stdout and the UI already knows the answer for itself.
export function colorLevel({ tty = true, env = {} } = {}) {
  if (!tty) return NONE
  // The convention, honoured by everything else that colours a terminal: any value at all,
  // including an empty one, means no colour.
  if ('NO_COLOR' in env && env.NO_COLOR !== undefined) return NONE
  const term = env.TERM || ''
  if (term === 'dumb') return NONE
  if (/truecolor|24bit/i.test(env.COLORTERM || '')) return TRUE_COLOR
  if (/-256(color)?$/.test(term) || /kitty|alacritty|wezterm|ghostty/i.test(term)) {
    return EXTENDED
  }
  return BASIC
}

const RESET = '\x1b[0m'

function lerp(from, to, t) {
  return Math.round(from + (to - from) * t)
}

function mix(t) {
  return [lerp(START[0], END[0], t), lerp(START[1], END[1], t), lerp(START[2], END[2], t)]
}

// The 6×6×6 cube xterm puts at 16..231. Rounding each channel to its nearest sixth is
// crude next to a real nearest-colour search, and indistinguishable on a ramp.
function cube([r, g, b]) {
  const step = (v) => Math.round((v / 255) * 5)
  return 16 + 36 * step(r) + 6 * step(g) + step(b)
}

// The sixteen, for a terminal that has only those: the ramp collapses to the three colours
// along it that exist — bright cyan, blue, bright magenta — which still reads as a fade.
function basic(t) {
  if (t < 0.34) return '\x1b[96m'
  if (t < 0.67) return '\x1b[94m'
  return '\x1b[95m'
}

function code(t, level) {
  if (level >= TRUE_COLOR) {
    const [r, g, b] = mix(t)
    return `\x1b[38;2;${r};${g};${b}m`
  }
  if (level === EXTENDED) return `\x1b[38;5;${cube(mix(t))}m`
  return basic(t)
}

// A block of lines with the ramp laid across it diagonally, so the fade runs corner to
// corner rather than repeating identically on every row.
//
// A colour is emitted only where it changes from the character before it. On a 51-column
// wordmark that is the difference between six lines of about a kilobyte each and six lines
// of about a hundred bytes, repainted on every frame of the UI.
export function neon(lines, level = TRUE_COLOR, { bold = true } = {}) {
  if (!level) return lines.slice()
  const columns = Math.max(1, ...lines.map((line) => line.length))
  const rows = Math.max(1, lines.length)
  // The diagonal is normalised by both extents together, so a wide short block and a tall
  // narrow one both run the full ramp exactly once.
  const span = columns - 1 + (rows - 1) || 1
  const lead = bold ? '\x1b[1m' : ''

  return lines.map((line, row) => {
    let out = lead
    let last = null
    for (let column = 0; column < line.length; column++) {
      const character = line[column]
      // Spaces carry no colour, and skipping them keeps a run of them from breaking the
      // "same as last" check that makes this cheap.
      if (character === ' ') {
        out += character
        continue
      }
      const next = code((column + row) / span, level)
      if (next !== last) {
        out += next
        last = next
      }
      out += character
    }
    return `${out}${RESET}`
  })
}

// One line, coloured from a fixed point on the ramp. For the strap lines under the
// wordmark, which want to belong to it without competing with it.
export function tint(line, t, level = TRUE_COLOR, { dim = false } = {}) {
  if (!level) return line
  return `${dim ? '\x1b[2m' : ''}${code(t, level)}${line}${RESET}`
}

// --- the letters themselves --------------------------------------------------------

// Five rows and forty-three columns, which puts it inside an eighty-column terminal with
// room to spare. Written out rather than generated: it is a logo, and a logo that is
// assembled at runtime is a logo nobody can look at in the source and know.
//
// Solid blocks and nothing else. The usual shadowed terminal fonts draw their letters in
// blocks and then outline them in box characters, which reads beautifully at the size a
// terminal draws it and turns to gravel everywhere it is scaled down — including in the
// screenshots in the README, which is where most people will ever see it. These letters
// have no strokes thinner than a whole cell, so they survive being made small, and they
// come apart into the glitch below far more legibly than an outline does.
export const WORDMARK = [
  ' █████  ████   █████ ██  ██ ███  ███ ██████',
  '██     ██  ██ ██     ██  ██ ████████ ██    ',
  '██     ██████  █████ ██████ ██ ██ ██ █████ ',
  '██     ██  ██     ██ ██  ██ ██    ██ ██    ',
  ' █████ ██  ██ █████  ██  ██ ██    ██ ██████'
]

// The same name in two rows and twenty-four columns, for a header that has a balance to
// get to. Half blocks rather than the box characters the panes are drawn in: box drawing
// makes a wordmark out of the same strokes as the borders around it, which at this size
// reads as a piece of broken border rather than as letters.
export const COMPACT = ['█▀▀ ▄▀█ █▀ █ █ █▀▄▀█ █▀▀', '█▄▄ █▀█ ▄█ █▀█ █ ▀ █ █▄▄']

// For a terminal with room for a name and nothing else.
export const SIGIL = '░▒▓ CASHME ▓▒░'

// The half of the name that is a joke, and the half that is a warning. Both are true, and
// the warning is the one that has to survive being cut, so it goes last on its own line.
export const STRAP = '.... if you can'
export const CREED = 'ecash · bluetooth · lan · hyperdht · no servers, no permission'
export const WARNING = 'EXPERIMENTAL — for education, research and testing. Use at your own risk.'

// --- glitch ------------------------------------------------------------------------

// What a character decays into on its way in. Ordered roughly by how much of the cell they
// fill, so a run of intensities reads as the letter resolving rather than as noise.
const DECAY = ['░', '▒', '▓', '█', '╱', '╲', '╳', '▄', '▀', '│', '─']

// A cheap, seeded, repeatable generator. Repeatable is the point: the same seed gives the
// same frame, so the screenshots in the README are the same picture every time they are
// regenerated, and a test can assert on one.
function noise(seed) {
  let state = seed | 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return ((state >>> 0) % 100000) / 100000
  }
}

// The wordmark part-way through arriving. `intensity` is the share of its cells that have
// not settled yet — 1 is static, 0 is the finished logo — so an animation counts down.
//
// Only cells that are already drawn are disturbed. Glitching the spaces around the letters
// would spread the block wider than it is and shove whatever sits beside it, and the shape
// coming apart is more legible than the gaps filling in anyway.
export function glitch(lines, intensity, seed = 1) {
  if (intensity <= 0) return lines.slice()
  const random = noise(seed)
  return lines.map((line) =>
    line
      .split('')
      .map((character) => {
        if (character === ' ') return character
        if (random() >= intensity) return character
        return DECAY[Math.floor(random() * DECAY.length)]
      })
      .join('')
  )
}

// --- assembled blocks ----------------------------------------------------------------

// The wordmark, centred in `columns`, with whatever of the strap lines fits under it.
// Returns plain lines when the terminal wants no colour, which is also what a pipe gets.
export function banner({ columns = 80, level = TRUE_COLOR, version = '', warning = true } = {}) {
  const art =
    columns >= WORDMARK[0].length + 2
      ? WORDMARK
      : columns >= COMPACT[0].length + 2
        ? COMPACT
        : [SIGIL]

  // Centring is done on the bare line and the colour applied after, so the indent is
  // measured against characters rather than against escape sequences.
  const indent = (line) => ' '.repeat(Math.max(0, Math.floor((columns - line.length) / 2)))
  const centred = (line, paint) => `${indent(line)}${paint(line)}`

  const painted = neon(art, level)
  const out = art.map((line, index) => `${indent(line)}${painted[index]}`)
  out.push('')

  const strap = version ? `${STRAP}   ${version}` : STRAP
  if (strap.length <= columns) out.push(centred(strap, (line) => tint(line, 0.15, level)))
  if (CREED.length <= columns) {
    out.push(centred(CREED, (line) => tint(line, 0.8, level, { dim: true })))
  }
  if (warning && WARNING.length <= columns) {
    out.push('')
    out.push(centred(WARNING, (line) => (level ? `\x1b[33m${line}${RESET}` : line)))
  }
  return out
}

// The level this process's terminal will take, asked of the environment rather than passed
// in. `tty` stays the caller's answer: the CLI colours help only when stdout is a terminal,
// and the full-screen UI has already refused to start without one.
export function detectLevel(tty = true) {
  return colorLevel({ tty, env: process.env })
}
