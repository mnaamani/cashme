// What this session is running as.
//
// Two of these are the lines bin.mjs prints before anything else can go wrong — which
// binary is running, and which storage directory this run's money is in — and on the
// alternate screen they scroll past before the UI paints. The rest are the global choices
// that decide where the traffic goes and what address this wallet wears.
//
// Only one of them can move. A proxy is wired into coco's fetch when the process starts
// and the storage directory is the wallet that is already open and locked, so both are
// decided for the life of the run; the address mode is a choice made afresh on every
// hyperdht key, which is why it is the one thing enter does something to here.
import { h, text, column, row } from '../element.mjs'
import { useState, useInput } from '../runtime.mjs'
import { Panel, Hints, moveSelection, GUTTER } from '../components.mjs'

const MODES = ['ephemeral', 'stable']

// What each mode means for the person on the other end, which is the part worth knowing
// before changing it — the key is what they see, and what they might keep.
const MEANS = {
  ephemeral: 'a new key every run, on every wire — nothing ties one handover to the next',
  stable: "this wallet's own address, the same on every wire and every run"
}

// The cost of a standing address, said per wire because it is not the same cost on each.
// Shown only under `stable`: this is what changes by switching, and a warning about a
// thing nobody has chosen is noise.
const COSTS = [
  ['hyperdht', 'announced to the world — anyone holding the key can look up that you are online'],
  [
    'bluetooth',
    'advertised on a public topic — anyone scanning the room can recognise this wallet'
  ],
  [
    'local network',
    'answers any multicast query — turns “a wallet is here” into “this wallet is here”'
  ]
]

export function Settings({ api, onBack, columns = 80, focus = true }) {
  const [at, setAt] = useState(0)
  const [mode, setMode] = useState(() => api.addressMode())

  const settings = api.settings()
  // Named on the row rather than left to the hint line: what enter does here is switch to
  // the other mode, and saying which one it is makes the row its own instruction.
  const other = MODES[(MODES.indexOf(mode) + 1) % MODES.length]

  // The only row enter acts on. Kept as a list anyway, so adding a second changeable
  // setting later is a row rather than a rewrite.
  const rows = [
    {
      label: 'address',
      value: mode,
      action: `Enter switches to ${other}`,
      note: MEANS[mode],
      // Every wire takes its Noise key from this one setting, so switching it is a
      // decision about all three at once and is shown as one.
      costs: mode === 'stable' ? COSTS : null,
      change: true
    },
    { label: 'binary', value: settings.binary },
    { label: 'storage', value: settings.storage },
    {
      label: 'proxy',
      value: settings.proxy ? settings.proxy.name : 'none',
      note: settings.proxy
        ? `from ${settings.proxy.source} — carries the mint and relay traffic, not the handovers`
        : 'mint and relay traffic goes out directly'
    },
    {
      label: 'dht interface',
      value: settings.dhtInterface ?? 'none',
      note: settings.dhtInterface
        ? 'the hyperdht leaves from here; the mint traffic behind it does not'
        : 'the hyperdht leaves by the routing table'
    }
  ]

  useInput(
    (key) => {
      if (key.name === 'escape') return onBack()
      if (key.name === 'return' && rows[at]?.change) {
        // Two of them, so enter is a toggle rather than a list to walk.
        const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length]
        setMode(api.setAddress(next))
        return
      }
      setAt((i) => moveSelection(key, i, rows.length))
    },
    { active: focus }
  )

  return column(
    { gap: 0, grow: 1 },
    h(
      Panel,
      { title: 'settings', focus, grow: 1 },
      ...rows.flatMap((entry, index) => [
        h(Row, { entry, focus: focus && index === at, columns }),
        entry.note ? h(Note, { note: entry.note }) : null,
        ...(entry.costs ?? []).map(([wire, cost]) => h(Cost, { wire, cost, key: wire }))
      ])
    ),
    h(Hints, {
      columns,
      keys: [
        ['↑↓', 'move'],
        rows[at]?.change ? ['enter', 'switch address'] : null,
        ['esc', 'go back']
      ]
    })
  )
}

// A setting and its value. The marker is the same one the menus use, but only the rows
// that can be changed get the cyan — a highlight on something enter will not touch is a
// promise the screen cannot keep.
function Row({ entry, focus }) {
  return row(
    { gap: 1 },
    text(focus ? '›' : ' ', { width: 1, cyan: focus && entry.change }),
    text(entry.label, { width: GUTTER, dim: !focus }),
    text(String(entry.value), {
      grow: 1,
      wrap: true,
      bold: entry.change,
      dim: !entry.change && !focus
    }),
    // Kept on the row whether or not it is focused, so the one setting that can be changed
    // is visibly the one that can be changed before the keyboard ever reaches it — cyan
    // once it is, because then it is not a description but the next keystroke.
    entry.action ? text(entry.action, { cyan: focus, dim: !focus, wrap: false }) : null
  )
}

// What a standing address costs on one wire. Indented past the value column and marked,
// so it reads as consequences of the row above rather than more settings.
function Cost({ wire, cost }) {
  return row(
    { gap: 1 },
    text('', { width: 1 }),
    text('', { width: GUTTER }),
    text('!', { width: 1, yellow: true }),
    text(wire, { width: 14, yellow: true }),
    text(cost, { dim: true, grow: 1, wrap: true })
  )
}

function Note({ note }) {
  return row(
    { gap: 1 },
    text('', { width: 1 }),
    text('', { width: GUTTER }),
    text(note, { dim: true, grow: 1 })
  )
}
