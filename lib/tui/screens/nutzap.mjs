// `nutzap` — NIP-61: send the ecash itself to a nostr user, locked to their key.
//
// The other half of a zap. A zap is a real lightning payment and leaves a public receipt;
// a nutzap hands over proofs only they can spend, published to the relays they said they
// read. Nothing routes, so no mint sees who was paid — and nothing can be taken back.
//
// That last part is why this screen looks like `give` rather than `withdraw`: the proofs
// are reserved first, the question is asked while they are still ours, and refusing hands
// them straight back. Once published they are theirs whether they ever claim them or not.
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
  completes,
  accepts,
  said
} from '../components.mjs'
import { useTask } from '../hooks.mjs'
import { note } from '../../notes.mjs'

const FIELDS = ['pubkey', 'amount', 'mint', 'note', 'comment']
const SLOTS = FIELDS.length + 1
const BUTTON = FIELDS.length

export function Nutzap({ api, snapshot, onBack, onChanged, columns = 80 }) {
  const [form, setForm] = useState({ pubkey: '', amount: '', mint: '', note: '', comment: '' })
  const [at, setAt] = useState(0)
  const [plan, setPlan] = useState(null)

  const quote = useTask(async ({ pubkey, amount, mint, event }, { say }) => {
    // The last nutzap is over and done with. Left where it was, its `done` would still be
    // what says something has been sent, and the question below — which is only put while
    // nothing has been — would never be asked for this plan, leaving its reserved proofs
    // with no way back but the next run's sweep.
    send.reset()
    refuse.reset()
    say(`resolving ${pubkey}`)
    const planned = await api.planNutzap({ pubkey, amount, mint, event })
    setPlan(planned)
    return 'ready to send'
  })

  const send = useTask(
    async (planned, { say }) => {
      say(`publishing to ${planned.relays.length} relays`)
      const result = await api.settleNutzap(planned, { comment: form.comment.trim() })
      setPlan(null)
      if (!result.accepted) {
        // The ecash is gone either way — locked to them and unreclaimable — so this is not
        // a failed send, it is a delivered one nobody carried. Saying otherwise would
        // invite someone to try again and spend twice.
        //
        // The event goes to the log rather than into the message: it is the only way left
        // to deliver this nutzap, it is far too long for a status line, and the log is the
        // one pane here that can be scrolled back to and copied out of.
        note('no relay accepted the nutzap. Publish this event yourself to deliver it:')
        note(JSON.stringify(result.event))
        throw new Error(
          'no relay accepted it — the ecash is locked to them and cannot be reclaimed'
        )
      }
      return `nutzapped ${planned.amount} sat, accepted by ${result.accepted} of ${result.results.length} relays`
    },
    { onDone: onChanged }
  )

  // Refusing is not just closing the question: the proofs are reserved and have to go back.
  const refuse = useTask(async (planned) => {
    await api.cancelNutzap(planned)
    setPlan(null)
    return 'cancelled — nothing was spent'
  })

  const completion = at === 2 ? completes(form.mint, snapshot?.mints ?? []) : ''
  const amount = Number(form.amount)
  const ready = form.pubkey.trim() !== '' && Number.isSafeInteger(amount) && amount > 0
  // Asked for as long as there is a plan nothing has been done with yet. The proofs are
  // already reserved by then, so this question is also the only thing standing between them
  // and being handed back — which is why the quote above resets both halves before it runs.
  const asking = Boolean(plan) && send.status === 'idle' && !refuse.busy
  const busy = quote.busy || send.busy || refuse.busy

  useInput(
    (key) => {
      if (busy) return
      if (key.name === 'escape') return onBack()
      if (key.name === 'return' && at === BUTTON) {
        if (ready) {
          quote.run({
            pubkey: form.pubkey.trim(),
            amount,
            mint: form.mint.trim() || null,
            event: form.note.trim() || null
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
    },
    // Not registered while the question stands: the confirmation has the keyboard.
    { active: !asking }
  )

  const task = send.status !== 'idle' ? send : refuse.status !== 'idle' ? refuse : quote

  // A question owns the screen. The form under it is already filled in, and leaving it
  // there is what pushed the answer keys off the bottom of a short terminal — a
  // confirmation whose Y and N are not on screen is not a confirmation.
  if (asking) {
    return column(
      { gap: 0, grow: 1 },
      h(Confirm, {
        question: `Nutzap ${plan.amount} sat to ${plan.typed}?`,
        // Everything the lookup decided, before the amounts: who they turned out to be,
        // which key the ecash gets locked to, and where it is going to be published. None
        // of that is reversible once the answer is yes.
        detail: [
          ...resolution(plan),
          '',
          ...plan.warnings,
          ...(plan.warnings.length ? [''] : []),
          'once sent, only they can spend it — it cannot be reclaimed'
        ],
        onAnswer: (yes) => (yes ? send.run(plan) : refuse.run(plan))
      }),
      h(Hints, {
        columns,
        keys: [
          ['y', 'send it'],
          ['n', 'keep the proofs']
        ]
      })
    )
  }

  return column(
    { gap: 0, grow: 1 },
    h(
      Panel,
      { title: 'nutzap', focus: !busy },
      h(Field, {
        label: 'who',
        value: form.pubkey,
        focus: at === 0,
        placeholder: 'npub, hex key, or name@domain'
      }),
      h(Field, { label: 'amount', value: form.amount, focus: at === 1, placeholder: 'sats' }),
      h(Field, {
        label: 'mint',
        value: form.mint,
        focus: at === 2,
        placeholder: 'one they trust and we can cover',
        completion
      }),
      h(Field, {
        label: 'note',
        value: form.note,
        focus: at === 3,
        // 32 bytes of hash in every form nostr writes it, which is to say a paste rather
        // than something anyone types. Checked to be theirs before anything is reserved.
        placeholder: 'optional, note1… or nevent1… of theirs to zap'
      }),
      h(Field, {
        label: 'comment',
        value: form.comment,
        focus: at === 4,
        placeholder: 'optional, published with it'
      }),
      text(''),
      h(Button, { label: 'look them up', focus: at === BUTTON, ready }),
      text(''),
      h(Status, {
        task,
        idle: !ready
          ? 'a nostr key or address and an amount are needed'
          : at === BUTTON
            ? 'Enter reads what they published — nothing is spent until you confirm'
            : 'Enter moves on — the button below looks them up',
        done: task.result ?? 'done'
      })
    ),
    h(Hints, {
      columns,
      keys: busy
        ? []
        : [
            ['↑↓', 'move'],
            completion ? ['tab', 'take the mint offered'] : null,
            ['enter', at === BUTTON ? 'look them up' : 'move on'],
            ['esc', 'go back']
          ]
    }),
    h(Plan, { plan })
  )
}

function Plan({ plan }) {
  if (!plan) {
    return h(
      Panel,
      { title: 'to them', focus: false, grow: 1 },
      text('what they published about being paid is read before anything is reserved', {
        dim: true
      })
    )
  }
  return h(
    Panel,
    { title: 'to them', focus: false, grow: 1 },
    ...resolution(plan).map((line, index) => text(line, { key: `who-${index}`, dim: index > 0 })),
    text(''),
    ...plan.warnings.map((line, index) => text(line, { key: `warn-${index}`, yellow: true })),
    text('once sent, only they can spend it — it cannot be reclaimed', { yellow: true })
  )
}

// What the lookup settled, said the same way on the pane and in the question.
function resolution(plan) {
  return said([
    ['you typed', plan.typed],
    ['their key', plan.recipient],
    ['locked to', plan.lockKey],
    plan.note ? ['on note', plan.note.id] : null,
    plan.note ? ['which says', plan.note.preview] : null,
    ['amount', `${plan.amount} sat${plan.fee ? ` (+ ${plan.fee} mint fee)` : ''}`],
    ['from', plan.mintUrl],
    ['relays', plan.relays.join(', ')]
  ])
}
