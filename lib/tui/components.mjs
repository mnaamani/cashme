// The pieces every screen is built from. Nothing here knows what a mint is.
import { h, text, box, row, column, spacer } from './element.mjs'
import { useState, useInput, useMemo } from './runtime.mjs'
import { useSpinner } from './hooks.mjs'
import { width, cut } from './style.mjs'

// A titled pane. `focus` is what tells the user which one their keys are going to, so it
// is a border colour rather than anything that changes the layout — a pane that grew a
// marker when focused would shift everything beside it.
export function Panel({ title, focus = false, children, ...props }) {
  return box(
    {
      title,
      border: 'round',
      borderColor: focus ? 'cyan' : undefined,
      dim: !focus,
      padding: { left: 1, right: 1 },
      ...props
    },
    ...children
  )
}

// The key line along the bottom. Pairs of [key, what it does], dropped from the right when
// the terminal is too narrow — a truncated hint is worse than one fewer hint.
export function Hints({ keys }) {
  const parts = keys.filter(Boolean).map(([key, label]) => `${key} ${label}`)
  return text(parts.join('   '), { dim: true, wrap: false })
}

// A label above a value, which is most of what a detail pane is.
export function Detail({ label, value, ...props }) {
  return row(
    { gap: 1 },
    text(label, { dim: true, width: 14 }),
    text(String(value ?? ''), { grow: 1, ...props })
  )
}

// A single-line text field. Owns nothing: the value and the cursor live in the parent, so
// a form can read every field it holds without asking each one.
//
// The cursor is drawn as an inverse cell over the character it sits on, rather than by
// moving the terminal's own cursor — the runtime hides that one and repaints from the top
// left every frame, so there is nowhere to leave it.
export function Field({ value = '', placeholder = '', focus = false, mask = false, label }) {
  const shown = mask && value ? '•'.repeat(value.length) : value
  const body = useMemo(() => {
    if (!focus) {
      return shown || (placeholder ? `\x1b[2m${placeholder}\x1b[0m` : '')
    }
    // The cursor is always at the end: this is a field for typing an amount or pasting a
    // token into, not an editor, and arrow keys are worth more to the screen around it.
    return `${shown}\x1b[7m \x1b[0m`
  }, [shown, focus, placeholder])

  return row(
    { gap: 1 },
    label ? text(label, { dim: !focus, width: 14 }) : null,
    text(body, { grow: 1, wrap: false })
  )
}

// The keystrokes a field takes, applied to a string. Kept separate from Field so a form
// can own its state and still not restate what backspace means.
export function editText(value, key, { numeric = false } = {}) {
  if (key.name === 'backspace') return value.slice(0, -1)
  if (key.name === 'ctrl-u') return ''
  if (!key.input) return value
  if (numeric && !/^[0-9]$/.test(key.input)) return value
  return value + key.input
}

// A list one item of which is chosen. Arrow keys and j/k move; the caller decides what
// return means, because a list of mints and a list of actions do different things with it.
export function Select({ items, index = 0, focus = false, height }) {
  const rows = items.map((item, at) => {
    const chosen = at === index
    const marker = chosen ? (focus ? '›' : '·') : ' '
    return row(
      { gap: 1 },
      text(marker, { width: 1, cyan: chosen && focus }),
      text(item.label, { grow: 1, bold: chosen, dim: !chosen && !focus }),
      item.hint ? text(item.hint, { dim: true }) : null
    )
  })
  return column({ height }, ...rows)
}

// Moves a selection, and says so — the caller keeps the index, since it usually needs to
// react to it changing.
export function moveSelection(key, index, length) {
  if (length === 0) return index
  if (key.name === 'up' || key.input === 'k') return (index - 1 + length) % length
  if (key.name === 'down' || key.input === 'j') return (index + 1) % length
  if (key.name === 'home') return 0
  if (key.name === 'end') return length - 1
  return index
}

// What a screen shows while an operation is in flight, or once it has ended. One component
// so that every wait in this UI looks the same, whichever wire it is waiting on.
export function Status({ task, idle = '', running = 'working', done = 'done' }) {
  const spinner = useSpinner(task.status === 'running')
  if (task.status === 'running') {
    return text(`${spinner} ${task.note || running}`, { cyan: true, wrap: false })
  }
  if (task.status === 'error') return text(`✗ ${task.error?.message ?? task.error}`, { red: true })
  if (task.status === 'done') return text(`✓ ${done}`, { green: true })
  return text(idle, { dim: true })
}

// A question that takes the keyboard until it is answered. Rendered by the screen that
// asks; the runtime gives it the keys first because it is deeper in the tree.
export function Confirm({ question, detail = [], onAnswer }) {
  useInput((key, { stop }) => {
    stop()
    if (key.input === 'y' || key.input === 'Y') onAnswer(true)
    else if (key.input === 'n' || key.input === 'N' || key.name === 'escape') onAnswer(false)
  })
  return h(
    Panel,
    { title: 'confirm', focus: true, borderColor: 'yellow' },
    text(question, { bold: true }),
    ...detail.map((line) => text(line, { dim: true })),
    text(''),
    text('y  yes        n  no', { yellow: true })
  )
}

// The wallet narrating itself: everything note() said this session, newest at the bottom.
// A pane rather than a scrollback, because there is no scrollback on the alternate screen —
// what is not on screen is gone, so it shows the last few and the count of what it dropped.
export function Log({ lines, height = 5 }) {
  const shown = lines.slice(-height)
  const hidden = lines.length - shown.length
  return column(
    { height },
    ...shown.map((line, index) =>
      text(cut(line, 200), { dim: index < shown.length - 1, wrap: false, key: index })
    ),
    hidden > 0 ? text(`(${hidden} earlier)`, { dim: true }) : null
  )
}

// The same judgement `showQr` makes on the command line — a code wrapped mid-row is noise,
// not a smaller code — made against a pane instead of the whole terminal.
// A QR that knows when it does not fit, in either direction. Half a code is not a smaller
// code — nothing will scan it — so a pane too short for one says so and leaves the text
// above it, which is still perfectly good.
export function Qr({
  code,
  columns,
  rows = Infinity,
  fallback = 'the code is too wide for this terminal'
}) {
  if (!code) return text('')
  if (code.width > columns) return text(fallback, { yellow: true })
  if (code.lines.length > rows) {
    return text('not enough room to show the QR — copy the text above instead', { yellow: true })
  }
  return column({}, ...code.lines.map((line, index) => text(line, { wrap: false, key: index })))
}

// A one-line heading with something pushed to the right of it, which is every pane header
// in this UI: what this is, and the number that matters.
export function Header({ left, right, ...props }) {
  return row(
    { gap: 2 },
    text(left, { bold: true, grow: 1, ...props }),
    right ? text(right, { bold: true, ...props }) : null
  )
}

export { h, text, box, row, column, spacer, useState, useInput, width, useMemo }
