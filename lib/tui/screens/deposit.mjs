// Deposit: ask a mint to issue ecash against a lightning invoice we pay.
//
// The wait is the screen. mintTokens() does not settle until the invoice is paid, so the
// invoice and its QR arrive through onQuote in the middle of the operation, and the pane
// has to show them while the same call is still running. That is the shape most of this UI
// takes — start the work, draw what it reports, and let it finish on its own.
import { h, text, column } from '../element.mjs'
import { useState, useInput, useMemo } from '../runtime.mjs'
import {
  Panel,
  Field,
  Button,
  Status,
  Qr,
  Rule,
  Hints,
  editText,
  moveFocus,
  completes,
  accepts
} from '../components.mjs'
import { wrap } from '../style.mjs'
import { useTask } from '../hooks.mjs'

const FIELDS = ['amount', 'mint', 'unit']

// The fields plus the button on the end, which is the slot enter has to land on before
// anything is asked of the mint.
const SLOTS = FIELDS.length + 1
const BUTTON = FIELDS.length

// Three fields, a blank, a status line and the pane's two borders — what the form takes,
// so the pane below it knows what is left.
const FORM_HEIGHT = 7

export function Deposit({ api, snapshot, columns, height = 24, onBack, onChanged }) {
  // The mint is not filled in for you. Which one to deposit at is the decision to trust it,
  // and a form that arrives with an answer already typed in is one people press enter
  // through — see mintFlag in lib/cli/ui.mjs for the same reasoning on the command line.
  const [form, setForm] = useState({ amount: '', mint: '', unit: api.defaultUnit })
  const [at, setAt] = useState(0)
  const [invoice, setInvoice] = useState(null)
  const [copied, setCopied] = useState(null)

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

  // What the mint field would complete to. The mints this wallet trusts are already in the
  // snapshot every screen is handed, so this costs no read of its own.
  const completion = at === 1 ? completes(form.mint, snapshot?.mints ?? []) : ''

  const amount = Number(form.amount)
  const amountReady = Number.isSafeInteger(amount) && amount > 0
  const ready = amountReady && form.mint.trim() !== ''

  useInput((key) => {
    if (mint.busy) {
      // Nothing to type into: the operation is with the mint now, and the only way out is
      // to stop watching it. The deposit itself is finished by the next run either way —
      // settleInFlightMints picks up a quote this one walked away from.
      if (key.name === 'escape') onBack()
      // Which is also why `c` is safe to bind here and nowhere else on this screen: with
      // no field taking keystrokes it cannot be a character somebody meant for the mint
      // url, and this is the whole of the time the invoice is worth copying.
      if (key.input?.toLowerCase() === 'c' && invoice) {
        api.copy(invoice).then((copier) => setCopied(copier || 'nothing to copy with'))
      }
      return
    }
    if (key.name === 'escape') return onBack()
    // Enter on the button is the only thing that starts a deposit; everywhere else it is
    // a way of saying this field is done, which is what pressing it in a field means.
    if (key.name === 'return' && at === BUTTON) {
      if (ready) {
        mint.run({
          amount,
          mintUrl: form.mint.trim(),
          unit: form.unit.trim() || api.defaultUnit
        })
      }
      return
    }
    if (accepts(key, completion)) {
      return setForm((previous) => ({ ...previous, mint: completion }))
    }
    const moved = moveFocus(key, at, SLOTS)
    if (moved !== at) return setAt(moved)
    if (key.name === 'return' || at === BUTTON) return
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
      h(Field, {
        label: 'mint',
        value: form.mint,
        focus: at === 1,
        placeholder: 'the mint to deposit at',
        completion
      }),
      h(Field, { label: 'unit', value: form.unit, focus: at === 2 }),
      text(''),
      h(Button, { label: 'ask for an invoice', focus: at === BUTTON, ready }),
      text(''),
      h(Status, {
        task: mint,
        // Named rather than generic, now that there are two ways to be unready and the mint
        // is no longer filled in for you: a form that says the wrong thing is missing is
        // worse than one that says nothing.
        idle: ready
          ? at === BUTTON
            ? 'Enter asks the mint for an invoice'
            : 'Enter moves on — the button below starts it'
          : amountReady
            ? 'a mint is needed — which one is the decision to trust it'
            : 'an amount is needed',
        done: mint.result ?? 'minted'
      })
    ),
    h(Hints, {
      columns,
      keys: mint.busy
        ? [invoice ? ['c', 'copy the invoice'] : null, ['esc', 'stop watching']]
        : [
            ['↑↓', 'move'],
            completion ? ['tab', 'take the mint offered'] : null,
            ['enter', at === BUTTON ? 'deposit' : 'move on'],
            ['esc', 'go back']
          ]
    }),
    invoice
      ? // No box around this one: a bolt11 is longer than any terminal is wide, so it wraps,
        // and a drag down the wrapped lines of a boxed pane brings the sides back with it.
        // Unwalled, what the mouse takes is the invoice.
        column(
          { grow: 1 },
          h(Rule, {
            title: 'pay this invoice',
            right: copied ? `copied to the clipboard (${copied})` : 'C copies it',
            columns
          }),
          text(invoice, { wrap: true, dim: mint.status === 'done' }),
          text(''),
          h(Qr, {
            code,
            columns,
            // What is left under the invoice itself, which wraps to however many lines this
            // terminal's width makes of it. Two columns wider than it was: the box that
            // took them is gone.
            rows: height - FORM_HEIGHT - 2 - wrap(invoice, columns).length - 1,
            fallback: 'the invoice is too long to show as a QR here — copy the text above'
          })
        )
      : h(
          Panel,
          { title: 'pay this invoice', focus: false, grow: 1 },
          text('the invoice appears here once the mint has quoted', { dim: true })
        )
  )
}
