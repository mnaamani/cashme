// The root: a header, one screen at a time, and the log along the bottom.
//
// Routing is a string. There is no history stack because there is nowhere to go but back
// to the menu — every action starts there and returns there, and a wallet has no nested
// navigation worth keeping state for.
//
// The menu is the only screen that is reached without asking for it, so it is where the
// keyboard starts. Actions are picked from its list rather than typed as letters, which
// means this file no longer decides what the letters mean: the screen the keys are going
// to does.
//
// The log is the part worth explaining. Everything the wallet says about itself goes
// through note(), and this UI owns the screen, so those lines are redirected here (see
// lib/notes.mjs) and shown in a pane instead of being lost or painted over the layout. The
// manager keeps narrating exactly as it does on the command line; only where it lands
// changes.
import { h, text, column, row } from '../element.mjs'
import { useState, useEffect, useInput, useSize, useApp, useMemo } from '../runtime.mjs'
import { Panel, Hints, Log } from '../components.mjs'
import { usePoll } from '../hooks.mjs'
import { redirect } from '../../notes.mjs'
import { Menu } from './menu.mjs'
import { InFlight } from './inflight.mjs'
import { Balances } from './balances.mjs'
import { Zap } from './zap.mjs'
import { Nutzap } from './nutzap.mjs'
import { Settings } from './settings.mjs'
import { Deposit } from './deposit.mjs'
import { Give } from './give.mjs'
import { Get } from './get.mjs'
import { Withdraw } from './withdraw.mjs'

const SCREENS = {
  menu: Menu,
  balances: Balances,
  inflight: InFlight,
  settings: Settings,
  deposit: Deposit,
  give: Give,
  get: Get,
  withdraw: Withdraw,
  zap: Zap,
  nutzap: Nutzap
}

// What the top bar calls each screen. The menu is the resting state and needs no name.
const TITLES = {
  menu: '',
  balances: 'balances',
  inflight: 'in flight',
  settings: 'settings',
  deposit: 'deposit',
  give: 'give',
  get: 'get',
  withdraw: 'withdraw',
  zap: 'zap',
  nutzap: 'nutzap'
}

// How many lines of log to keep. A session that listens all afternoon should not grow a
// transcript nobody can scroll back through — the pane shows the last few and the count.
const LOG_LIMIT = 200

export function App({ api, version = '', ephemeral = false }) {
  const [route, setRoute] = useState('menu')
  // The action the menu was last inside. Coming back from a screen should leave the
  // keyboard where it was rather than at the top: someone who has just deposited and wants
  // to deposit again should not have to walk the list twice, and the highlight is also the
  // answer to "which one was I in?".
  const [from, setFrom] = useState(null)
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

  // The keys the root keeps. Ctrl-C ends the session from anywhere — raw mode makes it a
  // keystroke rather than a signal, and this handler is the outermost one, so a screen
  // holding the keyboard mid-operation cannot swallow it. Q and R are the two things the
  // menu is not a list of, so they are live only while the menu is what is on screen;
  // everything the wallet can *do* is chosen from that list instead.
  useInput((key) => {
    if (key.name === 'ctrl-c') return exit()
    if (route !== 'menu') return
    const pressed = key.input?.toLowerCase()
    if (pressed === 'q') return exit()
    if (pressed === 'r') return wallet.refresh()
  })

  // The log takes what is left after the header and the hint line, within reason: a short
  // terminal gives it two lines rather than eating the screen above it.
  const logHeight = Math.max(2, Math.min(6, rows - 20))
  // And the screen gets a height rather than whatever it comes to. Without one, a tall
  // pane — a QR, a long plan — pushes the log and the key hints off the bottom, and the
  // keys are the only thing telling the user how to get out of the screen doing the
  // pushing. Bounded here, the screen truncates and the way out stays visible.
  // useSize reports the frame's height, not the terminal's, so what is left for the screen
  // is that minus the header, the log pane and the hint line.
  const bodyHeight = Math.max(3, rows - 1 - (logHeight + 2) - 1)

  const Screen = SCREENS[route]
  const props = useMemo(
    () => ({
      api,
      columns,
      onBack: () => {
        setFrom(route)
        setRoute('menu')
        wallet.refresh()
      },
      onOpen: (next) => setRoute(next),
      // What a screen calls when it has moved money, so the header and the menu are reading
      // the wallet as it is now rather than as it was when the screen opened.
      onChanged: () => wallet.refresh(),
      snapshot: wallet.value,
      from,
      height: bodyHeight
    }),
    [api, columns, bodyHeight, route, from, wallet.value]
  )

  return column(
    { height: rows },
    h(TopBar, {
      route,
      totals: wallet.value?.totals,
      version,
      ephemeral,
      error: wallet.error,
      address: api.addressMode()
    }),
    column({ height: bodyHeight }, h(Screen, props)),
    h(
      Panel,
      { title: 'log', focus: false, height: logHeight + 2 },
      h(Log, { lines: log, height: logHeight })
    ),
    h(Hints, {
      columns,
      keys:
        route === 'menu'
          ? [
              ['↑↓', 'choose'],
              ['enter', 'open it'],
              ['r', 'refresh'],
              ['q', 'quit']
            ]
          : [['ctrl-c', 'quit']]
    })
  )
}

// The address mode sits up here because it is true of everything below it: which key the
// next hyperdht send or listen will wear. Yellow when it is this wallet's own, because
// that is the one with a consequence somebody should not discover afterwards.
//
// The dev badge is there for the same reason, one step earlier: a dev build with no
// --storage keeps its wallet in a temp directory, so a balance on this screen is a balance
// that goes away with the machine's next clear-out. Nothing else on screen distinguishes
// that from real money, so it is said in the one place that is true of every screen.
function TopBar({ route, totals, version, error, address, ephemeral }) {
  const balance = totals?.length
    ? totals.map((total) => `${total.spendable} ${total.unit}`).join('  ')
    : '0 sat'
  const stable = address === 'stable'
  return row(
    { gap: 2 },
    text(`cashme${version ? ` ${version}` : ''}`, { bold: true, cyan: true }),
    ephemeral ? text(' dev · temp storage ', { bold: true, inverse: true, yellow: true }) : null,
    text(TITLES[route] ?? route, { dim: true, grow: 1 }),
    text(address, { yellow: stable, dim: !stable }),
    error ? text(`✗ ${error.message}`, { red: true }) : text(balance, { bold: true })
  )
}
