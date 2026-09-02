// Withdraw: melt ecash back to lightning by paying an invoice.
//
// Two steps on purpose, and the split is the same one `cashme withdraw` makes — planMelt
// touches no proofs, so the mint can be asked what the payment costs and the answer put on
// screen while nothing is committed. Only the confirmation reserves anything. The rules
// about what is payable are not restated here: the plan carries its own explanation, and
// this screen shows it.
import { h, text, column } from '../element.mjs'
import { useState, useInput } from '../runtime.mjs'
import {
  Panel,
  Field,
  Button,
  Status,
  Confirm,
  Hints,
  editText,
  moveFocus
} from '../components.mjs'
import { useTask } from '../hooks.mjs'

// The two fields, and the button that asks the mint what the invoice costs.
const SLOTS = 3
const BUTTON = 2

export function Withdraw({ api, onBack, onChanged, columns = 80 }) {
  const [invoice, setInvoice] = useState('')
  const [mint, setMint] = useState('')
  const [at, setAt] = useState(0)
  const [plan, setPlan] = useState(null)

  const quote = useTask(async ({ bolt11, mintUrl }, { say }) => {
    // The payment from the last invoice is over and done with. Left where it was, its
    // `done` would still be what says a payment has happened, and the question below —
    // which is only asked while nothing has been paid — would never be put for this plan.
    pay.reset()
    say('asking the mint what this costs')
    const planned = await api.planWithdraw({ invoice: bolt11, mint: mintUrl })
    setPlan(planned)
    return planned.payable ? 'quoted' : 'cannot be paid'
  })

  const pay = useTask(
    async (planned, { say }) => {
      say(`paying ${planned.quote.amount} ${planned.unit} through ${planned.mintUrl}`)
      const result = await api.settleWithdraw(planned)
      setPlan(null)
      const change =
        result.changeAmount === undefined ? '' : `, ${result.changeAmount} ${planned.unit} change`
      const fee =
        result.effectiveFee === undefined ? '' : `, fee ${result.effectiveFee} ${planned.unit}`
      return `paid${change}${fee}`
    },
    { onDone: onChanged }
  )

  // Asked for as long as there is a payable plan nothing has been done with yet.
  const asking = Boolean(plan?.payable) && pay.status === 'idle'
  const busy = quote.busy || pay.busy
  // Whichever half of the two-step has something to say: the quote until a payment starts.
  const showing = pay.status === 'idle' ? quote : pay

  useInput(
    (key) => {
      if (busy) return
      if (key.name === 'escape') {
        if (plan) return setPlan(null)
        return onBack()
      }
      // Nothing is spent by this button — it asks for a quote, and the confirmation after
      // it is what spends. Enter in a field still only moves on, so the shape is the same
      // as everywhere else and neither step is reached by a stray keystroke.
      if (key.name === 'return' && at === BUTTON) {
        if (invoice.trim()) quote.run({ bolt11: invoice.trim(), mintUrl: mint.trim() || null })
        return
      }
      const moved = moveFocus(key, at, SLOTS)
      if (moved !== at) return setAt(moved)
      if (key.name === 'return' || at === BUTTON) return
      if (at === 0) setInvoice((previous) => editText(previous, key))
      else setMint((previous) => editText(previous, key))
    },
    // Not registered while the question stands: the confirmation has the keyboard.
    { active: !asking }
  )

  // A question owns the screen, as it does on the zap and nutzap screens. The form under
  // it is already filled in, and leaving it there is what pushes the answer keys off the
  // bottom of a short terminal — a confirmation whose Y and N are not on screen is not a
  // confirmation, and this is the one that spends.
  if (asking) {
    return column(
      { gap: 0, grow: 1 },
      h(Confirm, {
        question: 'Pay this invoice?',
        detail: plan.lines,
        onAnswer: (yes) => (yes ? pay.run(plan) : setPlan(null))
      }),
      h(Hints, {
        columns,
        keys: [
          ['y', 'pay'],
          ['n', 'cancel']
        ]
      })
    )
  }

  return column(
    { gap: 0, grow: 1 },
    h(
      Panel,
      { title: 'withdraw', focus: !busy },
      h(Field, { label: 'invoice', value: invoice, focus: at === 0, placeholder: 'lnbc…' }),
      h(Field, {
        label: 'mint',
        value: mint,
        focus: at === 1,
        placeholder: 'whichever holds the most'
      }),
      text(''),
      h(Button, { label: 'ask for a quote', focus: at === BUTTON, ready: invoice.trim() !== '' }),
      text(''),
      h(Status, {
        task: showing,
        idle:
          at === BUTTON
            ? 'Enter asks for a quote — nothing is spent until you confirm'
            : 'Enter moves on — the button below asks for a quote',
        done: showing.result ?? 'done'
      })
    ),
    h(Hints, {
      columns,
      keys: busy
        ? []
        : [
            ['↑↓', 'move'],
            ['enter', at === BUTTON ? 'ask for a quote' : 'move on'],
            ['esc', plan ? 'clear it' : 'go back']
          ]
    }),
    h(
      Panel,
      { title: 'quote', focus: false, grow: 1 },
      ...(plan
        ? plan.lines.map((line, index) =>
            text(line, { key: index, red: !plan.payable && index === plan.lines.length - 1 })
          )
        : [text('the mint quotes the fee, so the cost is known only once asked', { dim: true })])
    )
  )
}
