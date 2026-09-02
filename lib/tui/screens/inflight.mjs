// Sends that are out there and not yet known to have been claimed.
//
// These are the proofs in neither figure on the menu: already handed over, so not
// spendable, but not gone either until the mint says the receiver took them. Two things
// can be done about one — ask the mint what became of it, or take it back — and both are
// here because both change the balance.
import { h, text, column, spacer } from '../element.mjs'
import { useState, useInput } from '../runtime.mjs'
import { Panel, Detail, Select, moveSelection, Status, Hints } from '../components.mjs'
import { useTask } from '../hooks.mjs'

// Enough for any amount anyone is likely to hand over in one go, plus its unit.
const AMOUNT_WIDTH = 12

export function InFlight({ api, snapshot, onRefresh, onBack, columns = 80, focus = true }) {
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

  const busy = check.busy || reclaim.busy

  useInput(
    (key) => {
      // Leaving mid-swap would not stop the swap, only hide it, and the pane saying what
      // is happening to the money is the reason to stay.
      if (key.name === 'escape' && !busy) return onBack()
      if (pending.length) setIndex((at) => moveSelection(key, at, pending.length))
      const entry = pending[index]
      if (!entry || busy) return
      const pressed = key.input?.toLowerCase()
      if (key.name === 'return' || pressed === 'c') check.run(entry)
      if (pressed === 'x') reclaim.run(entry)
    },
    { active: focus }
  )

  return column(
    { gap: 0, grow: 1 },
    h(PendingSends, { pending, index, focus, check, reclaim }),
    h(Hints, {
      columns,
      // Nothing is offered while it settles, because nothing is accepted: escape is
      // refused until the swap is done, and a key that does nothing is worse than none.
      keys: busy
        ? []
        : pending.length
          ? [
              ['↑↓', 'pick one'],
              ['enter', 'ask the mint'],
              ['x', 'take it back'],
              ['esc', 'go back']
            ]
          : [['esc', 'go back']]
    })
  )
}

function PendingSends({ pending, index, focus, check, reclaim }) {
  if (!pending.length) {
    return h(
      Panel,
      { title: 'in flight', focus: false, grow: 1 },
      text('nothing waiting to settle', { dim: true }),
      text('a send appears here between handing the token over and the mint seeing it taken', {
        dim: true
      })
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
    text('sent, not yet known to be claimed — in none of the figures on the menu', {
      dim: true
    }),
    // The amount is the short, fixed part and the mint url the long compressible one, so
    // the amounts get a column of their own and the urls take what is left — otherwise a
    // narrow terminal squeezes `50 sat` onto two lines and the marker stops lining up.
    h(Select, { items, index, focus, labelWidth: AMOUNT_WIDTH }),
    spacer({ rows: 0 }),
    h(Status, {
      task,
      idle: 'Enter asks the mint whether it was claimed · X takes it back',
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
