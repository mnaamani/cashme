// The way in: what the wallet holds, and a list of what can be done with it.
//
// Every action used to be a letter pressed on the dashboard, which meant the only record
// of what this UI could do was the hint line along the bottom. A list walked with the
// arrow keys says the same thing where the user is already looking, gives each action room
// for a sentence about itself, and leaves the letters to the screens that come after.
//
// The balances stay here rather than moving behind an entry of their own. A wallet that
// has to be navigated before it will say what it is worth is a worse wallet, and the list
// is short enough that both fit.
import { h, text, row, column } from '../element.mjs'
import { useState, useInput, useMemo } from '../runtime.mjs'
import { Panel, Header, Select, moveSelection } from '../components.mjs'

// `route` is where enter goes. The hint is phrased as what the action does rather than
// what it is called, because the label already says what it is called.
const ACTIONS = [
  { route: 'settings', label: 'settings', hint: 'where this session runs and what it wears' },
  { route: 'deposit', label: 'deposit', hint: 'mint ecash against a lightning invoice' },
  { route: 'give', label: 'give', hint: 'hand ecash to someone' },
  { route: 'receive', label: 'receive', hint: 'claim a token someone gave you' },
  { route: 'withdraw', label: 'withdraw', hint: 'pay a lightning invoice' },
  { route: 'inflight', label: 'in flight', hint: 'sends not yet known to be claimed' }
]

// The widest label plus a space, fixed so the hints line up into a column rather than
// ragging against the labels.
const LABEL_WIDTH = 10

// What one row costs before its hint: the marker, the label column, and the gap either
// side of them, inside a pane that spends four columns on borders and padding.
const ROW_OVERHEAD = 4 + 1 + 1 + LABEL_WIDTH + 1

// A hint cut mid-word says less than no hint at all, and the labels are the part that has
// to survive — so on a terminal too narrow for the longest one they all go together,
// rather than some rows explaining themselves and others trailing off.
function hintsFit(items, columns) {
  return items.every((item) => item.hint.length <= columns - ROW_OVERHEAD)
}

export function Menu({ snapshot, columns = 80, onOpen, focus = true }) {
  const [index, setIndex] = useState(0)

  // In flight is the one entry whose hint is a fact about this wallet rather than a
  // description of the screen behind it: how many sends are outstanding is the whole
  // reason to go and look.
  const pending = snapshot?.pending ?? []
  const items = useMemo(
    () =>
      ACTIONS.map((action) =>
        action.route === 'inflight'
          ? {
              ...action,
              hint: pending.length
                ? `${pending.length} waiting to settle`
                : 'nothing waiting to settle'
            }
          : action
      ),
    [pending.length]
  )

  useInput(
    (key) => {
      setIndex((at) => moveSelection(key, at, items.length))
      if (key.name === 'return') onOpen(items[index].route)
    },
    { active: focus }
  )

  const shown = hintsFit(items, columns) ? items : items.map((item) => ({ ...item, hint: null }))

  return column(
    { gap: 0, grow: 1 },
    h(Balances, { snapshot, columns }),
    h(
      Panel,
      { title: 'actions', focus, grow: 1 },
      h(Select, { items: shown, index, focus, labelWidth: LABEL_WIDTH })
    )
  )
}

// A mint url is the widest thing on this screen and the least compressible — it is how
// the user tells one custodian from another. So on a narrow terminal the columns beside it
// give way first: the reserved figure moves to a line of its own under the list rather
// than taking twelve columns off every row, and https:// goes the way a browser drops it.
// http:// stays, because there the scheme is the point.
const NARROW = 64

function shortMint(mintUrl, narrow) {
  return narrow ? mintUrl.replace(/^https:\/\//, '') : mintUrl
}

export function Balances({ snapshot, columns }) {
  const held = snapshot?.held ?? []
  const totals = snapshot?.totals ?? []
  const narrow = columns < NARROW
  const reserved = held.filter((entry) => entry.reserved)

  const rows = held.length
    ? held.map((entry, at) =>
        row(
          { gap: 1, key: at },
          text(shortMint(entry.mintUrl, narrow), { grow: 1, wrap: false }),
          text(`${entry.spendable} ${entry.unit}`, {
            bold: true,
            width: narrow ? 12 : 14,
            align: 'right'
          }),
          narrow
            ? null
            : text(entry.reserved ? `${entry.reserved} held` : '', {
                dim: true,
                width: 12,
                align: 'right'
              })
        )
      )
    : [
        text(snapshot ? 'no ecash yet — choose deposit below' : 'reading the wallet…', {
          dim: true
        })
      ]

  // Said once, under the list, rather than per row: what matters is that some of the
  // balance above is not spendable right now, not which line it is on.
  if (narrow && reserved.length) {
    const total = reserved.reduce((sum, entry) => sum + entry.reserved, 0)
    rows.push(text(`${total} held by an unfinished operation`, { dim: true }))
  }

  return h(
    Panel,
    { title: 'balances', focus: false },
    h(Header, {
      left: 'mint',
      right: totals.length
        ? totals.map((total) => `${total.spendable} ${total.unit}`).join('  ')
        : '0 sat'
    }),
    ...rows
  )
}
