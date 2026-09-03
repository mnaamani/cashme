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

// How a key is written wherever this UI names one. Capitalised, so `Enter` and `Ctrl-V`
// read as the things on the keyboard rather than as words in the sentence around them, and
// so no two screens can drift into spelling the same key differently.
//
// The binding itself stays lowercase — the handlers match either case, so a key shown as
// `C` works whether or not shift is held.
const KEYS = {
  enter: 'Enter',
  esc: 'Esc',
  escape: 'Esc',
  tab: 'Tab',
  shifttab: 'Shift-Tab',
  space: 'Space',
  home: 'Home',
  end: 'End',
  backspace: 'Backspace'
}

export function keyName(name) {
  const key = String(name)
  if (KEYS[key]) return KEYS[key]
  // ctrl-v → Ctrl-V, and the same for any other modifier spelled this way.
  const held = /^(ctrl|alt|cmd|shift)-(.+)$/.exec(key)
  if (held) return `${held[1][0].toUpperCase()}${held[1].slice(1)}-${keyName(held[2])}`
  if (/^[a-z]$/.test(key)) return key.toUpperCase()
  // Arrows and anything already written the way it should be shown.
  return key
}

// The key line along the bottom. Pairs of [key, what it does], dropped from the right when
// the terminal is too narrow — a truncated hint is worse than one fewer hint.
//
// Joined with `to`, so each reads as a sentence: `Q to quit`. Which means every label has
// to be a verb phrase that follows it — `go back`, not `back`, and `pick a send`, not
// `send`, since `↑↓ to send` would say the arrows spend money.
//
// Given `columns`, hints are dropped whole rather than the line being cut: half a hint
// tells nobody anything, and the half that goes is the end of the line — which is where
// the way out lives. So the first and the last are kept and the middle gives way, leaving
// at worst how to move and how to leave.
export function Hints({ keys, columns = 0 }) {
  const parts = keys.filter(Boolean).map(([key, label]) => `${keyName(key)} to ${label}`)
  const line = () => parts.join('   ')
  const tooWide = () => columns > 0 && width(line()) > columns
  while (parts.length > 2 && tooWide()) parts.splice(parts.length - 2, 1)
  // Down to two that still will not fit, it is the first that goes: on a terminal this
  // narrow the one thing somebody must not lose is how to get out of the screen.
  if (parts.length === 2 && tooWide()) parts.shift()
  return text(line(), { dim: true, wrap: false })
}

// The column every form label sits in. Shared so the values, and the button under them,
// line up as one column rather than three that happen to agree.
export const GUTTER = 14

// The best match for what has been typed, whole, or '' when nothing matches.
//
// Anywhere in the string, not just the front. The memorable part of a mint url is rarely
// its first characters — they are `https://` on all of them — so `cashu`, `nut` or `.space`
// are the sorts of thing somebody actually remembers, and none of those is a prefix.
// Case-insensitive for the same reason it is for hostnames generally.
//
// A prefix still wins over a match in the middle when both exist: typing the front of a url
// means that one, and it is also the match the field can finish in place rather than
// swapping out. An option equal to what was typed is not a match — there is nothing left to
// offer — which is what stops a finished field going on suggesting itself.
export function completes(typed, options = []) {
  if (!typed) return ''
  const lower = typed.toLowerCase()
  const longer = options.filter(
    (option) => option.length > typed.length && option.toLowerCase().includes(lower)
  )
  return longer.find((option) => option.toLowerCase().startsWith(lower)) ?? longer[0] ?? ''
}

// A single-line text field. Owns nothing: the value and the cursor live in the parent, so
// a form can read every field it holds without asking each one.
//
// The cursor is drawn as an inverse cell over the character it sits on, rather than by
// moving the terminal's own cursor — the runtime hides that one and repaints from the top
// left every frame, so there is nowhere to leave it.
export function Field({
  value = '',
  placeholder = '',
  focus = false,
  mask = false,
  label,
  completion = ''
}) {
  const shown = mask && value ? '•'.repeat(value.length) : value
  const body = useMemo(() => {
    const hint = placeholder ? `\x1b[2m${placeholder}\x1b[0m` : ''
    if (!focus) return shown || hint
    // The cursor is always at the end: this is a field for typing an amount or pasting a
    // token into, not an editor, and arrow keys are worth more to the screen around it.
    const cursor = '\x1b[7m \x1b[0m'
    // An empty field keeps its hint, to the right of the cursor rather than under it. The
    // form opens on its first field, so the old behaviour spent the one moment the hint is
    // worth most — before anything has been typed — hiding it behind the cursor, and told a
    // first-time user what to enter everywhere except where they were about to enter it.
    if (!shown) return `${cursor}${hint}`
    // A suggestion is never shown over a masked field: the whole point of the mask is that
    // the value is not on screen, and completing it would put it there.
    const offer = mask ? '' : completion
    // A match that starts with what was typed is finished in place — the rest of it dim,
    // with the cursor on its first character, the way a shell shows one. The field still
    // reads as ending where the typing ended, so the suggestion reads as something offered
    // rather than something already entered.
    if (offer.toLowerCase().startsWith(shown.toLowerCase())) {
      const rest = offer.slice(shown.length)
      if (rest) return `${shown}\x1b[7m${rest[0]}\x1b[0m\x1b[2m${rest.slice(1)}\x1b[0m`
    }
    // A match found in the middle of a url has no tail to append, so the whole of it is
    // offered alongside instead, behind an arrow that says it would replace what is there.
    if (offer) return `${shown}${cursor} \x1b[2m→ ${offer}\x1b[0m`
    return `${shown}${cursor}`
  }, [shown, focus, placeholder, completion, mask])

  return row(
    { gap: 1 },
    label ? text(label, { dim: !focus, width: GUTTER }) : null,
    text(body, { grow: 1, wrap: false })
  )
}

// Whether this key means "take the suggestion". Right, because left and right are the two
// the fields here do not otherwise use; and Tab, because that is the key a shell trains
// people to reach for — Tab still moves to the next field when there is nothing to accept,
// so the only cost is a second press on the way past a field that had a suggestion in it.
//
// What it takes is the whole suggestion, replacing what was typed rather than adding to it:
// a match found in the middle of a url has no tail to append, and replacing is the same
// thing as appending when the match did start at the front.
export function accepts(key, completion) {
  return Boolean(completion) && (key.name === 'right' || key.name === 'tab')
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
//
// `labelWidth` swaps which of the two columns takes up the slack. Left unset the label
// grows and the hint is pushed against the right edge, which is what a list of amounts
// against their mints wants. Set, the labels line up in a fixed column and the hints run
// on from them as a second column — a menu reads as a list of names with a sentence each,
// not as two columns drifting apart.
//
// `paint` is how a list says which row is chosen with something other than a marker and a
// bold: given a function, the chosen row's label goes through it — and only while the list
// has the keyboard, since a highlight on a list nothing is typing at would be pointing at
// something the next keystroke will not touch. It is a function rather than a colour name
// so that this file stays out of the question: what the highlight looks like belongs to
// the screen, and nothing here knows the wallet has a house style.
//
// A `null` in `items` is a blank line between groups. `index` counts only the real ones,
// so grouping a list costs the caller nothing but the nulls.
export function Select({ items, index = 0, focus = false, height, labelWidth, paint = null }) {
  let at = -1
  const rows = items.map((item, position) => {
    if (!item) return text('', { key: `gap-${position}` })
    at += 1
    const chosen = at === index
    const lit = chosen && focus && Boolean(paint)
    const marker = chosen ? (focus ? '›' : '·') : ' '
    const label = { bold: chosen, dim: !chosen && !focus }
    // A painted label brings its own styling with it, so the flags are dropped — `bold`
    // here and a bold inside the paint would be the same thing said twice, and `dim` would
    // fight it.
    const shown = lit
      ? { width: labelWidth, grow: labelWidth ? undefined : 1, wrap: false }
      : labelWidth
        ? { ...label, width: labelWidth, wrap: false }
        : { ...label, grow: 1 }
    return row(
      { gap: 1 },
      text(lit ? paint(marker) : marker, { width: 1, cyan: chosen && focus && !lit }),
      text(lit ? paint(item.label) : item.label, shown),
      // The chosen row's hint comes out of the dim with it: half a lit row is a row that
      // looks half chosen.
      item.hint
        ? text(item.hint, labelWidth ? { dim: !lit, grow: 1, wrap: false } : { dim: !lit })
        : null
    )
  })
  return column({ height }, ...rows)
}

// The thing a form is finished by. Pressing enter in a field moves on rather than sending
// — a field is a place to type, and enter after typing means "done with this", not "do the
// irreversible thing now" — so there has to be somewhere for the last enter to land.
//
// Inverse rather than a colour, so it reads as a button in whatever the terminal's palette
// is, and so it is still obviously the focused thing on a screen with no colour at all.
export function Button({ label, focus = false, ready = true }) {
  const face = ` ${label} `
  // Sat in the same column the field values are in, so it reads as the last row of the
  // form rather than something floating beneath it.
  return row(
    { gap: 1 },
    text('', { width: GUTTER }),
    focus
      ? text(face, { inverse: true, bold: ready, dim: !ready, wrap: false })
      : text(face, { dim: true, wrap: false })
  )
}

// Where the keyboard is in a form: one slot per field, plus one on the end for the button.
// Returns the new position, or the same one when the key was not about moving.
//
// Enter is a mover here, not a submitter. Only the caller knows what pressing it on the
// last slot should do, so it decides that; this decides everywhere else it goes.
export function moveFocus(key, at, count) {
  const last = count - 1
  if (key.name === 'tab' || key.name === 'down') return at >= last ? 0 : at + 1
  if (key.name === 'shifttab' || key.name === 'up') return at <= 0 ? last : at - 1
  // Enter walks forward through the fields and then stops on the button, rather than
  // wrapping round to the top — landing back in the first field after filling the last
  // one reads as the form having rejected something.
  if (key.name === 'return') return Math.min(at + 1, last)
  return at
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

// A label and a value on one line, for the detail under a question. Plain strings rather
// than elements, because that is what Confirm takes — and the alignment is the point: a
// column of values is read down, a run of sentences is not read at all.
export function said(pairs) {
  const width = Math.max(...pairs.filter(Boolean).map(([label]) => label.length))
  return pairs.filter(Boolean).map(([label, value]) => `${label.padEnd(width)}  ${value}`)
}

// A question that takes the keyboard until it is answered. Rendered by the screen that
// asks; the runtime gives it the keys first because it is deeper in the tree.
export function Confirm({ question, detail = [], onAnswer }) {
  useInput((key, { stop }) => {
    // Everything but Ctrl-C. Holding the keyboard is the point of a modal, but the runtime
    // hands keys to the deepest handler first, so a stop() here reaches the root's quit
    // handler before it and takes the session's only way out with it — leaving a question
    // that has to be answered before the wallet can be closed at all.
    if (key.name === 'ctrl-c') return
    stop()
    const pressed = key.input?.toLowerCase()
    if (pressed === 'y') onAnswer(true)
    else if (pressed === 'n' || key.name === 'escape') onAnswer(false)
  })
  return h(
    Panel,
    { title: 'confirm', focus: true, borderColor: 'yellow' },
    text(question, { bold: true }),
    ...detail.map((line) => text(line, { dim: true })),
    text(''),
    text(`${keyName('y')} to accept        ${keyName('n')} to refuse`, { yellow: true })
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

// A pane with no walls: a rule across the top and nothing either side.
//
// Every other pane here is a box, which is right until the content is something to be
// selected with a mouse. A box side sits in the middle of every drag and comes back in the
// paste, so a string somebody is expected to copy out of — an invoice, a token — gets this
// instead. The rule is horizontal only, which no downward selection crosses.
export function Rule({ title, right = '', columns = 80 }) {
  const fill = Math.max(0, columns - width(title) - width(right) - 5)
  return row(
    { gap: 1 },
    text('──', { dim: true }),
    text(title, { bold: true }),
    text('─'.repeat(fill), { dim: true, wrap: false }),
    right ? text(right, { dim: true, wrap: false }) : null
  )
}

export { h, text, box, row, column, spacer, useState, useInput, width, useMemo }
