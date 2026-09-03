// The mints this wallet knows: which it trusts, what each holds, and in what.
//
// The menu shows one number, because one number is what you check. This is the other
// question: a cashu balance is a set of proofs of fixed denominations, and which ones are
// held decides what can be handed over without going back to the mint for change. 200 sat
// as a 128, a 64 and an 8 cannot pay 100 in one move. The count is the other half of it —
// a wallet carrying a hundred 1-sat crumbs spends slowly and swaps often.
//
// Trust lives here rather than on a screen of its own because it is a fact about the same
// list. A mint holds the bitcoin backing our ecash, so which ones this wallet is exposed to
// is worth being able to read off in one place — and the answer is only useful next to what
// each one is holding, which is the number the exposure is measured in. Which means this
// list is every mint on the register, not only the ones with proofs at them: a mint that has
// been untrusted, or trusted by name and never used, is still something to see and act on.
import { h, text, row, column } from '../element.mjs'
import { useState, useInput } from '../runtime.mjs'
import { Panel, Hints, Confirm, Status, Field, moveSelection, editText } from '../components.mjs'
import { usePoll, useTask } from '../hooks.mjs'
import { glow } from '../brand.mjs'

const NARROW = 64

export function Mints({ api, onChanged, onBack, columns = 80, focus = true }) {
  const [at, setAt] = useState(0)
  const [asking, setAsking] = useState(null)
  // The url being typed after A, or null when nothing is being added. A field rather than a
  // screen of its own, so the list stays visible while it is filled in — which is the part
  // that says whether the mint is already here under a spelling of its own.
  const [adding, setAdding] = useState(null)
  const mints = usePoll(() => api.mints(), [])
  const held = mints.value ?? []
  // Read back against the list, which shortens when a poll comes in — the same reason the
  // in-flight screen clamps its own.
  const index = Math.min(at, Math.max(0, held.length - 1))
  const chosen = held[index] ?? null

  // One task for both directions and both ways in — the T on a row, and the url typed after
  // A — because what happens is the same either way and only one of them can be running.
  const change = useTask(
    async ({ mintUrl, trust }, { say }) => {
      if (!trust) {
        say(`untrusting ${mintUrl}`)
        await api.untrustMint(mintUrl)
        return `untrusted ${mintUrl} — nothing can be spent from it until it is trusted again`
      }
      // Trusting reaches the mint for its info and keysets, which is the slow half and the
      // one that can fail — a url that is not a mint is found out here. Worth saying, since
      // it is also the wait somebody is looking at.
      say(`asking ${mintUrl} for its keysets`)
      await api.trustMint(mintUrl)
      return `trusting ${mintUrl}`
    },
    {
      onDone: () => {
        // Only on success, which is what keeps a url that failed on screen to be corrected
        // rather than making somebody type the whole thing again.
        setAdding(null)
        mints.refresh()
        // The header's total does not change — the ecash is still there — but what can be
        // done with it has, and the menu reads the same snapshot.
        onChanged?.()
      }
    }
  )

  useInput(
    (key) => {
      if (change.busy) return
      // The field owns every key while it is open, and it is checked before the letters
      // below rather than after: a mint url is full of r's and t's, and a url that jumped
      // the selection about while being typed would be unusable.
      if (adding !== null) {
        if (key.name === 'escape') return setAdding(null)
        if (key.name === 'return') {
          const mintUrl = adding.trim()
          if (mintUrl) change.run({ mintUrl, trust: true })
          return
        }
        return setAdding((previous) => editText(previous, key))
      }
      if (key.name === 'escape') return onBack()
      if (key.input?.toLowerCase() === 'r') return mints.refresh()
      if (key.input?.toLowerCase() === 'a') return setAdding('')
      if (key.input?.toLowerCase() === 't' && chosen) {
        // Trusting is additive and needs no question. Untrusting a mint that is holding
        // something does: the ecash stays but stops being spendable, which is not what
        // somebody expects a key press on a list of balances to do.
        if (chosen.trusted && worth(chosen)) return setAsking(chosen)
        return change.run({ mintUrl: chosen.mintUrl, trust: !chosen.trusted })
      }
      setAt(moveSelection(key, index, held.length))
    },
    { active: focus && !asking }
  )

  if (asking) {
    return column(
      { gap: 0, grow: 1 },
      h(Confirm, {
        question: `Untrust ${asking.mintUrl}?`,
        detail: [
          `It holds ${worth(asking)}.`,
          '',
          'Untrusting does not remove that ecash. Nothing can be spent',
          'from the mint until it is trusted again, which T also does.'
        ],
        onAnswer: (yes) => {
          setAsking(null)
          if (yes) change.run({ mintUrl: asking.mintUrl, trust: false })
        }
      }),
      h(Hints, {
        columns,
        keys: [
          ['y', 'untrust it'],
          ['n', 'leave it trusted']
        ]
      })
    )
  }

  return column(
    { gap: 0, grow: 1 },
    h(
      Panel,
      { title: held.length ? `mints (${held.length})` : 'mints', focus, grow: 1 },
      ...body({ mints, held, at: index, focus, columns }),
      text(''),
      // The field sits under the list rather than over it: a url is being added to what is
      // already there, and whether it is already there under another spelling is the thing
      // worth being able to look up while typing.
      adding !== null
        ? h(Field, {
            label: 'add a mint',
            value: adding,
            focus: true,
            placeholder: 'https://…'
          })
        : null,
      h(Status, {
        task: change,
        idle:
          adding !== null
            ? 'Enter trusts it — the mint is reached before it is added'
            : chosen
              ? chosen.trusted
                ? 'T stops trusting this mint'
                : 'T trusts this mint, so its ecash can be spent again'
              : '',
        done: change.result ?? 'done'
      })
    ),
    h(Hints, {
      columns,
      keys: change.busy
        ? []
        : adding !== null
          ? [
              ['enter', 'trust it'],
              ['esc', 'never mind']
            ]
          : [
              held.length > 1 ? ['↑↓', 'move'] : null,
              chosen ? ['t', chosen.trusted ? 'untrust it' : 'trust it'] : null,
              ['a', 'add a mint'],
              ['r', 'read again'],
              ['esc', 'go back']
            ]
    })
  )
}

// What a mint holds, as one string, or empty when it holds nothing — which is also the
// test for whether untrusting it costs anything.
function worth(mint) {
  return mint.units
    .filter((unit) => unit.spendable || unit.reserved)
    .map((unit) => `${unit.spendable} ${unit.unit}`)
    .join('  ')
}

function body({ mints, held, at, focus, columns }) {
  if (mints.error) return [text(`✗ ${mints.error.message}`, { red: true })]
  if (!mints.value) return [text('reading the wallet…', { dim: true })]
  if (!held.length) {
    return [text('no mints yet — A adds one, or claim a token from someone', { dim: true })]
  }

  return held.flatMap((mint, index) => [
    h(Mint, { mint, focus: focus && index === at, columns, key: mint.mintUrl }),
    h(Trust, { mint, key: `${mint.mintUrl}/trust` }),
    h(Proofs, { mint, key: `${mint.mintUrl}/proofs` })
  ])
}

// The mint and what it is worth. One line per unit, because a mint issuing two of them
// holds two balances and adding them would report a number that is true of neither.
function Mint({ mint, focus, columns }) {
  const narrow = columns < NARROW
  const name = narrow ? mint.mintUrl.replace(/^https:\/\//, '') : mint.mintUrl
  const total = mint.units.length
    ? mint.units.map((unit) => `${unit.spendable} ${unit.unit}`).join('  ')
    : // A mint on the register that holds nothing — trusted by name, or emptied. `0` with
      // no unit after it is not an amount, and this is not a balance to be read as one.
      '—'
  return row(
    { gap: 1 },
    text(focus ? '›' : ' ', { width: 1, cyan: focus }),
    // Dimmed when untrusted, so the row reads as inactive at a glance before the word under
    // it is reached — this is a list somebody scans rather than reads.
    text(name, { grow: 1, wrap: false, bold: focus, dim: !mint.trusted && !focus }),
    text(total, { bold: mint.trusted, dim: !mint.trusted, wrap: false })
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

// Trusted is the ordinary state and says so quietly; untrusted is the one with a
// consequence, so it is yellow and says what the consequence is rather than just naming
// itself — a word nobody can act on is worse than a sentence.
function Trust({ mint }) {
  return row(
    { gap: 1 },
    text('', { width: 2 }),
    mint.trusted
      ? text('trusted', { dim: true, grow: 1 })
      : text('untrusted — nothing here can be spent until it is trusted again', {
          yellow: true,
          grow: 1
        })
  )
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

// The one number the menu shows. Here so that the screen that owns the mints owns the sum
// of them too, rather than the menu growing its own idea of what a total is.
export function Total({ snapshot }) {
  const totals = snapshot?.totals ?? []
  const said = totals.length
    ? totals.map((total) => `${total.spendable} ${total.unit}`).join('   ')
    : snapshot
      ? '0 sat'
      : 'reading the wallet…'
  // The one number on this screen worth looking at from across a desk, so it is the one
  // thing besides the wordmark that wears the ramp. Only when there is something to say:
  // a nought and a wallet still being read are not news, and colouring them would make
  // every empty wallet look like an announcement.
  return h(
    Panel,
    { title: 'balance', focus: false },
    totals.length ? text(glow(said), { wrap: false }) : text(said, { dim: !snapshot })
  )
}
