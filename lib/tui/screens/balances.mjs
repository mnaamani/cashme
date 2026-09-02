// What each mint holds, and in what.
//
// The menu shows one number, because one number is what you check. This is the other
// question: a cashu balance is a set of proofs of fixed denominations, and which ones are
// held decides what can be handed over without going back to the mint for change. 200 sat
// as a 128, a 64 and an 8 cannot pay 100 in one move. The count is the other half of it —
// a wallet carrying a hundred 1-sat crumbs spends slowly and swaps often.
import { h, text, row, column } from '../element.mjs'
import { useState, useInput } from '../runtime.mjs'
import { Panel, Hints, moveSelection } from '../components.mjs'
import { usePoll } from '../hooks.mjs'

const NARROW = 64

export function Balances({ api, onBack, columns = 80, focus = true }) {
  const [at, setAt] = useState(0)
  const mints = usePoll(() => api.mints(), [])
  const held = mints.value ?? []

  useInput(
    (key) => {
      if (key.name === 'escape') return onBack()
      if (key.input?.toLowerCase() === 'r') return mints.refresh()
      setAt((i) => moveSelection(key, i, held.length))
    },
    { active: focus }
  )

  return column(
    { gap: 0, grow: 1 },
    h(
      Panel,
      { title: held.length ? `mints (${held.length})` : 'mints', focus, grow: 1 },
      ...body({ mints, held, at, focus, columns })
    ),
    h(Hints, {
      columns,
      keys: [held.length > 1 ? ['↑↓', 'move'] : null, ['r', 'read again'], ['esc', 'go back']]
    })
  )
}

function body({ mints, held, at, focus, columns }) {
  if (mints.error) return [text(`✗ ${mints.error.message}`, { red: true })]
  if (!mints.value) return [text('reading the wallet…', { dim: true })]
  if (!held.length) return [text('no ecash yet — deposit some, or claim a token', { dim: true })]

  return held.flatMap((mint, index) => [
    h(Mint, { mint, focus: focus && index === at, columns, key: mint.mintUrl }),
    h(Proofs, { mint, key: `${mint.mintUrl}/proofs` })
  ])
}

// The mint and what it is worth. One line per unit, because a mint issuing two of them
// holds two balances and adding them would report a number that is true of neither.
function Mint({ mint, focus, columns }) {
  const narrow = columns < NARROW
  const name = narrow ? mint.mintUrl.replace(/^https:\/\//, '') : mint.mintUrl
  const worth = mint.units.length
    ? mint.units.map((unit) => `${unit.spendable} ${unit.unit}`).join('  ')
    : '0'
  return row(
    { gap: 1 },
    text(focus ? '›' : ' ', { width: 1, cyan: focus }),
    text(name, { grow: 1, wrap: false, bold: focus }),
    text(worth, { bold: true, wrap: false })
  )
}

// The denominations under each unit, biggest first — the order they are spent in, and the
// order that shows at a glance whether the change to make a given amount is there.
//
// One block per unit, named only when there is more than one: a mint issuing sat alone has
// nothing to disambiguate, and a label on every line would be noise on the common case.
function Proofs({ mint }) {
  const named = mint.units.length > 1
  return column({}, ...mint.units.flatMap((unit) => holding(unit, named)))
}

function holding(unit, named) {
  const counted = unit.denominations
    .map(({ amount, count }) => (count > 1 ? `${amount}×${count}` : `${amount}`))
    .join('  ')

  const said = [`${unit.proofs} ${unit.proofs === 1 ? 'proof' : 'proofs'}`]
  // Two different numbers, so they are said as two: how many proofs an operation is
  // holding, and what they come to.
  if (unit.reservedProofs) {
    const worth = unit.reserved ? `, ${unit.reserved} ${unit.unit}` : ''
    said.push(`${unit.reservedProofs} reserved by an unfinished operation${worth}`)
  }

  const line = (value, key) =>
    row({ gap: 1, key }, text('', { width: 2 }), text(value, { dim: true, grow: 1, wrap: true }))

  return [
    line(`${named ? `${unit.unit} · ` : ''}${said.join(' · ')}`, `${unit.unit}/said`),
    counted ? line(counted, `${unit.unit}/counted`) : null
  ]
}

// The one number the menu shows. Here so that the screen that owns balances owns this too,
// rather than the menu growing its own idea of what a total is.
export function Total({ snapshot }) {
  const totals = snapshot?.totals ?? []
  const said = totals.length
    ? totals.map((total) => `${total.spendable} ${total.unit}`).join('   ')
    : snapshot
      ? '0 sat'
      : 'reading the wallet…'
  return h(
    Panel,
    { title: 'balance', focus: false },
    text(said, { bold: Boolean(totals.length), dim: !snapshot })
  )
}
