// The root: a header, one screen at a time, and the log along the bottom.
//
// Routing is a string. There is no history stack because there is nowhere to go but back
// to the dashboard — every action starts there and returns there, and a wallet has no
// nested navigation worth keeping state for.
//
// The log is the part worth explaining. Everything the wallet says about itself goes
// through note(), and this UI owns the screen, so those lines are redirected here (see
// lib/notes.mjs) and shown in a pane instead of being lost or painted over the layout. The
// manager keeps narrating exactly as it does on the command line; only where it lands
// changes.
import { h, text, column, row, spacer } from '../element.mjs'
import { useState, useEffect, useInput, useSize, useApp, useMemo } from '../runtime.mjs'
import { Panel, Header, Hints, Log } from '../components.mjs'
import { usePoll } from '../hooks.mjs'
import { redirect } from '../../notes.mjs'
import { Dashboard } from './dashboard.mjs'
import { Deposit } from './deposit.mjs'
import { Give } from './give.mjs'
import { Receive } from './receive.mjs'
import { Withdraw } from './withdraw.mjs'

const SCREENS = {
  dashboard: Dashboard,
  deposit: Deposit,
  give: Give,
  receive: Receive,
  withdraw: Withdraw
}

// How many lines of log to keep. A session that listens all afternoon should not grow a
// transcript nobody can scroll back through — the pane shows the last few and the count.
const LOG_LIMIT = 200

export function App({ api, version = '' }) {
  const [route, setRoute] = useState('dashboard')
  const [log, setLog] = useState([])
  const { columns, rows } = useSize()
  const { exit } = useApp()

  const wallet = usePoll(() => api.snapshot(), [])

  useEffect(() => {
    // Partial writes exist — the poll dots `give` makes on the command line — so lines are
    // assembled here rather than assumed.
    let partial = ''
    const restore = redirect((chunk) => {
      partial += chunk
      const parts = partial.split('\n')
      partial = parts.pop()
      const lines = parts.filter((line) => line.trim() !== '')
      if (!lines.length) return
      setLog((previous) => [...previous, ...lines].slice(-LOG_LIMIT))
    })
    return restore
  }, [])

  useInput(
    (key) => {
      if (route !== 'dashboard') return
      if (key.input === 'q' || key.name === 'ctrl-c') return exit()
      if (key.input === 'd') return setRoute('deposit')
      if (key.input === 'g') return setRoute('give')
      if (key.input === 'r') return setRoute('receive')
      if (key.input === 'w') return setRoute('withdraw')
      if (key.input === 'R') return wallet.refresh()
    },
    { active: true }
  )

  // Ctrl-C ends the session from anywhere. Raw mode makes it a keystroke rather than a
  // signal, so it is handled here — and it is handled at the root, after the screens, so a
  // screen holding the keyboard mid-operation still cannot swallow it.
  useInput((key) => {
    if (key.name === 'ctrl-c') exit()
  })

  // The log takes what is left after the header and the hint line, within reason: a short
  // terminal gives it two lines rather than eating the screen above it.
  const logHeight = Math.max(2, Math.min(6, rows - 20))
  // And the screen gets a height rather than whatever it comes to. Without one, a tall
  // pane — a QR, a long plan — pushes the log and the key hints off the bottom, and the
  // keys are the only thing telling the user how to get out of the screen doing the
  // pushing. Bounded here, the screen truncates and the way out stays visible.
  const bodyHeight = Math.max(3, rows - 1 - 1 - (logHeight + 2) - 1)

  const Screen = SCREENS[route]
  const props = useMemo(
    () => ({
      api,
      columns,
      onBack: () => {
        setRoute('dashboard')
        wallet.refresh()
      },
      onChanged: () => wallet.refresh(),
      onRefresh: () => wallet.refresh(),
      snapshot: wallet.value,
      height: bodyHeight
    }),
    [api, columns, bodyHeight, route, wallet.value]
  )

  return column(
    { height: rows - 1 },
    h(TopBar, { route, totals: wallet.value?.totals, version, error: wallet.error }),
    column({ height: bodyHeight }, h(Screen, props)),
    h(
      Panel,
      { title: 'log', focus: false, height: logHeight + 2 },
      h(Log, { lines: log, height: logHeight })
    ),
    h(Hints, {
      keys:
        route === 'dashboard'
          ? [
              ['d', 'deposit'],
              ['g', 'give'],
              ['r', 'receive'],
              ['w', 'withdraw'],
              ['R', 'refresh'],
              ['q', 'quit']
            ]
          : [['ctrl-c', 'quit']]
    })
  )
}

function TopBar({ route, totals, version, error }) {
  const balance = totals?.length
    ? totals.map((total) => `${total.spendable} ${total.unit}`).join('  ')
    : '0 sat'
  return row(
    { gap: 2 },
    text(`cashme${version ? ` ${version}` : ''}`, { bold: true, cyan: true }),
    text(route === 'dashboard' ? '' : route, { dim: true, grow: 1 }),
    error ? text(`✗ ${error.message}`, { red: true }) : text(balance, { bold: true })
  )
}
