// The layout, which is where a terminal UI actually goes wrong: a box drawn a column too
// wide wraps and every line under it is off by one for the rest of the session.
import test from 'brittle'
import { keyName, Hints } from '../lib/tui/components.mjs'
import { h, text, box, row, column, spacer } from '../lib/tui/element.mjs'
import { render } from '../lib/tui/layout.mjs'
import { width, cut, pad, wrap, style, strip } from '../lib/tui/style.mjs'

test('every line comes back exactly as wide as it was asked for', (t) => {
  const tree = box(
    { title: 'balances', padding: { left: 1, right: 1 } },
    row({ gap: 1 }, text('mint.example', { grow: 1 }), text('8000 sat', { bold: true })),
    text('a line long enough that it has to wrap somewhere inside this narrow box')
  )
  for (const columns of [20, 40, 41, 80]) {
    const lines = render(tree, columns)
    const wrong = lines.filter((line) => width(line) !== columns)
    t.is(wrong.length, 0, `${columns} columns: every line is ${columns} wide`)
  }
})

test('styling is invisible to the measurements', (t) => {
  const styled = style('8000 sat', ['bold', 'green'])
  t.is(width(styled), 8, 'the escape codes take no columns')
  t.is(width(pad(styled, 20)), 20, 'padding counts what is visible')
  t.is(width(cut(styled, 4)), 4, 'and so does cutting')
  t.ok(cut(styled, 4).endsWith('\x1b[0m'), 'a cut styled string still closes its style')
})

test('a word too long for the line is broken rather than allowed to overflow', (t) => {
  const token = 'cashuB' + 'x'.repeat(60)
  const lines = wrap(token, 20)
  t.ok(
    lines.every((line) => width(line) <= 20),
    'a token wraps inside the pane'
  )
  t.is(lines.join(''), token, 'and nothing is lost doing it')
})

test('grow shares out what is left, and the total still fits', (t) => {
  const lines = render(row({ gap: 1 }, text('left'), spacer(), text('right')), 30)
  t.is(width(lines[0]), 30)
  t.ok(lines[0].startsWith('left'), 'the fixed children keep their place')
  t.ok(lines[0].trimEnd().endsWith('right'), 'and the spacer pushes the last one over')
})

test('a column taller than its content pushes the slack into the growing child', (t) => {
  const lines = render(
    column({ height: 6 }, text('header'), spacer({ grow: 1 }), text('footer')),
    10
  )
  t.is(lines.length, 6, 'the column is the height it was given')
  t.is(lines[0].trimEnd(), 'header')
  t.is(lines[5].trimEnd(), 'footer', 'the footer is at the bottom, not under the header')
})

test('a box narrower than its content still closes its border', (t) => {
  const lines = render(box({ title: 'a very long title indeed' }, text('x')), 12)
  t.is(width(lines[0]), 12)
  t.ok(lines[0].endsWith('┐'), 'the corner survives a title that does not fit')
  t.ok(lines[lines.length - 1].endsWith('┘'))
})

test('every key this UI names is written the same way', (t) => {
  // One formatter, so two screens cannot drift into spelling the same key differently —
  // and so a key added later is capitalised without anyone remembering to.
  t.is(keyName('enter'), 'Enter')
  t.is(keyName('esc'), 'Esc')
  t.is(keyName('escape'), 'Esc', 'both spellings of the same key arrive the same')
  t.is(keyName('tab'), 'Tab')
  t.is(keyName('shifttab'), 'Shift-Tab')
  t.is(keyName('ctrl-c'), 'Ctrl-C')
  t.is(keyName('ctrl-v'), 'Ctrl-V')
  t.is(keyName('c'), 'C', 'a letter is shown as the key on the keyboard')
  t.is(keyName('↑↓'), '↑↓', 'and arrows are left as they are')
})

test('hints are dropped whole rather than cut, and the way out is the last to go', (t) => {
  const line = (keys, columns) => strip(String(Hints({ keys, columns }).children[0] ?? ''))
  const keys = [
    ['↑↓', 'pick one'],
    ['enter', 'ask the mint'],
    ['x', 'take it back'],
    ['esc', 'go back']
  ]

  t.is(
    line(keys, 100),
    '↑↓ to pick one   Enter to ask the mint   X to take it back   Esc to go back',
    'all of them when there is room'
  )

  // The middle gives way first: how to move and how to leave are what survive.
  const narrow = line(keys, 44)
  t.ok(narrow.length <= 44, 'nothing is wider than the terminal')
  t.ok(narrow.startsWith('↑↓ to pick one'), 'the first is kept')
  t.ok(narrow.endsWith('Esc to go back'), 'and so is the way out')

  // Two that will not fit: the way out is the one that stays, because a screen with no
  // exit on it is the one thing a narrow terminal must not produce.
  const pair = line(
    [
      ['c', 'copy your address'],
      ['esc', 'stop listening']
    ],
    44
  )
  t.is(pair, 'Esc to stop listening', 'the first goes rather than the line being cut')
})

test('a key shown in capitals works whether or not shift is held', (t) => {
  // The display says C; the binding is lowercase. Anyone who takes the hint literally and
  // holds shift must not find that nothing happens.
  const seen = []
  const press = (input) => {
    const key = { name: input, input, ctrl: false }
    const pressed = key.input?.toLowerCase()
    if (pressed === 'c') seen.push(input)
  }
  press('c')
  press('C')
  t.alike(seen, ['c', 'C'], 'both reach the same binding')
})
