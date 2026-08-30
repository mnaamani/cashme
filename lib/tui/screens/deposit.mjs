// Deposit: ask a mint to issue ecash against a lightning invoice we pay.
//
// The wait is the screen. mintTokens() does not settle until the invoice is paid, so the
// invoice and its QR arrive through onQuote in the middle of the operation, and the pane
// has to show them while the same call is still running. That is the shape most of this UI
// takes — start the work, draw what it reports, and let it finish on its own.
import { h, text, column, row, spacer } from '../element.mjs'
import { useState, useInput, useMemo } from '../runtime.mjs'
import { Panel, Field, Status, Qr, Hints, editText } from '../components.mjs'
import { wrap } from '../style.mjs'
import { useTask } from '../hooks.mjs'
import { DEFAULT_MINT_URL } from '../../constants.mjs'

const FIELDS = ['amount', 'mint', 'unit']

// Three fields, a blank, a status line and the pane's two borders — what the form takes,
// so the pane below it knows what is left.
const FORM_HEIGHT = 7

export function Deposit({ api, columns, height = 24, onBack, onChanged }) {
  const [form, setForm] = useState({ amount: '', mint: DEFAULT_MINT_URL, unit: 'sat' })
  const [at, setAt] = useState(0)
  const [invoice, setInvoice] = useState(null)

  const mint = useTask(
    async ({ amount, mintUrl, unit }, { say }) => {
      say(`asking ${mintUrl} for an invoice`)
      await api.deposit({
        amount,
        unit,
        mintUrl,
        onQuote: (quote) => {
          setInvoice(quote.request)
          say('waiting for the invoice to be paid')
        }
      })
      return `${amount} ${unit} minted`
    },
    { onDone: onChanged }
  )

  // Uppercase encodes in the QR's alphanumeric mode rather than byte mode — about half the
  // bits, which is the difference between a code that fits this pane and one that does
  // not. bolt11 is bech32, so a wallet reads either.
  const code = useMemo(() => (invoice ? api.qr(invoice.toUpperCase()) : null), [invoice])

  const amount = Number(form.amount)
  const ready = Number.isSafeInteger(amount) && amount > 0 && form.mint.trim() !== ''

  useInput((key) => {
    if (mint.busy) {
      // Nothing to type into: the operation is with the mint now, and the only way out is
      // to stop watching it. The deposit itself is finished by the next run either way —
      // settleInFlightMints picks up a quote this one walked away from.
      if (key.name === 'escape') onBack()
      return
    }
    if (key.name === 'escape') return onBack()
    if (key.name === 'tab' || key.name === 'down') return setAt((i) => (i + 1) % FIELDS.length)
    if (key.name === 'shifttab' || key.name === 'up') {
      return setAt((i) => (i - 1 + FIELDS.length) % FIELDS.length)
    }
    if (key.name === 'return') {
      if (ready) mint.run({ amount, mintUrl: form.mint.trim(), unit: form.unit.trim() || 'sat' })
      return
    }
    const name = FIELDS[at]
    setForm((previous) => ({
      ...previous,
      [name]: editText(previous[name], key, { numeric: name === 'amount' })
    }))
  })

  return column(
    { gap: 0, grow: 1 },
    h(
      Panel,
      { title: 'deposit', focus: !mint.busy },
      h(Field, { label: 'amount', value: form.amount, focus: at === 0, placeholder: 'sats' }),
      h(Field, { label: 'mint', value: form.mint, focus: at === 1 }),
      h(Field, { label: 'unit', value: form.unit, focus: at === 2 }),
      text(''),
      h(Status, {
        task: mint,
        idle: ready ? 'enter asks the mint for an invoice' : 'an amount is needed',
        done: mint.result ?? 'minted'
      })
    ),
    invoice
      ? h(
          Panel,
          { title: 'pay this invoice', focus: true, grow: 1 },
          text(invoice, { wrap: true, dim: mint.status === 'done' }),
          text(''),
          h(Qr, {
            code,
            columns: columns - 4,
            // What the pane has left under the invoice itself, which wraps to however
            // many lines this terminal's width makes of it.
            rows: height - FORM_HEIGHT - 2 - wrap(invoice, columns - 4).length - 1,
            fallback: 'the invoice is too long to show as a QR here — copy the text above'
          })
        )
      : h(
          Panel,
          { title: 'pay this invoice', focus: false, grow: 1 },
          text('the invoice appears here once the mint has quoted', { dim: true })
        ),
    h(Hints, {
      keys: mint.busy
        ? [['esc', 'stop watching']]
        : [
            ['tab', 'next field'],
            ['enter', 'deposit'],
            ['esc', 'back']
          ]
    })
  )
}
