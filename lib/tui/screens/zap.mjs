// `zap` — NIP-57: pay a nostr user over lightning, with a receipt they can show.
//
// Mechanically this is the withdraw screen with a lookup in front of it: find the
// recipient's lightning address, ask their host for an invoice, then melt against it. So
// it is confirmed the same way and shows the same melt plan, and what is added here is the
// part a withdraw has no equivalent of — who is being paid, and whether the thing that
// makes it a zap rather than a payment is actually going to happen.
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
  moveFocus,
  said
} from '../components.mjs'
import { useTask } from '../hooks.mjs'

const FIELDS = ['pubkey', 'amount', 'note', 'comment']
const SLOTS = FIELDS.length + 1
const BUTTON = FIELDS.length

export function Zap({ api, onBack, onChanged, columns = 80 }) {
  const [form, setForm] = useState({ pubkey: '', amount: '', note: '', comment: '' })
  const [at, setAt] = useState(0)
  const [plan, setPlan] = useState(null)

  const quote = useTask(async ({ pubkey, amount, comment, event }, { say }) => {
    // The last zap is over and done with. Left where it was, its `done` would still be
    // what says a payment has happened, and the question below — which is only put while
    // nothing has been paid — would never be asked for this plan.
    pay.reset()
    say(`looking up ${pubkey}`)
    const planned = await api.planZap({ pubkey, amount, comment, event })
    setPlan(planned)
    return planned.melt.payable ? 'quoted' : 'cannot be paid'
  })

  const pay = useTask(
    async (planned, { say }) => {
      say(`paying ${planned.amount} sat to ${planned.label}`)
      const result = await api.settleZap(planned)
      setPlan(null)
      const fee = result.effectiveFee === undefined ? '' : `, fee ${result.effectiveFee} sat`
      return planned.receipt
        ? `zapped ${planned.amount} sat to ${planned.label}${fee} — their relays carry the receipt`
        : `paid ${planned.amount} sat to ${planned.label}${fee}`
    },
    { onDone: onChanged }
  )

  const amount = Number(form.amount)
  const ready = form.pubkey.trim() !== '' && Number.isSafeInteger(amount) && amount > 0
  // Asked for as long as there is a payable plan nothing has been done with yet.
  const asking = Boolean(plan?.melt?.payable) && pay.status === 'idle'
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
      if (key.name === 'return' && at === BUTTON) {
        if (ready) {
          quote.run({
            pubkey: form.pubkey.trim(),
            amount,
            comment: form.comment.trim(),
            event: form.note.trim() || null
          })
        }
        return
      }
      const moved = moveFocus(key, at, SLOTS)
      if (moved !== at) return setAt(moved)
      if (key.name === 'return' || at === BUTTON) return
      const name = FIELDS[at]
      setForm((previous) => ({
        ...previous,
        [name]: editText(previous[name], key, { numeric: name === 'amount' })
      }))
    },
    // Not registered while the question stands: the confirmation has the keyboard.
    { active: !asking }
  )

  // A question owns the screen, for the reason the same one does on the nutzap screen: the
  // form under it is already filled in, and leaving it there pushes the answer keys off the
  // bottom of a short terminal.
  if (asking) {
    return column(
      { gap: 0, grow: 1 },
      h(Confirm, {
        question: `Zap ${plan.amount} sat to ${plan.label}?`,
        // The lookup is the half that could have gone somewhere unexpected — what was
        // typed is not who was found, and neither is where the sats end up — so the
        // confirmation leads with all three before it gets to the money.
        detail: [
          ...resolution(plan),
          '',
          ...plan.warnings,
          ...(plan.warnings.length ? [''] : []),
          ...plan.melt.lines
        ],
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
      { title: 'zap', focus: !busy },
      h(Field, {
        label: 'who',
        value: form.pubkey,
        focus: at === 0,
        placeholder: 'npub, hex key, or name@domain'
      }),
      h(Field, { label: 'amount', value: form.amount, focus: at === 1, placeholder: 'sats' }),
      h(Field, {
        label: 'note',
        value: form.note,
        focus: at === 2,
        // 32 bytes of hash in every form nostr writes it, which is to say a paste rather
        // than something anyone types. Checked to be theirs before an invoice is asked for.
        placeholder: 'optional, note1… or nevent1… of theirs to zap'
      }),
      h(Field, {
        label: 'comment',
        value: form.comment,
        focus: at === 3,
        placeholder: 'optional, shown with the zap'
      }),
      text(''),
      h(Button, { label: 'ask for a quote', focus: at === BUTTON, ready }),
      text(''),
      h(Status, {
        task: showing,
        idle: !ready
          ? 'a nostr key or lightning address and an amount are needed'
          : at === BUTTON
            ? 'Enter looks them up — nothing is spent until you confirm'
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
    h(Quote, { plan, grow: 1 })
  )
}

function Quote({ plan }) {
  if (!plan) {
    return h(
      Panel,
      { title: 'quote', focus: false, grow: 1 },
      text('their host quotes the invoice, so the cost is known only once asked', { dim: true })
    )
  }
  return h(
    Panel,
    { title: 'quote', focus: false, grow: 1 },
    ...resolution(plan).map((line, index) => text(line, { key: `who-${index}`, dim: index > 0 })),
    text(''),
    ...plan.warnings.map((line, index) => text(line, { key: index, yellow: true })),
    ...plan.melt.lines.map((line, index) =>
      text(line, {
        key: `melt-${index}`,
        red: !plan.melt.payable && index === plan.melt.lines.length - 1
      })
    )
  )
}

// Who this turned out to be, said the same way on the pane and in the question.
function resolution(plan) {
  return said([
    ['you typed', plan.typed],
    plan.recipient ? ['their key', plan.recipient] : null,
    ['paying', plan.label],
    plan.note ? ['on note', plan.note.id] : null,
    plan.note ? ['which says', plan.note.preview] : null,
    ['receipt', plan.receipt ? 'yes — their relays will carry it' : 'no']
  ])
}
