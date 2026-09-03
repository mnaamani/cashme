// A painted terminal frame, as an SVG somebody can put in a README.
//
// The alternative was a screenshot of a real terminal, and the reason not to take one is
// that a picture of a terminal is a picture of *someone's* terminal — their font, their
// theme, their window, the day they took it. It goes stale the moment the UI changes and
// nobody can tell whether it is still true. This is generated from the same frame the
// runtime paints, so `npm run screenshots` regenerates every image in the docs from the
// code as it is now, and a stale one is a diff rather than a thing nobody noticed.
//
// Text is positioned per run of same-styled characters rather than per character: the
// glyphs are monospace, so a run lands where its first character says it does, and any
// disagreement between the reader's monospace font and the advance assumed here is
// contained inside one run instead of accumulating across a line.

// The escape sequences the runtime frames a paint with (cursor home, erase to end of line,
// erase below). They say where to draw rather than what, and this is drawing the whole
// frame at once, so they are dropped.
const CONTROL = /\x1b\[[0-9]*[HJK]/g
const SGR = /\x1b\[([0-9;]*)m/

// A palette rather than the terminal's, because the terminal's is the reader's business
// and this image has to look like one thing on everybody's screen. Cool and dark, since
// that is what the wordmark's ramp was picked against.
const THEME = {
  background: '#0b0e16',
  foreground: '#c6d0e8',
  chrome: '#161b28',
  colors: [
    '#1c2130', // black
    '#ff3b6b', // red
    '#3ff59b', // green
    '#ffd166', // yellow
    '#5b8cff', // blue
    '#ff2bd6', // magenta
    '#22f0ff', // cyan
    '#c6d0e8' // white
  ],
  bright: ['#3a4258', '#ff6b8f', '#7dffc0', '#ffe08a', '#8fb0ff', '#ff6ce4', '#7df7ff', '#eef2ff']
}

// The 6×6×6 cube and the 24-step grey ramp xterm puts above the sixteen, so a frame drawn
// at 256 colours comes out the same as one drawn at 24-bit.
function extended(index) {
  if (index < 8) return THEME.colors[index]
  if (index < 16) return THEME.bright[index - 8]
  if (index < 232) {
    const value = index - 16
    const step = (v) => [0, 95, 135, 175, 215, 255][v]
    return rgb(step(Math.floor(value / 36)), step(Math.floor(value / 6) % 6), step(value % 6))
  }
  const grey = 8 + (index - 232) * 10
  return rgb(grey, grey, grey)
}

function rgb(r, g, b) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`
}

function blank() {
  return {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false
  }
}

// SGR parameters applied to a state, in order. Anything not understood is ignored rather
// than treated as a reset: an unknown attribute should cost the colour of what follows it.
function apply(state, params) {
  const codes = params.split(';').map((part) => (part === '' ? 0 : Number(part)))
  for (let at = 0; at < codes.length; at++) {
    const code = codes[at]
    if (code === 0) Object.assign(state, blank())
    else if (code === 1) state.bold = true
    else if (code === 2) state.dim = true
    else if (code === 3) state.italic = true
    else if (code === 4) state.underline = true
    else if (code === 7) state.inverse = true
    else if (code === 22) state.bold = state.dim = false
    else if (code === 23) state.italic = false
    else if (code === 24) state.underline = false
    else if (code === 27) state.inverse = false
    else if (code >= 30 && code <= 37) state.fg = THEME.colors[code - 30]
    else if (code >= 40 && code <= 47) state.bg = THEME.colors[code - 40]
    else if (code >= 90 && code <= 97) state.fg = THEME.bright[code - 90]
    else if (code >= 100 && code <= 107) state.bg = THEME.bright[code - 100]
    else if (code === 39) state.fg = null
    else if (code === 49) state.bg = null
    else if (code === 38 || code === 48) {
      // 38;5;n and 38;2;r;g;b, and the same two at 48 for the background.
      const channel = code === 38 ? 'fg' : 'bg'
      if (codes[at + 1] === 5) {
        state[channel] = extended(codes[at + 2])
        at += 2
      } else if (codes[at + 1] === 2) {
        state[channel] = rgb(codes[at + 2], codes[at + 3], codes[at + 4])
        at += 4
      }
    }
  }
}

// One line of a frame, as runs of characters sharing a style. Trailing blanks are dropped,
// since an unstyled space at the end of a line draws nothing.
function runs(line, state) {
  const out = []
  let rest = line
  let column = 0
  let text = ''
  let style = { ...state }

  const flush = () => {
    if (!text) return
    if (text.trim() || style.bg || style.inverse || style.underline) {
      out.push({ column: column - text.length, text, style: { ...style } })
    }
    text = ''
  }

  while (rest.length) {
    const match = SGR.exec(rest)
    if (match && match.index === 0) {
      flush()
      apply(state, match[1])
      style = { ...state }
      rest = rest.slice(match[0].length)
      continue
    }
    const upto = match ? match.index : rest.length
    const chunk = rest.slice(0, upto)
    text += chunk
    column += [...chunk].length
    rest = rest.slice(upto)
  }
  flush()
  return out
}

function escape(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Metrics chosen so a cell is close to square-ish at a comfortable reading size, and so a
// 92-column frame comes out under 800 points wide — which is about what a README column
// gives an image before it is scaled down and the text goes to mush.
const CELL = { width: 8.4, height: 18 }
const FONT_SIZE = 14
const PADDING = 22
const TITLE_BAR = 32
const FONT =
  "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace"

// `frame` is exactly what the runtime wrote: escape sequences and all, lines separated by
// CRLF. `title` goes in the window bar, which is drawn rather than photographed for the
// same reason the rest of this is.
export function toSvg(frame, { title = 'cashme', columns, rows } = {}) {
  const lines = frame.replace(CONTROL, '').split('\r\n')
  const wide =
    columns ?? Math.max(...lines.map((line) => [...line.replace(/\x1b\[[0-9;]*m/g, '')].length))
  const tall = rows ?? lines.length

  const width = wide * CELL.width + PADDING * 2
  const height = tall * CELL.height + PADDING * 2 + TITLE_BAR

  // The state carries across lines: a frame is a single stream, and the runtime does not
  // reset at every newline.
  const state = blank()
  const body = []

  lines.forEach((line, row) => {
    const y = TITLE_BAR + PADDING + row * CELL.height + FONT_SIZE * 0.8
    for (const run of runs(line, state)) {
      const x = PADDING + run.column * CELL.width
      const { style } = run
      const foreground = style.inverse ? style.bg || THEME.background : style.fg || THEME.foreground
      const background = style.inverse ? style.fg || THEME.foreground : style.bg

      if (background) {
        body.push(
          `<rect x="${round(x)}" y="${round(y - FONT_SIZE * 0.8 - 2)}" ` +
            `width="${round([...run.text].length * CELL.width)}" height="${CELL.height}" fill="${background}"/>`
        )
      }
      const attrs = [
        `x="${round(x)}"`,
        `y="${round(y)}"`,
        `fill="${foreground}"`,
        style.bold ? 'font-weight="700"' : null,
        style.italic ? 'font-style="italic"' : null,
        style.dim ? 'opacity="0.55"' : null,
        style.underline ? 'text-decoration="underline"' : null
      ].filter(Boolean)
      body.push(`<text ${attrs.join(' ')} xml:space="preserve">${escape(run.text)}</text>`)
    }
  })

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width)}" height="${round(height)}" viewBox="0 0 ${round(width)} ${round(height)}" font-family="${FONT}" font-size="${FONT_SIZE}">`,
    `<rect width="${round(width)}" height="${round(height)}" rx="10" fill="${THEME.background}"/>`,
    `<path d="M0 10a10 10 0 0 1 10-10h${round(width - 20)}a10 10 0 0 1 10 10v${TITLE_BAR - 10}H0z" fill="${THEME.chrome}"/>`,
    `<circle cx="20" cy="16" r="5" fill="#ff5f57"/>`,
    `<circle cx="38" cy="16" r="5" fill="#febc2e"/>`,
    `<circle cx="56" cy="16" r="5" fill="#28c840"/>`,
    `<text x="${round(width / 2)}" y="21" fill="#6b7690" font-size="12" text-anchor="middle">${escape(title)}</text>`,
    ...body,
    '</svg>'
  ].join('\n')
}

function round(value) {
  return Math.round(value * 100) / 100
}
