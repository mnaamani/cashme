// Give: reserve proofs, turn them into a token, and get the token to someone.
//
// Three ways out, and the difference between them is only how the token travels — so the
// screen is one form with a method on it, not three screens. What is not interchangeable is
// what happens when it goes wrong, and that is the whole reason this screen exists:
//
//   before the token exists   the proofs are reserved and nothing is out there — give up
//                             and they go back to the balance.
//   after the token exists    the receiver may already have it. Nothing may be cancelled;
//                             the send is settled, reclaimed, or left pending for
//                             `cashme pending` to sort out later.
//
// Every path below is one side or the other of that line, and the pane says which side it
// is on, because it decides what an interrupt costs.
import { h, text, column, row } from '../element.mjs'
import { useState, useInput, useMemo, useRef } from '../runtime.mjs'
import { Panel, Field, Select, Status, Qr, Hints, editText, moveSelection } from '../components.mjs'
import { useTask } from '../hooks.mjs'

const METHODS = [
  { value: 'print', label: 'hand over', hint: 'print the token and carry it yourself' },
  { value: 'bluetooth', label: 'bluetooth', hint: 'to a neighbour in the room' },
  { value: 'dht', label: 'hyperdht', hint: 'to a peer anywhere' }
]

export function Give({ api, columns, height = 24, onBack, onChanged }) {
  const [form, setForm] = useState({ amount: '', key: '', mint: '', stable: false })
  const [method, setMethod] = useState(0)
  const [at, setAt] = useState(0)
  const [token, setToken] = useState(null)
  const [copied, setCopied] = useState(null)

  // The way a wait is called off. A fresh one per send, resolved by esc — every wire
  // function below takes it as `cancelled` and unwinds on its own terms.
  const cancel = useRef(null)

  const wire = METHODS[method].value
  const fields = useMemo(
    () => (wire === 'print' ? ['amount', 'mint'] : ['amount', 'key', 'mint']),
    [wire]
  )

  const send = useTask(
    async ({ amount, key, mint, stable }, { say }) => {
      say('reserving proofs')
      // Before the network: a send that cannot happen should fail now, not after someone
      // has waited in a room for it.
      const { mintUrl, prepared, fee } = await api.prepareGive({ amount, mint })
      say(`spending from ${mintUrl}${fee ? ` (+ ${fee} sat mint fee)` : ''}`)

      const cancelled = new Promise((resolve) => {
        cancel.current = () => resolve(new Error('cancelled'))
      })

      if (wire === 'print') {
        const { operation, token: created } = await api.executeGive(prepared)
        setToken(created)
        say('waiting for the receiver to claim it')
        const claimed = await api.awaitClaim(operation, { cancelled, onPoll: () => {} })
        if (claimed) return 'claimed'
        return 'still unclaimed — `cashme pending` settles it later'
      }

      say(wire === 'dht' ? 'looking for the peer' : 'looking for the neighbour')
      let deliver
      try {
        deliver = await api.reach(key, { dht: wire === 'dht', stable, cancelled })
      } catch (err) {
        // Nothing is out there yet, so the proofs come straight back.
        await api.cancelGive(prepared)
        throw err
      }

      // From here the token exists and cancelling is no longer one of the options.
      const { operation, token: created } = await api.executeGive(prepared)
      setToken(created)
      say('handing it over')
      const received = await deliver(created)
      if (received) {
        await api.finalizeGive(operation)
        return 'delivered and acknowledged'
      }

      say('no confirmation — trying to take the proofs back')
      try {
        await api.reclaim(operation)
        return 'no acknowledgement, proofs reclaimed'
      } catch {
        return 'no acknowledgement — the send stays pending, it may yet be claimed'
      }
    },
    { onDone: onChanged }
  )

  const code = useMemo(() => (token ? api.qr(token, { ecc: 'L' }) : null), [token])
  const amount = Number(form.amount)
  const ready =
    Number.isSafeInteger(amount) && amount > 0 && (wire === 'print' || form.key.trim() !== '')

  useInput((key) => {
    if (send.busy) {
      if (key.name === 'escape') cancel.current?.()
      return
    }
    if (key.name === 'escape') return onBack()
    if (key.input === 'c' && token) {
      api.copy(token).then((copier) => setCopied(copier || 'nothing to copy with'))
      return
    }
    if (key.name === 'left' || key.name === 'right') {
      setMethod((m) => (m + (key.name === 'right' ? 1 : METHODS.length - 1)) % METHODS.length)
      setAt(0)
      return
    }
    if (key.name === 'tab' || key.name === 'down') return setAt((i) => (i + 1) % fields.length)
    if (key.name === 'shifttab' || key.name === 'up') {
      return setAt((i) => (i - 1 + fields.length) % fields.length)
    }
    if (key.ctrl && key.name === 'ctrl-s' && wire === 'dht') {
      return setForm((previous) => ({ ...previous, stable: !previous.stable }))
    }
    if (key.name === 'return') {
      if (!ready) return
      setToken(null)
      setCopied(null)
      send.run({
        amount,
        key: form.key.trim(),
        mint: form.mint.trim() || null,
        stable: form.stable
      })
      return
    }
    const name = fields[at]
    setForm((previous) => ({
      ...previous,
      [name]: editText(previous[name], key, { numeric: name === 'amount' })
    }))
  })

  return column(
    { gap: 0, grow: 1 },
    h(
      Panel,
      { title: 'give', focus: !send.busy },
      h(Select, { items: METHODS, index: method, focus: !send.busy }),
      text(''),
      h(Field, { label: 'amount', value: form.amount, focus: at === 0, placeholder: 'sats' }),
      wire !== 'print'
        ? h(Field, {
            label: 'their key',
            value: form.key,
            focus: fields[at] === 'key',
            placeholder: wire === 'dht' ? 'their 64-character key' : 'any prefix of their key'
          })
        : null,
      h(Field, {
        label: 'mint',
        value: form.mint,
        focus: fields[at] === 'mint',
        placeholder: 'whichever holds enough'
      }),
      wire === 'dht'
        ? text(
            form.stable
              ? "sending under this wallet's own address — someone paid twice can tell it was us"
              : 'sending under a one-run key (ctrl-s to use this wallet’s address)',
            { dim: true }
          )
        : null,
      text(''),
      h(Status, {
        task: send,
        idle: ready ? 'enter sends' : 'an amount is needed',
        done: send.result ?? 'sent'
      })
    ),
    h(TokenPane, { token, code, columns, height, copied, task: send }),
    h(Hints, {
      keys: send.busy
        ? [['esc', token ? 'stop waiting' : 'give up and keep the proofs']]
        : [
            ['←→', 'method'],
            ['tab', 'next field'],
            ['enter', 'send'],
            token ? ['c', 'copy'] : null,
            ['esc', 'back']
          ]
    })
  )
}

// The token, once there is one. Which is also the moment the proofs stop being ours to
// hand back, so this pane is the one that says so.
function TokenPane({ token, code, columns, height, copied, task }) {
  if (!token) {
    return h(
      Panel,
      { title: 'token', focus: false, grow: 1 },
      text('nothing is out there yet — giving up now keeps the proofs', { dim: true })
    )
  }
  return h(
    Panel,
    { title: 'token', focus: true, grow: 1 },
    text(token, { wrap: true, dim: task.status === 'done' }),
    copied ? text(`copied to the clipboard (${copied})`, { green: true }) : null,
    text(''),
    h(Qr, {
      code,
      columns: columns - 4,
      // The form above takes three methods, up to three fields, a status line and its
      // borders; a token wraps to a couple of lines under that.
      rows: height - 16,
      fallback: 'too long to show as a QR here — copy the text above instead'
    })
  )
}
