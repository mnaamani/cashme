// The images in the README, drawn from the UI itself.
//
//   bare scripts/screenshot.mjs        (or: npm run screenshots)
//
// Mounts the real screens against a wallet that answers instantly, types at them the way a
// user would, and writes each painted frame out as an SVG. Nothing here is a picture of a
// terminal — see scripts/ansi-to-svg.mjs for why — so a change to a pane is a change to the
// documentation of it on the next run, and a README image that has gone out of date shows
// up as a diff rather than staying wrong until somebody notices.
import fs from 'bare-fs'
import path from 'bare-path'
import process from 'bare-process'
import { h } from '../lib/tui/element.mjs'
import { render } from '../lib/tui/runtime.mjs'
import { App } from '../lib/tui/screens/app.mjs'
import { FakeStdout, FakeStdin, settled } from '../lib/tui/testing.mjs'
import { note } from '../lib/notes.mjs'
import { banner, TRUE_COLOR } from '../lib/art.mjs'
import pkg from '../package.json'
import { toSvg } from './ansi-to-svg.mjs'

const OUT = path.join(import.meta.dirname ?? '.', '..', 'docs', 'media')

// A wallet with something in it and somewhere to have got it from. Different from the fake
// in test/tui-app.test.mjs on purpose: that one is shaped around the edges a test needs to
// push on, and this one is shaped to look like a wallet somebody actually uses.
function demoWallet() {
  const mints = [
    {
      mintUrl: 'https://mint.minibits.cash/Bitcoin',
      trusted: true,
      units: [
        {
          unit: 'sat',
          spendable: 18432,
          reserved: 0,
          proofs: 6,
          reservedProofs: 0,
          denominations: [
            { amount: 8192, count: 2 },
            { amount: 1024, count: 2 },
            { amount: 32, count: 2 }
          ]
        }
      ]
    },
    {
      mintUrl: 'https://nofees.testnut.cashu.space',
      trusted: true,
      units: [
        {
          unit: 'sat',
          spendable: 2589,
          reserved: 128,
          proofs: 11,
          reservedProofs: 1,
          denominations: [
            { amount: 2048, count: 1 },
            { amount: 512, count: 1 },
            { amount: 16, count: 1 },
            { amount: 1, count: 13 }
          ]
        }
      ]
    },
    {
      mintUrl: 'https://mint.coinos.io',
      trusted: false,
      units: []
    }
  ]

  const answer = (value) => () => Promise.resolve(value)

  return {
    defaultUnit: 'sat',
    mints: answer(mints),
    snapshot: answer({
      held: [
        {
          mintUrl: 'https://mint.minibits.cash/Bitcoin',
          unit: 'sat',
          spendable: 18432,
          reserved: 0
        },
        {
          mintUrl: 'https://nofees.testnut.cashu.space',
          unit: 'sat',
          spendable: 2589,
          reserved: 128
        }
      ],
      totals: [{ unit: 'sat', spendable: 21021 }],
      pending: [{ id: 'op-7', amount: 210, unit: 'sat', mintUrl: 'https://mint.coinos.io' }],
      mints: mints.map((mint) => mint.mintUrl)
    }),
    relays: answer({ urls: ['wss://relay.damus.io', 'wss://nos.lol'], custom: false }),
    addressMode: () => 'ephemeral',
    setAddress: (next) => next,
    proxy: () => null,
    settings: () => ({
      binary: '~/.local/bin/cashme',
      storage: '~/.local/share/cashme',
      wallet: '~/.local/share/cashme/wallet.json',
      proxy: null,
      dhtInterface: null,
      address: 'ephemeral'
    }),
    hold: () => () => {},
    holding: () => [],
    qr: () => null,
    inspect: (token) => ({ amount: 21, unit: 'sat', mintUrl: mints[0].mintUrl, token }),
    trusted: answer(true),
    listen: (opts) => {
      opts.onaddress?.('9f3c1a7e')
      return new Promise(() => {})
    },
    reach: answer(() => Promise.resolve(true))
  }
}

// The menu's order, so a shot can say which screen it wants rather than counting arrows.
const ACTIONS = [
  'settings',
  'mints',
  'relays',
  'in flight',
  'deposit',
  'give',
  'get',
  'withdraw',
  'zap',
  'nutzap'
]

function mount({ columns, rows, splash = false }) {
  const stdout = new FakeStdout({ columns, rows })
  const stdin = new FakeStdin()
  const app = render(h(App, { api: demoWallet(), version: 'v0.4.0', splash }), { stdout, stdin })
  const flush = async (turns = 6) => {
    for (let at = 0; at < turns; at++) await settled()
  }
  const type = async (input) => {
    stdin.type(input)
    await flush()
  }
  return {
    app,
    flush,
    type,
    // Every frame as it was written, escapes intact — which is the half testing.mjs throws
    // away, and the half this needs.
    painted: () => stdout.writes.filter((chunk) => chunk.startsWith('\x1b[H')),
    async open(action) {
      await type('\x1b[H')
      for (let at = 0; at < ACTIONS.indexOf(action); at++) await type('\x1b[B')
      await type('\r')
    }
  }
}

function save(name, frame, { title, columns, rows }) {
  const file = path.join(OUT, `${name}.svg`)
  fs.writeFileSync(file, `${toSvg(frame, { title, columns, rows })}\n`)
  console.log(`wrote ${path.relative(process.cwd(), file)}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The frame is painted one row and one column short of the terminal (see Runtime.size), so
// the image is sized to what was actually drawn rather than to what was asked for.
//
// `frame` picks which paint to keep. The splash wants one from the middle of its animation
// — the finished logo is only what it settles on, and the glitch is what it is for — and
// every other shot wants the last thing on screen.
async function shoot(
  name,
  { columns = 92, rows = 34, title = 'cashme', splash = false, frame = 'last', drive }
) {
  const ui = mount({ columns, rows, splash })
  await ui.flush()
  if (!splash) {
    for (const line of CHATTER) note(line)
    await ui.flush()
  }
  if (drive) await drive(ui)
  const painted = ui.painted()
  // A negative index counts back from the end, which is how the splash is picked: the
  // animation paints a frame per tick and skips the ones that came out identical, so where
  // it is in its decay is more reliably counted from the settled logo it finishes on than
  // from the first paint.
  const kept =
    frame === 'last'
      ? painted.at(-1)
      : frame < 0
        ? painted.at(Math.max(-painted.length, frame))
        : painted[Math.min(frame, painted.length - 1)]
  console.log(`  ${name}: ${painted.length} frames painted`)
  save(name, kept, { title, columns: columns - 1, rows: rows - 1 })
  ui.app.unmount()
}

fs.mkdirSync(OUT, { recursive: true })

// The wordmark part-way through arriving. A frame from the middle of the animation rather
// than the end of it: the finished logo is what the splash settles on, and the glitch is
// what it is for.
// What the log pane would be holding a minute into a session. The UI redirects note() into
// that pane (see lib/tui/screens/app.mjs), so this is the same path the wallet's own lines
// take — an empty pane in every screenshot would say the wallet never says anything.
const CHATTER = [
  'trusting https://mint.minibits.cash/Bitcoin',
  'deposited 20000 sat',
  'bluetooth: giving 210 sat to 4f9a21c8',
  'sent — waiting for the mint to say it was claimed',
  'pending: 1 send out in the world'
]

await shoot('tui-splash', {
  rows: 22,
  splash: true,
  // Far enough in that the letters are readable and still coming apart. The glitch is
  // seeded by the frame it is drawn on, so this is the same picture every time.
  frame: 13,
  drive: () => sleep(2600)
})

// The other half of what this thing looks like: no terminal to paint on, or `--help`
// asked for, and the same wordmark introduces the same wallet.
const introduction = banner({
  columns: 78,
  level: TRUE_COLOR,
  version: `v${pkg.version}`
})
save('cli-banner', introduction.join('\r\n'), {
  title: 'cashme --help',
  columns: 78,
  rows: introduction.length
})

await shoot('tui-menu', { title: 'cashme' })
await shoot('tui-mints', { title: 'cashme — mints', drive: (ui) => ui.open('mints') })
await shoot('tui-give', { title: 'cashme — give', drive: (ui) => ui.open('give') })

process.exit(0)
