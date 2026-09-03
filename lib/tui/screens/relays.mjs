// The nostr relays this wallet asks, and where they came from.
//
// The other list of strangers, next to `mints`. A mint holds the money and trusting one is
// a decision worth confirming; a relay only holds answers — where a nostr user receives
// lightning, how they want to be nutzapped, and, for a nutzap, the event carrying the ecash
// — so changing this list costs nothing and nothing here asks twice. What it does cost is
// exposure: every relay on this screen is told which keys this wallet is looking up.
//
// A wallet that has changed nothing is using the list built into the binary, and the screen
// says so rather than presenting four urls nobody chose as though they had been chosen. The
// first change starts from those, so removing one leaves the rest.
import { h, text, row, column } from '../element.mjs'
import { useState, useInput } from '../runtime.mjs'
import { Panel, Hints, Confirm, Status, Field, moveSelection, editText } from '../components.mjs'
import { usePoll, useTask } from '../hooks.mjs'

export function Relays({ api, onBack, columns = 80, focus = true }) {
  const [at, setAt] = useState(0)
  // The url being typed after A, or null when nothing is being added. A field under the
  // list rather than a screen of its own, so what is already there stays readable while it
  // is filled in — which is what says whether this relay is on the list already.
  const [adding, setAdding] = useState(null)
  const [asking, setAsking] = useState(false)
  const relays = usePoll(() => api.relays(), [])
  const urls = relays.value?.urls ?? []
  const custom = Boolean(relays.value?.custom)
  // Read back against the list, which shortens as relays are removed.
  const index = Math.min(at, Math.max(0, urls.length - 1))
  const chosen = urls[index] ?? null

  // One task for all three changes: only one of them can be running, and each is a write to
  // the same small file.
  const change = useTask(
    async (action) => {
      if (action.remove) {
        await api.removeRelay(action.remove)
        return `removed ${action.remove}`
      }
      if (action.reset) {
        const { urls: back } = await api.resetRelays()
        return `back to the ${back.length} relays built into this binary`
      }
      const { url, added } = await api.addRelay(action.add)
      return added ? `added ${url}` : `${url} was already on the list`
    },
    {
      onDone: () => {
        // Only on success, which leaves a url that would not parse on screen to be
        // corrected rather than retyped from the start.
        setAdding(null)
        relays.refresh()
      }
    }
  )

  useInput(
    (key) => {
      if (change.busy) return
      // The field owns every key while it is open, and is checked before the letters below:
      // a relay url is full of r's and a's, and a url that moved the selection about while
      // being typed would be unusable.
      if (adding !== null) {
        if (key.name === 'escape') return setAdding(null)
        if (key.name === 'return') {
          const add = adding.trim()
          if (add) change.run({ add })
          return
        }
        return setAdding((previous) => editText(previous, key))
      }
      if (key.name === 'escape') return onBack()
      if (key.input?.toLowerCase() === 'r') return relays.refresh()
      if (key.input?.toLowerCase() === 'a') return setAdding('')
      if (key.input?.toLowerCase() === 'x' && chosen) return change.run({ remove: chosen })
      // Only worth asking about when there is a list of this wallet's own to discard;
      // otherwise it is already the built-in one and B does nothing.
      if (key.input?.toLowerCase() === 'b' && custom) return setAsking(true)
      setAt(moveSelection(key, index, urls.length))
    },
    { active: focus && !asking }
  )

  if (asking) {
    return column(
      { gap: 0, grow: 1 },
      h(Confirm, {
        question: 'Go back to the relays built into this binary?',
        detail: [
          "This wallet's own list is discarded — the relays added here, and",
          'the removals, go with it. Nothing else is touched: no ecash, no',
          'mints, and any relay can be added again.'
        ],
        onAnswer: (yes) => {
          setAsking(false)
          if (yes) change.run({ reset: true })
        }
      }),
      h(Hints, {
        columns,
        keys: [
          ['y', 'use the built-in list'],
          ['n', 'keep this one']
        ]
      })
    )
  }

  return column(
    { gap: 0, grow: 1 },
    h(
      Panel,
      { title: urls.length ? `relays (${urls.length})` : 'relays', focus, grow: 1 },
      ...body({ relays, urls, custom, at: index, focus }),
      text(''),
      adding !== null
        ? h(Field, {
            label: 'add a relay',
            value: adding,
            focus: true,
            placeholder: 'wss://…'
          })
        : null,
      h(Status, {
        task: change,
        idle:
          adding !== null
            ? 'Enter adds it — a relay is only reached when a zap or a nutzap asks it'
            : chosen
              ? 'X stops asking this relay'
              : 'A adds one — nothing can be looked up until there is at least one',
        done: change.result ?? 'done'
      })
    ),
    h(Hints, {
      columns,
      keys: change.busy
        ? []
        : adding !== null
          ? [
              ['enter', 'add it'],
              ['esc', 'never mind']
            ]
          : [
              urls.length > 1 ? ['↑↓', 'move'] : null,
              chosen ? ['x', 'remove it'] : null,
              ['a', 'add a relay'],
              custom ? ['b', 'built-in list'] : null,
              ['r', 'read again'],
              ['esc', 'go back']
            ]
    })
  )
}

function body({ relays, urls, custom, at, focus }) {
  if (relays.error) return [text(`✗ ${relays.error.message}`, { red: true })]
  if (!relays.value) return [text('reading the list…', { dim: true })]
  if (!urls.length) {
    return [
      text('no relays — A adds one, B puts the built-in list back', { yellow: true }),
      text('zap and nutzap cannot look anybody up until there is one', { dim: true })
    ]
  }

  return [
    ...urls.map((url, index) => h(Relay, { url, focus: focus && index === at, key: url })),
    text(''),
    // Said once, under the list: where this list came from is one fact about all of it,
    // and it is the difference between a list somebody chose and one they inherited.
    text(
      custom
        ? "this wallet's own list — B goes back to the relays built into this binary"
        : 'the relays built into this binary — adding or removing one makes this list yours',
      { dim: true, wrap: true }
    )
  ]
}

function Relay({ url, focus }) {
  return row(
    { gap: 1 },
    text(focus ? '›' : ' ', { width: 1, cyan: focus }),
    text(url, { grow: 1, wrap: false, bold: focus })
  )
}
