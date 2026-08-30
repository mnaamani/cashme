// Withdraw: melt ecash back to lightning by paying an invoice.
//
// Two steps on purpose, and the split is the same one `cashme withdraw` makes — planMelt
// touches no proofs, so the mint can be asked what the payment costs and the answer put on
// screen while nothing is committed. Only the confirmation reserves anything. The rules
// about what is payable are not restated here: the plan carries its own explanation, and
// this screen shows it.
import { h, text, column } from '../element.mjs'
import { useState, useInput } from '../runtime.mjs'
import { Panel, Field, Status, Confirm, Hints, editText } from '../components.mjs'
import { useTask } from '../hooks.mjs'

export function Withdraw({ api, onBack, onChanged }) {
  const [invoice, setInvoice] = useState('')
  const [mint, setMint] = useState('')
  const [at, setAt] = useState(0)
  const [plan, setPlan] = useState(null)

  const quote = useTask(async ({ bolt11, mintUrl }, { say }) => {
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

  const asking = Boolean(plan?.payable) && !pay.busy && pay.status === 'idle'
  const busy = quote.busy || pay.busy

  useInput(
    (key) => {
      if (busy) return
      if (asking) return // the confirmation has the keyboard
      if (key.name === 'escape') {
        if (plan) return setPlan(null)
        return onBack()
      }
      if (key.name === 'tab' || key.name === 'up' || key.name === 'down') {
        return setAt((i) => (i + 1) % 2)
      }
      if (key.name === 'return') {
        if (invoice.trim()) quote.run({ bolt11: invoice.trim(), mintUrl: mint.trim() || null })
        return
      }
      if (at === 0) setInvoice((previous) => editText(previous, key))
      else setMint((previous) => editText(previous, key))
    },
    { active: !asking }
  )

  return column(
    { gap: 0, grow: 1 },
    h(
      Panel,
      { title: 'withdraw', focus: !busy && !asking },
      h(Field, { label: 'invoice', value: invoice, focus: at === 0, placeholder: 'lnbc…' }),
      h(Field, {
        label: 'mint',
        value: mint,
        focus: at === 1,
        placeholder: 'whichever holds the most'
      }),
      text(''),
      h(Status, {
        task: pay.status === 'idle' ? quote : pay,
        idle: 'enter asks for a quote — nothing is spent until you confirm',
        done: (pay.status === 'idle' ? quote.result : pay.result) ?? 'done'
      })
    ),
    asking
      ? h(Confirm, {
          question: 'Pay this invoice?',
          detail: plan.lines,
          onAnswer: (yes) => (yes ? pay.run(plan) : setPlan(null))
        })
      : h(
          Panel,
          { title: 'quote', focus: false, grow: 1 },
          ...(plan
            ? plan.lines.map((line, index) =>
                text(line, { key: index, red: !plan.payable && index === plan.lines.length - 1 })
              )
            : [
                text('the mint quotes the fee, so the cost is known only once asked', { dim: true })
              ])
        ),
    h(Hints, {
      keys: asking
        ? [
            ['y', 'pay'],
            ['n', 'cancel']
          ]
        : busy
          ? []
          : [
              ['tab', 'next field'],
              ['enter', 'quote'],
              ['esc', plan ? 'clear' : 'back']
            ]
    })
  )
}
