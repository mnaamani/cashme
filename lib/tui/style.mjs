// Strings the way a terminal sees them: styled, but measured and cut by what is visible.
//
// Every width in the layout below is a column count, and an escape sequence occupies no
// columns — so `width()`, `pad()` and `cut()` all walk the string rather than using
// .length, and carry the sequences through untouched. Get this wrong in one place and
// every box on the screen is drawn a few columns too wide.
const SGR = /\x1b\[[0-9;]*m/g

// Named styles rather than raw codes at the call sites: a screen says `dim`, not `\x1b[2m`,
// and nothing has to remember which number turns what off.
const CODES = {
  reset: 0,
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  inverse: 7,
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  bgBlack: 40,
  bgRed: 41,
  bgGreen: 42,
  bgYellow: 43,
  bgBlue: 44,
  bgMagenta: 45,
  bgCyan: 46,
  bgWhite: 47
}

export const RESET = '\x1b[0m'

// Applies the named styles and closes with a full reset. A full reset rather than the
// per-attribute off codes, because these nest: `bold(red(x))` inside a dim line would
// otherwise turn dim off at the end of the inner span.
export function style(text, names = []) {
  const codes = names.filter((name) => name in CODES).map((name) => CODES[name])
  if (!codes.length) return text
  return `\x1b[${codes.join(';')}m${text}${RESET}`
}

export function strip(text) {
  return String(text).replace(SGR, '')
}

// How many columns this string takes. Control characters other than SGR are not expected
// here — the layout builds its own lines — so stripping SGR is enough.
export function width(text) {
  return strip(text).length
}

// The first `columns` visible characters, with every escape sequence that applies to them
// kept in place. A truncated styled string still has to end with a reset, or the style
// bleeds into whatever the layout puts beside it.
export function cut(text, columns) {
  if (columns <= 0) return ''
  const source = String(text)
  let out = ''
  let visible = 0
  let styled = false
  for (let i = 0; i < source.length; ) {
    if (source[i] === '\x1b') {
      const match = /^\x1b\[[0-9;]*m/.exec(source.slice(i))
      if (match) {
        out += match[0]
        styled = true
        i += match[0].length
        continue
      }
    }
    if (visible === columns) break
    out += source[i]
    visible++
    i++
  }
  return styled ? `${out}${RESET}` : out
}

// Exactly `columns` wide: cut when too long, filled when too short. `align` decides which
// side the fill lands on, which is how a row puts a total against the right edge.
export function pad(text, columns, align = 'left') {
  const cutTo = cut(text, columns)
  const short = columns - width(cutTo)
  if (short <= 0) return cutTo
  const fill = ' '.repeat(short)
  if (align === 'right') return `${fill}${cutTo}`
  if (align === 'center') {
    const left = ' '.repeat(Math.floor(short / 2))
    const right = ' '.repeat(short - Math.floor(short / 2))
    return `${left}${cutTo}${right}`
  }
  return `${cutTo}${fill}`
}

// Greedy word wrap, on the visible text. Words longer than the line — a token, a mint url,
// a hyperdht key — are cut across lines rather than allowed to overflow the box.
export function wrap(text, columns) {
  if (columns <= 0) return ['']
  const lines = []
  for (const paragraph of String(text).split('\n')) {
    if (width(paragraph) <= columns) {
      lines.push(paragraph)
      continue
    }
    let line = ''
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word
      if (width(candidate) <= columns) {
        line = candidate
        continue
      }
      if (line) lines.push(line)
      let rest = word
      while (width(rest) > columns) {
        lines.push(cut(rest, columns))
        rest = strip(rest).slice(columns)
      }
      line = rest
    }
    lines.push(line)
  }
  return lines
}
