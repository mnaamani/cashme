// What the wallet is worth, where it is held, and what is still in the air.
//
// The three numbers here are not the same number and the screen has to keep them apart:
// spendable is what a send can draw on now, reserved is held by an operation this run has
// not finished with, and a pending send is a token already out there whose proofs are in
// neither figure. `cashme balance` explains that in three lines of prose at the end; here
// there is room to show it as three columns and let the layout do the explaining.
import { h, text, row, column, spacer } from '../element.mjs'
import { useState, useInput } from '../runtime.mjs'
import { Panel, Header, Detail, Select, moveSelection, Status } from '../components.mjs'
import { useTask } from '../hooks.mjs'

export function Dashboard({ api, snapshot, onRefresh, columns = 80, focus = true }) {
  const [index, setIndex] = useState(0)
  const pending = snapshot?.pending ?? []

  // Asking the mint what became of a send, and taking one back. Both change the balance,
  // so both refresh the screen when they finish.
  const check = useTask(
    async (operation, { say }) => {
      say(`asking ${operation.mintUrl} about ${operation.amount} ${operation.unit}`)
      const current = await api.refresh(operation.id)
      return current.state === 'pending' ? 'still unclaimed' : 'claimed by the receiver'
    },
    { onDone: onRefresh }
  )

  const reclaim = useTask(
    async (entry, { say }) => {
      if (entry.method === 'p2pk') {
        throw new Error('locked to the recipient — a nutzap cannot be reclaimed')
      }
      say(`swapping ${entry.amount} ${entry.unit} back at ${entry.mintUrl}`)
      await api.reclaim(entry.operation)
      return `reclaimed ${entry.amount} ${entry.unit}`
    },
    { onDone: onRefresh }
  )

  useInput(
    (key) => {
      if (pending.length) setIndex((at) => moveSelection(key, at, pending.length))
      const entry = pending[index]
      if (!entry) return
      if (key.name === 'return' || key.input === 'c') check.run(entry)
      if (key.input === 'x') reclaim.run(entry)
    },
    { active: focus }
  )

  return column(
    { gap: 0, grow: 1 },
    h(Balances, { snapshot, columns }),
    h(PendingSends, { pending, index, focus, check, reclaim })
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

function Balances({ snapshot, columns }) {
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
    : [text(snapshot ? 'no ecash yet — press d to deposit' : 'reading the wallet…', { dim: true })]

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

function PendingSends({ pending, index, focus, check, reclaim }) {
  if (!pending.length) {
    return h(
      Panel,
      { title: 'in flight', focus: false, grow: 1 },
      text('nothing waiting to settle', { dim: true })
    )
  }

  const items = pending.map((entry) => ({
    label: `${entry.amount} ${entry.unit}`,
    hint: entry.mintUrl
  }))

  // The busier of the two tasks is the one worth reporting: only one can run at a time.
  const task = check.busy || check.status !== 'idle' ? check : reclaim

  return h(
    Panel,
    { title: `in flight (${pending.length})`, focus, grow: 1 },
    text('sent, not yet known to be claimed — in none of the figures above', { dim: true }),
    h(Select, { items, index, focus }),
    spacer({ rows: 0 }),
    h(Status, {
      task,
      idle: 'enter asks the mint whether it was claimed · x takes it back',
      done: task.result ?? 'done'
    })
  )
}

// The reserved figure needs saying somewhere, and it is only true when there is one.
export function ReservedNote({ snapshot }) {
  const reserved = (snapshot?.held ?? []).filter((entry) => entry.reserved)
  if (!reserved.length) return null
  return h(Detail, {
    label: 'held',
    value: 'reserved by an operation this run has not finished with',
    dim: true
  })
}
