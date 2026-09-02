// The way in: what the wallet holds, and a list of what can be done with it.
//
// Every action used to be a letter pressed on the dashboard, which meant the only record
// of what this UI could do was the hint line along the bottom. A list walked with the
// arrow keys says the same thing where the user is already looking, gives each action room
// for a sentence about itself, and leaves the letters to the screens that come after.
//
// The total stays here rather than moving behind an entry of their own: a wallet that has
// to be navigated before it will say what it is worth is a worse wallet. What it is made
// of — which mints, which denominations — is a different question and gets its own screen,
// because the answer is long and is not what anybody opens the wallet to check.
import { h, column } from '../element.mjs'
import { useState, useInput, useMemo } from '../runtime.mjs'
import { Panel, Select, moveSelection } from '../components.mjs'
import { Total } from './balances.mjs'

// `route` is where enter goes. The hint is phrased as what the action does rather than
// what it is called, because the label already says what it is called.
//
// Three groups, because they are three kinds of thing and a flat list of nine makes the
// reader sort them every time: what this wallet is and holds, what it can do with it, and
// who it can pay on nostr. Only the blank lines say so — a heading per group would cost
// three more rows to say what a gap already says.
const GROUPS = [
  [
    { route: 'settings', label: 'settings', hint: 'where this session runs and what it wears' },
    { route: 'balances', label: 'balances', hint: 'what each mint holds, and in what' },
    { route: 'inflight', label: 'in flight', hint: 'sends not yet known to be claimed' }
  ],
  [
    { route: 'deposit', label: 'deposit', hint: 'mint ecash against a lightning invoice' },
    { route: 'give', label: 'give', hint: 'hand ecash to someone' },
    { route: 'receive', label: 'receive', hint: 'claim a token someone gave you' },
    { route: 'withdraw', label: 'withdraw', hint: 'pay a lightning invoice' }
  ],
  [
    { route: 'zap', label: 'zap', hint: 'pay a nostr user over lightning, with a receipt' },
    { route: 'nutzap', label: 'nutzap', hint: 'send ecash to a nostr user, locked to their key' }
  ]
]

// The actions as the keyboard sees them: one flat list, in the order they are shown.
const ACTIONS = GROUPS.flat()

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

export function Menu({ snapshot, columns = 80, onOpen, from = null, focus = true }) {
  // Where the keyboard starts. The menu is unmounted while a screen is open, so this runs
  // afresh on every return — `from` is the action just left, and starting on it is what
  // makes escape feel like closing something rather than being sent back to the top.
  const [index, setIndex] = useState(() => {
    const at = ACTIONS.findIndex((action) => action.route === from)
    return at < 0 ? 0 : at
  })

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

  // The same list with a blank between each group. Select counts only the real rows, so
  // the gaps cost the selection nothing.
  const shownGroups = useMemo(() => {
    const spaced = []
    let taken = 0
    for (const group of GROUPS) {
      if (spaced.length) spaced.push(null)
      spaced.push(...items.slice(taken, taken + group.length))
      taken += group.length
    }
    return spaced
  }, [items])

  useInput(
    (key) => {
      setIndex((at) => moveSelection(key, at, items.length))
      if (key.name === 'return') onOpen(items[index].route)
    },
    { active: focus }
  )

  const shown = hintsFit(items, columns)
    ? shownGroups
    : shownGroups.map((item) => (item ? { ...item, hint: null } : null))

  return column(
    { gap: 0, grow: 1 },
    h(Total, { snapshot }),
    h(
      Panel,
      { title: 'actions', focus, grow: 1 },
      h(Select, { items: shown, index, focus, labelWidth: LABEL_WIDTH })
    )
  )
}
