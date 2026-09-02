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
import { h, text, column } from '../element.mjs'
import { useState, useInput, useMemo, useRef } from '../runtime.mjs'
import {
  Panel,
  Field,
  Button,
  Select,
  Status,
  Qr,
  Rule,
  Hints,
  editText,
  moveSelection,
  moveFocus
} from '../components.mjs'
import { useTask } from '../hooks.mjs'

const METHODS = [
  { value: 'print', label: 'hand over', hint: 'print the token and carry it yourself' },
  { value: 'bluetooth', label: 'bluetooth', hint: 'to a neighbour in the room' },
  { value: 'lan', label: 'local network', hint: 'to someone on this wi-fi' },
  { value: 'dht', label: 'hyperdht', hint: 'to a peer anywhere' }
]

// Choosing the method and filling the form are two steps, not one. The arrow keys walk the
// method list the same way they walk the menu, and enter commits the choice and drops into
// the fields — which is also what frees up/down to move between those fields, rather than
// the method needing a direction of its own.
const METHOD = 'method'
const FORM = 'form'

// What the button says, which is the last thing read before the money moves — so it names
// what is about to happen on this wire rather than saying 'send' four times.
const SENDING = {
  print: 'make the token',
  bluetooth: 'send over bluetooth',
  lan: 'send over the local network',
  dht: 'send over the hyperdht'
}

// What each wire is doing while it waits, said in the terms of that wire.
const WHERE = {
  bluetooth: 'looking for the neighbour',
  lan: 'looking on the local network',
  dht: 'looking for the peer'
}

export function Give({ api, columns, height = 24, onBack, onChanged }) {
  const [form, setForm] = useState({ amount: '', key: '', mint: '', unit: api.defaultUnit })
  const [stage, setStage] = useState(METHOD)
  const [method, setMethod] = useState(0)
  const [at, setAt] = useState(0)
  const [token, setToken] = useState(null)
  const [copied, setCopied] = useState(null)

  // The way a wait is called off. A fresh one per send, resolved by esc — every wire
  // function below takes it as `cancelled` and unwinds on its own terms.
  const cancel = useRef(null)

  const wire = METHODS[method].value
  // Unit last, as on the deposit screen: it is the field that is almost never touched, and
  // a form is walked top to bottom.
  const fields = useMemo(
    () => (wire === 'print' ? ['amount', 'mint', 'unit'] : ['amount', 'key', 'mint', 'unit']),
    [wire]
  )
  // One slot per field, plus the button on the end. Changing method changes how many
  // fields there are, which is why this is not a constant as it is on the other screens.
  const button = fields.length
  const slots = fields.length + 1

  const send = useTask(
    async ({ amount, unit, key, mint }, { say }) => {
      // Armed before anything is reserved, not after. prepareGive is a mint round trip and
      // the screen says `busy` for the whole of it, so escape has to mean something during
      // it too — otherwise the keystroke lands on a handle that does not exist yet, the
      // send goes on to reserve proofs and make a token, and the user who asked to stop is
      // handed one anyway.
      let stopped = null
      const cancelled = new Promise((resolve) => {
        cancel.current = () => {
          stopped = new Error('cancelled')
          resolve(stopped)
        }
      })

      // What this session owes back if it ends here: proofs reserved with no token out
      // there. Registered for as long as that is true and dropped the moment it stops
      // being, so `cashme ui` can hand them back after the screen is gone rather than
      // leaving them for the next run to sweep (see lib/cli/tui.mjs).
      let release = null
      const owed = (entry) => {
        release = api.hold(entry)
      }
      const settled = () => {
        release?.()
        release = null
      }

      try {
        say('reserving proofs')
        // Before the network: a send that cannot happen should fail now, not after someone
        // has waited in a room for it.
        const { mintUrl, prepared, fee } = await api.prepareGive({ amount, unit, mint })

        // Reserved now, so from here every way out has to say what becomes of them.
        owed({
          amount,
          unit,
          mintUrl,
          stop: () => cancel.current?.(),
          giveBack: () => api.cancelGive(prepared)
        })

        // The escape pressed while the mint was being asked. Nothing is out there, so the
        // proofs go straight back and the send never happens.
        if (stopped) {
          await api.cancelGive(prepared)
          settled()
          throw stopped
        }

        say(`spending from ${mintUrl}${fee ? ` (+ ${fee} ${unit} mint fee)` : ''}`)

        return await handOver({ prepared, key, cancelled, say, settled })
      } finally {
        settled()
      }
    },
    { onDone: onChanged }
  )

  // The half of the send that happens once the proofs are reserved. Split out only so the
  // bookkeeping above reads as bookkeeping.
  async function handOver({ prepared, key, cancelled, say, settled }) {
    if (wire === 'print') {
      const { operation, token: created } = await api.executeGive(prepared)
      // The token exists: the proofs may be in someone else's hands, so they are no
      // longer something a clean exit can simply hand back.
      settled()
      setToken(created)
      say('waiting for the receiver to claim it')
      const claimed = await api.awaitClaim(operation, { cancelled, onPoll: () => {} })
      if (claimed) return 'claimed'
      return 'still unclaimed — `cashme pending` settles it later'
    }

    say(WHERE[wire] ?? 'looking for the neighbour')
    let deliver
    try {
      deliver = await api.reach(key, { wire, cancelled })
    } catch (err) {
      // Nothing is out there yet, so the proofs come straight back.
      await api.cancelGive(prepared)
      settled()
      throw err
    }

    // From here the token exists and cancelling is no longer one of the options.
    const { operation, token: created } = await api.executeGive(prepared)
    settled()
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
  }

  const code = useMemo(() => (token ? api.qr(token, { ecc: 'L' }) : null), [token])
  const amount = Number(form.amount)
  const unit = form.unit.trim() || api.defaultUnit
  const ready =
    Number.isSafeInteger(amount) && amount > 0 && (wire === 'print' || form.key.trim() !== '')

  // `c` copies the token, but only where it cannot be a character somebody is typing. On
  // the `hand over` path the token is on screen for the whole of the wait for it to be
  // claimed — the task is busy that entire time — so the check cannot simply sit behind
  // `send.busy`, or the key would do nothing in the one window it is for. It cannot sit in
  // front of everything either: once a send has finished the token is still on screen while
  // the form below it takes keystrokes again, and a mint url is full of c's.
  const typing = stage === FORM && !send.busy

  useInput((key) => {
    if (key.input?.toLowerCase() === 'c' && token && !typing) {
      api.copy(token).then((copier) => setCopied(copier || 'nothing to copy with'))
      return
    }
    if (send.busy) {
      if (key.name === 'escape') cancel.current?.()
      return
    }
    if (stage === METHOD) {
      if (key.name === 'escape') return onBack()
      if (key.name === 'return') {
        setAt(0)
        return setStage(FORM)
      }
      setMethod((m) => moveSelection(key, m, METHODS.length))
      return
    }
    // Escape steps back to the method list rather than out of the screen, and what has been
    // typed stays — the amount is usually right even when the way of sending it is not.
    if (key.name === 'escape') return setStage(METHOD)
    // This is the keystroke that spends, so it is the one that has to be deliberate:
    // reachable only from the button, never from a field somebody was typing an amount
    // into.
    if (key.name === 'return' && at === button) {
      if (!ready) return
      setToken(null)
      setCopied(null)
      send.run({ amount, unit, key: form.key.trim(), mint: form.mint.trim() || null })
      return
    }
    const moved = moveFocus(key, at, slots)
    if (moved !== at) return setAt(moved)
    if (key.name === 'return' || at === button) return
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
      h(Select, { items: METHODS, index: method, focus: stage === METHOD && !send.busy }),
      text(''),
      h(Field, {
        label: 'amount',
        value: form.amount,
        focus: stage === FORM && at === 0,
        placeholder: `how much, in ${unit}`
      }),
      wire !== 'print'
        ? h(Field, {
            label: 'their key',
            value: form.key,
            focus: stage === FORM && fields[at] === 'key',
            placeholder: wire === 'dht' ? 'their 64-character key' : 'any prefix of their key'
          })
        : null,
      h(Field, {
        label: 'mint',
        value: form.mint,
        focus: stage === FORM && fields[at] === 'mint',
        placeholder: 'whichever holds enough'
      }),
      h(Field, {
        label: 'unit',
        value: form.unit,
        focus: stage === FORM && fields[at] === 'unit',
        placeholder: api.defaultUnit
      }),
      text(''),
      stage === FORM ? h(Button, { label: SENDING[wire], focus: at === button, ready }) : text(''),
      text(''),
      h(Status, {
        task: send,
        idle:
          stage === METHOD
            ? 'Enter picks this way of giving'
            : !ready
              ? wire === 'print'
                ? 'an amount is needed'
                : 'an amount and their key are needed'
              : at === button
                ? 'Enter sends'
                : 'Enter moves on — the button below sends',
        done: send.result ?? 'sent'
      })
    ),
    h(Hints, {
      columns,
      keys: send.busy
        ? [
            token ? ['c', 'copy the token'] : null,
            ['esc', token ? 'stop waiting' : 'give up and keep the proofs']
          ]
        : stage === METHOD
          ? [
              ['↑↓', 'pick a method'],
              ['enter', 'choose'],
              token ? ['c', 'copy the token'] : null,
              ['esc', 'go back']
            ]
          : [
              ['↑↓', 'move'],
              ['enter', at === button ? 'send' : 'move on'],
              ['esc', 'change method']
            ]
    }),
    h(TokenPane, { token, code, columns, height, copied, task: send })
  )
}

// The token, once there is one. Which is also the moment the proofs stop being ours to
// hand back, so this pane is the one that says so.
//
// No box around it once there is a token, for the same reason the deposit screen's invoice
// has none: a token is longer than any terminal is wide, so it wraps, and a drag down the
// wrapped lines of a boxed pane brings the sides back with it. A token with a │ in it is
// not a token. `c` is still the reliable way — this is for when the clipboard is on the
// wrong machine.
function TokenPane({ token, code, columns, height, copied, task }) {
  if (!token) {
    return h(
      Panel,
      { title: 'token', focus: false, grow: 1 },
      text('nothing is out there yet — giving up now keeps the proofs', { dim: true })
    )
  }
  return column(
    { grow: 1 },
    h(Rule, {
      title: 'token',
      right: copied ? `copied to the clipboard (${copied})` : 'C copies it',
      columns
    }),
    text(token, { wrap: true, dim: task.status === 'done' }),
    text(''),
    h(Qr, {
      code,
      // Two columns wider than it was: the box that took them is gone.
      columns,
      // The form above takes four methods, up to four fields, a button, a status line and
      // its borders; a token wraps to a couple of lines under that.
      rows: height - 17,
      fallback: 'too long to show as a QR here — copy the text above instead'
    })
  )
}
