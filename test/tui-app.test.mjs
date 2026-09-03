// The UI, driven the way a user drives it: keystrokes in, painted frames out.
//
// The wallet is faked here on purpose. What these tests are about is the wiring — that a
// key reaches the screen that should have it, that an operation's result lands in the pane
// that shows it, and above all that the mint-trust question is asked before a token from an
// unknown mint is claimed. What the wallet does with a token is coco's business and is
// tested against a real mint in test/integration.
import test from 'brittle'
import { h } from '../lib/tui/element.mjs'
import { render } from '../lib/tui/runtime.mjs'
import { App } from '../lib/tui/screens/app.mjs'
import { FakeStdout, FakeStdin, settled } from '../lib/tui/testing.mjs'
import { strip } from '../lib/tui/style.mjs'
import { normalizeRelayUrl } from '../lib/relays.mjs'

// Stands in for the relays built into the binary, which the screen shows until the list is
// changed.
const BUILT_IN_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol']

// A wallet that answers instantly and records what it was asked to do.
function fakeApi(overrides = {}) {
  const calls = []
  const held = new Set()
  // The relay list behaves as the file does: reads say where the list came from, and the
  // first change makes it this wallet's own.
  let relays = [...BUILT_IN_RELAYS]
  let custom = false
  let address = 'ephemeral'
  const record =
    (name, result) =>
    (...args) => {
      calls.push([name, ...args])
      return Promise.resolve(typeof result === 'function' ? result(...args) : result)
    }

  return {
    calls,
    defaultUnit: 'sat',
    mints: record('mints', [
      {
        mintUrl: 'https://mint.example',
        trusted: true,
        units: [
          {
            unit: 'sat',
            spendable: 8000,
            reserved: 0,
            proofs: 3,
            reservedProofs: 0,
            denominations: [
              { amount: 4096, count: 1 },
              { amount: 2048, count: 1 },
              { amount: 8, count: 2 }
            ]
          }
        ]
      },
      {
        mintUrl: 'https://other.example',
        trusted: true,
        units: [
          {
            unit: 'sat',
            spendable: 137,
            reserved: 21,
            proofs: 5,
            reservedProofs: 2,
            denominations: [
              { amount: 128, count: 1 },
              { amount: 1, count: 9 }
            ]
          },
          {
            unit: 'usd',
            spendable: 12,
            reserved: 0,
            proofs: 2,
            reservedProofs: 0,
            denominations: [
              { amount: 8, count: 1 },
              { amount: 4, count: 1 }
            ]
          }
        ]
      }
    ]),
    snapshot: record('snapshot', {
      held: [{ mintUrl: 'https://mint.example', unit: 'sat', spendable: 8000, reserved: 0 }],
      totals: [{ unit: 'sat', spendable: 8000 }],
      pending: [],
      // What the mint fields complete from, in the order the real snapshot puts them:
      // the one holding something first.
      mints: ['https://mint.example', 'https://other.example']
    }),
    deposit: record('deposit', ({ onQuote }) => {
      onQuote({ request: 'lnbc1invoice' })
      return { amount: 100 }
    }),
    // A bolt11 long enough to wrap, which is the case the pane is shaped for.
    depositLong: 'lnbc1' + 'q7w8e9r0t1y2u3i4o5p6a7s8d9f0g1h2j3k4l5z6x7c8v9b0n1m2'.repeat(4),
    prepareGive: record('prepareGive', { mintUrl: 'https://mint.example', prepared: {}, fee: 0 }),
    executeGive: record('executeGive', { operation: { id: 'op1' }, token: 'cashuBtoken' }),
    // A token long enough to wrap, which is the case the pane is shaped for.
    longToken: 'cashuB' + 'o2FteBtodHRwczovL3Rlc3RudXQuY2FzaHUuc3BhY2VhdWNzYXQ'.repeat(4),
    cancelGive: record('cancelGive'),
    finalizeGive: record('finalizeGive'),
    reclaim: record('reclaim'),
    awaitClaim: record('awaitClaim', true),
    reach: record('reach', () => () => Promise.resolve(true)),
    inspect: (token) => ({ amount: 21, unit: 'sat', mintUrl: 'https://stranger.example', token }),
    trusted: record('trusted', false),
    trust: record('trust'),
    trustMint: record('trustMint'),
    untrustMint: record('untrustMint'),
    claim: record('claim'),
    listen: (opts) => {
      calls.push(['listen', opts])
      opts.onaddress?.('a1b2c3d4'.repeat(8))
      return opts.cancelled ?? new Promise(() => {})
    },
    planWithdraw: record('planWithdraw', {
      payable: true,
      unit: 'sat',
      mintUrl: 'https://mint.example',
      quote: { amount: 100, fee_reserve: 2 },
      lines: ['Paying from https://mint.example', '  invoice     100 sat']
    }),
    settleWithdraw: record('settleWithdraw', { changeAmount: 1, effectiveFee: 1 }),
    planZap: record('planZap', ({ pubkey, amount }) => ({
      typed: pubkey,
      recipient: 'b'.repeat(64),
      label: pubkey,
      amount,
      receipt: true,
      warnings: [],
      melt: {
        payable: true,
        lines: ['Paying from https://mint.example', `  invoice     ${amount} sat`]
      }
    })),
    settleZap: record('settleZap', { effectiveFee: 1 }),
    planNutzap: record('planNutzap', ({ pubkey, amount }) => ({
      typed: pubkey,
      recipient: 'a'.repeat(64),
      lockKey: `02${'a'.repeat(64)}`,
      relays: ['wss://relay.example'],
      mintUrl: 'https://mint.example',
      amount,
      fee: 0,
      warnings: [],
      prepared: { id: 'p1' }
    })),
    settleNutzap: record('settleNutzap', {
      accepted: 1,
      results: [{ ok: true }],
      event: { id: 'e1' }
    }),
    cancelNutzap: record('cancelNutzap'),
    refresh: record('refresh', { state: 'pending' }),
    qr: () => ({ width: 20, lines: ['▀▀▀', '▄▄▄'] }),
    copy: record('copy', 'pbcopy'),
    paste: record('paste', 'cashuBfromclipboard'),
    addressMode: () => address,
    setAddress: (next) => {
      address = next
      return address
    },
    proxy: () => ({ name: 'socks5://127.0.0.1:1080', source: 'ALL_PROXY' }),
    settings: () => ({
      binary: '/tmp/bare',
      storage: '/tmp/wallet',
      wallet: '/tmp/wallet/wallet.json',
      proxy: { name: 'socks5://127.0.0.1:1080', source: 'ALL_PROXY' },
      dhtInterface: 'en0',
      address
    }),
    hold: (entry) => {
      held.add(entry)
      return () => held.delete(entry)
    },
    holding: () => [...held],
    relays: record('relays', () => ({ urls: [...relays], custom })),
    addRelay: record('addRelay', (typed) => {
      // The real one writes a url down one way however it was typed, and the screen shows
      // what came back — so the fake normalizes too rather than echoing the keystrokes.
      const url = normalizeRelayUrl(typed)
      const added = !relays.includes(url)
      if (added) relays.push(url)
      custom = true
      return { url, urls: [...relays], added }
    }),
    removeRelay: record('removeRelay', (url) => {
      relays = relays.filter((entry) => entry !== url)
      custom = true
      return { url, urls: [...relays] }
    }),
    resetRelays: record('resetRelays', () => {
      relays = [...BUILT_IN_RELAYS]
      custom = false
      return { urls: [...relays], custom }
    }),
    ...overrides
  }
}

// The menu's order, so a test can say which action it wants rather than counting arrows.
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

// Mounts the app and returns the handles a test drives it with. `flush` waits for the
// renders an action sets off — state set in an effect paints on a later turn, not this one.
function mount(api, { columns = 80, rows = 30, ephemeral = false } = {}) {
  const stdout = new FakeStdout({ columns, rows })
  const stdin = new FakeStdin()
  const app = render(h(App, { api, version: 'v0', ephemeral }), { stdout, stdin })
  const flush = async (turns = 4) => {
    for (let i = 0; i < turns; i++) await settled()
  }
  const type = async (input, turns) => {
    stdin.type(input)
    await flush(turns)
  }
  // Walks the menu down to an action and opens it — the only way in now that the letters
  // are gone, so every test that used to press one goes through here.
  const pick = async (action) => {
    const at = ACTIONS.indexOf(action)
    if (at < 0) throw new Error(`no such action: ${action}`)
    // Home first: the menu keeps its selection across visits, so counting downs from
    // wherever the last screen left it picks the wrong action on the second trip.
    await type('\x1b[H')
    for (let i = 0; i < at; i++) await type('\x1b[B')
    await type('\r')
  }
  // Enter walks a form forward and stops on the button, so filling one in and running it
  // is a run of enters — the last of which is the press on the button itself.
  const enter = async (times = 1) => {
    for (let i = 0; i < times; i++) await type('\r')
  }
  return { app, stdout, stdin, flush, type, pick, enter, screen: () => stdout.screen() }
}

test('the menu shows what the wallet holds and what can be done with it', async (t) => {
  const ui = mount(fakeApi())
  await ui.flush()

  t.ok(ui.screen().includes('8000 sat'), 'what the wallet is worth')
  for (const action of ACTIONS) {
    t.ok(ui.screen().includes(action), `${action} is on the list`)
  }
  t.ok(ui.screen().includes('nothing waiting to settle'), 'in flight says how much is waiting')
  t.ok(ui.screen().includes('Enter to open it'), 'and the list says how to pick from it')

  await ui.type('q')
  t.ok(await ui.app.waitUntilExit().then(() => true), 'q ends the session')
  t.is(ui.stdin.raw, false, 'and the terminal is handed back')
})

test('a dev build says so, because the wallet on screen is in a temp directory', async (t) => {
  const plain = mount(fakeApi())
  await plain.flush()
  t.absent(plain.screen().includes('temp storage'), 'a real build wears no badge')
  plain.app.unmount()

  const dev = mount(fakeApi(), { ephemeral: true })
  await dev.flush()
  t.ok(dev.screen().includes('dev · temp storage'), 'a dev build wears one on every screen')
  await dev.pick('withdraw')
  t.ok(dev.screen().includes('dev · temp storage'), 'including inside an action')
  dev.app.unmount()
})

test('the arrow keys move the selection, and a letter no longer jumps anywhere', async (t) => {
  const ui = mount(fakeApi())
  await ui.flush()

  // The marker sits against whichever action the keys are pointed at.
  const chosen = () =>
    ui
      .screen()
      .split('\n')
      .find((line) => line.includes('\u203a'))

  t.ok(chosen().includes('settings'), 'the list starts on the first action')
  await ui.type('\x1b[B')
  t.ok(chosen().includes('mints'), 'down moves to the next one')
  await ui.type('\x1b[A')
  t.ok(chosen().includes('settings'), 'and up moves back')

  // w used to open withdraw. It is an ordinary keystroke now, and the menu is still here.
  await ui.type('w')
  t.ok(chosen().includes('settings'), 'a former shortcut does not move the selection')
  t.absent(ui.screen().includes('pay this invoice'), 'nor open the screen it used to')

  ui.app.unmount()
})

test('an action opens on enter, and escape comes back to the menu', async (t) => {
  const ui = mount(fakeApi())
  await ui.flush()

  await ui.pick('withdraw')
  t.ok(ui.screen().includes('withdraw'), 'the withdraw screen is up')

  await ui.type('\x1b')
  t.ok(ui.screen().includes('mint ecash against a lightning invoice'), 'escape is back at the menu')

  ui.app.unmount()
})

test('deposit puts the invoice on screen while the mint is still waiting to be paid', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('deposit')
  t.ok(ui.screen().includes('deposit'), 'picking it opens the deposit screen')

  await ui.type('100')
  await ui.enter() // onto the mint, which is not filled in for you
  await ui.type('https://mint.example')
  await ui.enter(3) // through unit, onto the button, then press it

  t.ok(ui.screen().includes('lnbc1invoice'), 'the invoice appears')
  t.ok(ui.screen().includes('pay this invoice'), 'in the pane that says to pay it')
  const call = api.calls.find(([name]) => name === 'deposit')
  t.is(call[1].amount, 100, 'and the amount typed is the amount asked for')

  ui.app.unmount()
})

test('deposit does not fill the mint in for you, and will not act until it is', async (t) => {
  // Which mint to deposit at is the decision to trust it. A form that arrives with one
  // already typed in is one people press enter through, and the one it used to arrive with
  // was a testing mint whose ecash is worthless.
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('deposit')
  t.ok(ui.screen().includes('the mint to deposit at'), 'the field is empty and says what goes in')
  t.absent(ui.screen().includes('testnut'), "nothing is chosen on the user's behalf")

  await ui.type('100')
  await ui.enter(3) // past the empty mint and the unit, onto the button
  t.ok(ui.screen().includes('a mint is needed'), 'and it says which half is missing')

  await ui.type('\r')
  t.absent(
    api.calls.some(([name]) => name === 'deposit'),
    'the button will not act without one'
  )

  ui.app.unmount()
})

test('a mint field completes from the mints this wallet trusts', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('deposit')
  await ui.type('100')
  await ui.enter() // onto the mint

  // Nothing is offered before anything is typed: which mint to deposit at stays a choice
  // the user makes, and the empty field goes on saying what belongs in it.
  t.ok(ui.screen().includes('the mint to deposit at'), 'an empty field offers nothing')

  await ui.type('https://m')
  t.ok(ui.screen().includes('https://mint.example'), 'a prefix brings up the rest of the match')
  t.ok(ui.screen().includes('Tab to take the mint offered'), 'and the key that takes it is named')

  await ui.type('\t')
  await ui.enter(2) // through the unit, onto the button
  await ui.type('\r')

  t.is(
    api.calls.find(([name]) => name === 'deposit')?.[1].mintUrl,
    'https://mint.example',
    'accepting it fills the field in whole'
  )

  ui.app.unmount()
})

test('every form with a mint field completes it, not just the deposit one', async (t) => {
  // Four screens ask for a mint and each keeps its form differently — an object here, a
  // state of its own there, and give's fields change with the method. The wiring is what
  // this checks: that the accepted url is what reaches the wallet in each of them.
  for (const [action, keys, call, field] of [
    ['give', ['\r', '21', '\r'], 'prepareGive', 'mint'],
    ['withdraw', ['lnbc1test', '\r'], 'planWithdraw', 'mint'],
    ['nutzap', ['npub1someone', '\r', '21', '\r'], 'planNutzap', 'mint']
  ]) {
    const api = fakeApi({ reach: () => new Promise(() => {}) })
    const ui = mount(api, { columns: 96 })
    await ui.flush()

    await ui.pick(action)
    for (const key of keys) await ui.type(key)
    await ui.type('https://o')
    t.ok(ui.screen().includes('https://other.example'), `${action}: the rest of the match shows`)

    await ui.type('\t')
    await ui.enter(4) // out of the fields, onto the button, and press it
    await ui.flush(6)

    t.is(
      api.calls.find(([name]) => name === call)?.[1][field],
      'https://other.example',
      `${action}: the completed mint is the one the wallet is asked about`
    )

    ui.app.unmount()
  }
})

test('a mint is found by the memorable part of its url, not just the front', async (t) => {
  // Every mint url starts `https://`, so the front of one is the part nobody remembers.
  // Typing what they do remember has to find it.
  const api = fakeApi()
  const ui = mount(api, { columns: 96 })
  await ui.flush()

  await ui.pick('deposit')
  await ui.type('100')
  await ui.enter()
  await ui.type('other')

  t.ok(ui.screen().includes('→ https://other.example'), 'the whole url is offered alongside')
  t.ok(ui.screen().includes('Tab to take the mint offered'), 'and the key that takes it is named')

  await ui.type('\t')
  await ui.enter(2)
  await ui.type('\r')

  // A match found in the middle has no tail to append, so taking it replaces what was
  // typed. Appending would have asked the mint about `otherhttps://other.example`.
  t.is(
    api.calls.find(([name]) => name === 'deposit')?.[1].mintUrl,
    'https://other.example',
    'taking it replaces what was typed rather than adding to it'
  )

  ui.app.unmount()
})

test('a completion is only ever offered, never applied on its own', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('deposit')
  await ui.type('100')
  await ui.enter()
  await ui.type('https://m')
  // Walking past a field with a suggestion in it must not take the suggestion: enter is
  // how a form is walked, and it means the same thing here as everywhere else.
  await ui.enter(2)
  await ui.type('\r')

  t.is(
    api.calls.find(([name]) => name === 'deposit')?.[1].mintUrl,
    'https://m',
    'what was typed is what is used'
  )

  ui.app.unmount()
})

test('what does not match a trusted mint is left alone', async (t) => {
  const ui = mount(fakeApi())
  await ui.flush()

  await ui.pick('deposit')
  await ui.type('100')
  await ui.enter()
  await ui.type('https://stranger')

  t.absent(ui.screen().includes('Tab to take'), 'nothing is offered for a mint we do not know')
  // Tab keeps its ordinary meaning where there is nothing to accept, so a field with no
  // suggestion in it is walked exactly as it was before.
  await ui.type('\t')
  t.ok(ui.screen().includes('unit'), 'and tab moves on as it always did')

  ui.app.unmount()
})

test('a form opens with its first field explaining itself, not just blinking', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('deposit')
  t.ok(ui.screen().includes('sats'), 'the focused empty field still says what goes in it')

  await ui.type('100')
  const typed = ui.screen()
  t.ok(typed.includes('100'), 'what is typed appears')
  t.absent(typed.includes('sats'), 'and the hint gives way to it rather than trailing after')

  ui.app.unmount()
})

test('an invoice that wraps can be dragged out with a mouse, and copied with a key', async (t) => {
  const long = fakeApi().depositLong
  const api = fakeApi({
    deposit: ({ onQuote }) => {
      onQuote({ request: long })
      return new Promise(() => {}) // stays waiting to be paid, which is when it is copied
    }
  })
  const ui = mount(api, { columns: 76 })
  await ui.flush()

  await ui.pick('deposit')
  await ui.type('100')
  await ui.enter()
  await ui.type('https://mint.example')
  await ui.enter(3)

  const lines = ui.screen().split('\n')
  const first = lines.findIndex((line) => line.includes('lnbc1'))
  t.ok(first > 0, 'the invoice is on screen')

  // The point of the whole exercise: a drag down the wrapped lines must not pick up a box
  // side, because a pasted invoice with a │ in it is not an invoice. Consecutive lines
  // from the first, which is what a drag selects.
  const body = []
  for (let i = first; i < lines.length && /^[a-z0-9]+$/i.test(lines[i]); i++) {
    body.push(lines[i])
  }
  t.ok(body.length > 1, 'and it wraps onto more than one line')
  t.absent(
    body.some((line) => line.includes('│')),
    'no line of it has a box side on it'
  )
  t.is(body.join(''), long, 'and the lines put back together are exactly the invoice')

  // The key is the reliable way, and the one that works when the wrapping newlines would
  // not survive a paste.
  t.ok(ui.screen().includes('C to copy the invoice'), 'the key is offered')
  await ui.type('c')
  t.is(api.calls.find(([name]) => name === 'copy')?.[1], long, 'c copies the whole invoice')
  t.ok(ui.screen().includes('copied to the clipboard'), 'and says it did')

  ui.app.unmount()
})

test('a token from an unknown mint is not claimed until the question is answered', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('get')
  await ui.type('\r') // paste is the first source; enter commits it and opens the field
  await ui.type('cashuBtoken')
  await ui.enter(2) // out of the field, onto the button, then press it

  t.ok(ui.screen().includes('stranger.example'), 'the mint is named in the question')
  t.ok(ui.screen().includes('never used'), 'and said to be one this wallet has never used')
  t.absent(
    api.calls.some(([name]) => name === 'claim'),
    'nothing is claimed while the question stands'
  )

  await ui.type('y')
  t.ok(
    api.calls.some(([name]) => name === 'trust'),
    'answering yes trusts the mint'
  )
  t.ok(
    api.calls.some(([name]) => name === 'claim'),
    'and then claims the token'
  )

  ui.app.unmount()
})

test('answering no leaves the mint untrusted and the token unclaimed', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('get')
  await ui.type('\r')
  await ui.type('cashuBtoken')
  await ui.enter(2)
  await ui.type('n')

  t.absent(
    api.calls.some(([name]) => name === 'trust'),
    'the mint is not added'
  )
  t.absent(
    api.calls.some(([name]) => name === 'claim'),
    'and the ecash is not taken'
  )
  t.ok(ui.screen().includes('declined'), 'the screen says what happened')

  ui.app.unmount()
})

test('pasting is opened with a second enter, since it has something to type into', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('get')
  t.ok(ui.screen().includes('Enter to paste a token'), 'the keys say what enter will do here')

  // 'k' is up to a selection list and a character to a text field. Typing the token before
  // committing the source must therefore not reach the field — this is what the extra
  // enter buys, so it is asserted rather than assumed. It does walk the list, which is why
  // the test puts it back with home before going in.
  await ui.type('cashuBtoken')
  t.absent(ui.screen().includes('cashuBtoken'), 'typing does not reach the field yet')

  // Back to a known row first: the 'k' above walked the list, which is the point.
  await ui.type('\x1b[H')
  await ui.type('\x1b[B')
  t.ok(ui.screen().includes('Enter to listen'), 'and says something else on a source that listens')
  await ui.type('\x1b[H')

  await ui.type('\r')
  t.ok(ui.screen().includes('Esc to change source'), 'enter hands the keyboard to the field')
  await ui.type('cashuBtoken')
  t.ok(ui.screen().includes('cashuBtoken'), 'and now typing lands in it')

  // And back out again, without losing what was typed.
  await ui.type('\x1b')
  t.ok(ui.screen().includes('Enter to paste a token'), 'escape returns to the list')
  t.ok(ui.screen().includes('cashuBtoken'), 'with the token still there')

  ui.app.unmount()
})

test('give picks its method with the arrows too, and keeps the form behind an enter', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('give')
  await ui.type('21')
  t.absent(ui.screen().includes('21'), 'the amount does not reach the form from the method list')

  await ui.type('\x1b[B')
  await ui.type('\r')
  t.ok(ui.screen().includes('their key'), 'down then enter opens bluetooth, which needs a key')

  await ui.type('21')
  t.ok(ui.screen().includes('21'), 'and the form takes the amount now')

  ui.app.unmount()
})

test('a source with nothing to type starts on one enter', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('get')
  await ui.type('\x1b[B') // bluetooth
  t.ok(ui.screen().includes('Enter starts listening'), 'the screen says so before it happens')

  await ui.type('\r')
  t.ok(
    api.calls.some(([name]) => name === 'listen'),
    'and the one enter is what starts it'
  )
  t.ok(ui.screen().includes('listening on bluetooth'), 'with no step in between')

  ui.app.unmount()
})

test('the local network is a wire of its own on both sides', async (t) => {
  const api = fakeApi()
  // Wide enough that the address caption is one line, so it can be asserted as one.
  const ui = mount(api, { columns: 96 })
  await ui.flush()

  // Receiving: it listens, and the address it hands out is a prefix-matched one.
  await ui.pick('get')
  await ui.type('\x1b[B')
  await ui.type('\x1b[B') // local network
  await ui.type('\r')

  t.is(
    api.calls.find(([name]) => name === 'listen')?.[1].wire,
    'lan',
    'listening goes out over the local network'
  )
  t.ok(ui.screen().includes('listening on the local network'), 'and says which wire it is on')
  t.ok(ui.screen().includes('give → local network → their key'), 'the address says where it goes')
  t.ok(ui.screen().includes('any prefix of it'), 'and that a prefix will do, as on bluetooth')

  await ui.type('\x1b')
  await ui.type('\x1b') // out of receive, back to the menu
  await ui.flush()

  ui.app.unmount()
})

test('giving over the local network is aimed at that wire and says so', async (t) => {
  // reach hangs, so the screen stays on the step that names the wire.
  const api = fakeApi({ reach: (...args) => new Promise(() => {}) })
  const ui = mount(api, { columns: 96 })
  await ui.flush()

  await ui.pick('give')
  await ui.type('\x1b[B')
  await ui.type('\x1b[B') // local network
  await ui.type('\r')
  t.ok(ui.screen().includes('their key'), 'it needs a key, as the other wires do')
  t.ok(ui.screen().includes('any prefix of their key'), 'and a prefix of one will do')

  await ui.type('21')
  await ui.type('\t')
  await ui.type('deadbeef')
  await ui.enter(4) // past the mint and unit fields, onto the button, then press it

  t.ok(ui.screen().includes('looking on the local network'), 'the wire is named while it waits')

  ui.app.unmount()
})

test('ctrl-v reads the clipboard into the token field', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('get')
  await ui.type('\r')
  t.ok(ui.screen().includes('Ctrl-V to paste'), 'the key is offered where it works')

  await ui.type('\x16')
  t.ok(
    api.calls.some(([name]) => name === 'paste'),
    'the clipboard is read'
  )
  t.ok(ui.screen().includes('cashuBfromclipboard'), 'and what it held lands in the field')

  await ui.enter(2)
  await ui.type('y') // the fake mint is one this wallet has not used, so the question stands
  t.is(
    api.calls.find(([name]) => name === 'claim')?.[1],
    'cashuBfromclipboard',
    'so enter claims what was pasted'
  )

  ui.app.unmount()
})

test('a clipboard with nothing to read says so rather than failing quietly', async (t) => {
  const api = fakeApi({ paste: () => Promise.resolve(null) })
  const ui = mount(api)
  await ui.flush()

  await ui.pick('get')
  await ui.type('\r')
  await ui.type('\x16')

  t.ok(ui.screen().includes('no clipboard tool here'), 'the screen says why nothing arrived')
  t.ok(ui.screen().includes('Esc to change source'), 'and the keys are under the pane they act on')

  ui.app.unmount()
})

test('listening shows the address a sender has to be given, and copies it', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('get')
  t.absent(ui.screen().includes('your address'), 'there is no address before a wire is up')

  await ui.type('\x1b[B') // bluetooth
  await ui.type('\r') // one enter is the whole gesture: there is nothing to type
  t.ok(ui.screen().includes('your address'), 'the address pane appears with the wire')
  t.ok(ui.screen().includes('a1b2c3d4'.repeat(8)), 'and carries the key the swarm gave us')
  t.ok(ui.screen().includes('any prefix of it'), 'said the way the give screen wants it')
  t.ok(ui.screen().includes('C to copy your address'), 'with a key to copy it')

  await ui.type('c')
  t.is(
    api.calls.find(([name]) => name === 'copy')?.[1],
    'a1b2c3d4'.repeat(8),
    'c copies the address, not the last token'
  )
  t.ok(ui.screen().includes('copied to the clipboard'), 'and says it did')

  // Stopping takes the wire down, so the address stops being true.
  await ui.type('\x1b')
  t.absent(ui.screen().includes('your address'), 'the address goes when the wire does')

  ui.app.unmount()
})

test('the hyperdht address is presented as the whole key, since a prefix will not do', async (t) => {
  const ui = mount(fakeApi())
  await ui.flush()

  await ui.pick('get')
  await ui.type('\x1b[F') // end of the list is the hyperdht
  await ui.type('\r')

  t.ok(ui.screen().includes('needs all of this'), 'the whole key is asked for')
  t.absent(ui.screen().includes('any prefix'), 'and a prefix is not offered')

  ui.app.unmount()
})

test('withdraw quotes before it spends, and spends only once confirmed', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('withdraw')
  await ui.type('lnbc1test')
  await ui.enter(3) // past the mint field, onto the button, then press it

  t.ok(ui.screen().includes('Paying from https://mint.example'), 'the plan is shown')
  t.ok(ui.screen().includes('Pay this invoice?'), 'and confirmation is asked for')
  t.absent(
    api.calls.some(([name]) => name === 'settleWithdraw'),
    'nothing is spent while the question stands'
  )

  await ui.type('y')
  t.ok(
    api.calls.some(([name]) => name === 'settleWithdraw'),
    'y pays it'
  )
  t.ok(ui.screen().includes('paid'), 'and the result says so')

  ui.app.unmount()
})

test('a second withdraw is confirmed too, rather than quoting into a screen that acts', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('withdraw')
  await ui.type('lnbc1first')
  await ui.enter(3)
  await ui.type('y')
  t.ok(ui.screen().includes('paid'), 'the first one is paid')

  // The finished payment used to be what the screen read to decide whether anything had
  // been spent yet, so the second plan arrived with no question in front of it.
  await ui.type('lnbc1second')
  await ui.enter(3)
  t.ok(ui.screen().includes('Pay this invoice?'), 'the second is asked about as well')
  t.is(
    api.calls.filter(([name]) => name === 'settleWithdraw').length,
    1,
    'and nothing is spent while that question stands'
  )

  ui.app.unmount()
})

test('a second nutzap is confirmed too, so its reserved proofs keep a way back', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('nutzap')
  await ui.type('npub1first')
  await ui.enter()
  await ui.type('21')
  await ui.enter(4) // past the mint and comment fields, onto the button, then press it
  await ui.type('y')
  t.ok(ui.screen().includes('nutzapped'), 'the first one is sent')

  await ui.type('\x1b[B') // enter stops on the button, so the arrows go round again
  await ui.enter(5) // back down the four fields, onto the button, then press it
  t.ok(ui.screen().includes('Nutzap'), 'the second lookup is asked about as well')
  t.is(
    api.calls.filter(([name]) => name === 'settleNutzap').length,
    1,
    'nothing is published while that question stands'
  )
  // Refusing is the path that hands the reserved proofs back, and it only exists while the
  // question is on screen.
  await ui.type('n')
  t.ok(
    api.calls.some(([name]) => name === 'cancelNutzap'),
    'and refusing gives the proofs back'
  )

  ui.app.unmount()
})

test('c is the copy key only where it cannot be a character being typed', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('give')
  await ui.type('\r') // hand over
  await ui.type('21')
  await ui.enter(4)
  t.ok(ui.screen().includes('cashuBtoken'), 'the token is on screen')

  // The token stays up while the form below it takes keystrokes again, and a mint url is
  // full of c's — so they have to reach the field rather than the clipboard.
  // Enter stops on the button, so the arrows are what go round to the mint field.
  await ui.type('\x1b[B') // round to the amount
  await ui.type('\x1b[B') // and on to the mint
  await ui.type('cashu.example')
  t.ok(ui.screen().includes('cashu.example'), 'the url is typed, not swallowed')
  t.absent(
    api.calls.some(([name]) => name === 'copy'),
    'and nothing was copied'
  )

  ui.app.unmount()
})

test('a token refused over a wire is kept, since the sender has already let go of it', async (t) => {
  // The wire acknowledges a token the moment it parses — before the mint question is even
  // put — so by the time it is refused the sender has finalized its send and this string is
  // the only copy of the money left. Losing it would make declining a mint cost the user
  // the ecash rather than the mint.
  const { tokenQueue } = await import('../lib/token-wire.mjs')
  const arrived = 'cashuBfromastranger'
  const api = fakeApi({
    listen: ({ cancelled, onaddress, ontoken }) => {
      onaddress('a1b2c3d4'.repeat(8))
      // The real wires hand tokens over through this queue, and it is the queue that
      // decides what a throwing handler means.
      const queue = tokenQueue(ontoken)
      return queue.enqueue(arrived).then(() => cancelled)
    }
  })
  const ui = mount(api)
  await ui.flush()

  await ui.pick('get')
  await ui.type('\x1b[B') // bluetooth
  await ui.type('\r')
  await ui.flush(8)

  t.ok(ui.screen().includes('never used'), 'the mint is put to the user')
  await ui.type('n')
  await ui.flush(8)

  t.absent(
    api.calls.some(([name]) => name === 'claim'),
    'refusing claims nothing'
  )
  t.absent(
    api.calls.some(([name]) => name === 'trust'),
    'and trusts nothing'
  )
  t.ok(ui.screen().includes(arrived), 'but the token itself is in the log to be claimed later')

  ui.app.unmount()
})

test('a listening session says how many it took, not just that it stopped', async (t) => {
  const api = fakeApi({
    trusted: () => Promise.resolve(true),
    listen: ({ cancelled, onaddress, ontoken }) => {
      onaddress('a1b2c3d4'.repeat(8))
      return (async () => {
        await ontoken('cashuBone')
        await cancelled
      })()
    }
  })
  const ui = mount(api)
  await ui.flush()

  await ui.pick('get')
  await ui.type('\x1b[B') // bluetooth
  await ui.type('\r')
  await ui.flush(8)
  await ui.type('\x1b') // stop listening
  await ui.flush(8)

  t.ok(ui.screen().includes('took 1'), 'the count comes from what actually went through')

  ui.app.unmount()
})

test('give hands the token over and says the proofs are no longer ours to keep', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('give')
  t.ok(ui.screen().includes('hand over'), 'the ways to give are listed')
  await ui.type('\r') // hand over is the first method; enter commits it and opens the form
  await ui.type('21')
  await ui.enter(4) // past the mint and unit fields, onto the button, then press it

  t.ok(ui.screen().includes('cashuBtoken'), 'the token is on screen')
  t.ok(
    api.calls.some(([name]) => name === 'awaitClaim'),
    'and the mint is polled for whether it was claimed'
  )

  ui.app.unmount()
})

test('escape while the mint is being asked stops the send and hands the proofs back', async (t) => {
  // prepareGive is a mint round trip, and the screen is busy for all of it. Escape pressed
  // there used to land on a cancel handle that did not exist yet, and the send went on to
  // make a token anyway.
  let release
  const api = fakeApi({
    prepareGive: () =>
      new Promise((resolve) => {
        release = () => resolve({ mintUrl: 'https://mint.example', prepared: { id: 'p1' }, fee: 0 })
      })
  })
  const ui = mount(api)
  await ui.flush()

  await ui.pick('give')
  await ui.type('\r')
  await ui.type('21')
  await ui.enter(4) // past the mint and unit fields, onto the button, then press it
  t.ok(ui.screen().includes('reserving proofs'), 'the send is under way')

  await ui.type('\x1b') // the user gives up while the mint is still being asked
  release()
  await ui.flush(8)

  t.ok(
    api.calls.some(([name]) => name === 'cancelGive'),
    'the reserved proofs are handed back'
  )
  t.absent(
    api.calls.some(([name]) => name === 'executeGive'),
    'and no token is made after the user asked to stop'
  )
  t.is(api.holding().length, 0, 'nothing is left owed')

  ui.app.unmount()
})

test('give spends in the unit it was told to, not always in sats', async (t) => {
  const api = fakeApi({ reach: () => new Promise(() => {}) })
  const ui = mount(api)
  await ui.flush()

  await ui.pick('give')
  await ui.type('\x1b[B') // bluetooth
  await ui.type('\r')
  await ui.type('12')
  await ui.type('\t')
  await ui.type('deadbeef')
  await ui.enter(2) // past the mint field, onto the unit
  await ui.type('\x15') // ctrl-u empties it
  await ui.type('usd')
  await ui.enter(2) // onto the button, then press it

  const call = api.calls.find(([name]) => name === 'prepareGive')
  t.is(call[1].unit, 'usd', 'the unit typed is the one the proofs are reserved in')

  // And it is the unit the session would name if it had to hand those proofs back after
  // the screen was gone, which is the message the user reads in their shell.
  t.is(api.holding()[0].unit, 'usd', 'and the one the session owes them back in')

  ui.app.unmount()
})

test('an empty unit falls back rather than reserving in nothing', async (t) => {
  const api = fakeApi({ reach: () => new Promise(() => {}) })
  const ui = mount(api)
  await ui.flush()

  await ui.pick('give')
  await ui.type('\x1b[B') // bluetooth
  await ui.type('\r')
  await ui.type('12')
  await ui.type('\t')
  await ui.type('deadbeef')
  await ui.enter(2) // past the mint field, onto the unit
  await ui.type('\x15') // ctrl-u empties it
  await ui.enter(2) // onto the button, then press it

  t.is(
    api.calls.find(([name]) => name === 'prepareGive')[1].unit,
    'sat',
    "an empty field means the wallet's own unit, not an empty one"
  )

  ui.app.unmount()
})

test('a send still holding proofs is registered so the session can give them back', async (t) => {
  const api = fakeApi({ reach: () => new Promise(() => {}) })
  const ui = mount(api)
  await ui.flush()

  await ui.pick('give')
  await ui.type('\x1b[B') // bluetooth
  await ui.type('\r')
  await ui.type('21')
  await ui.type('\t')
  await ui.type('deadbeef')
  await ui.enter(4) // past the mint and unit fields, onto the button, then press it

  const owed = api.holding()
  t.is(owed.length, 1, 'the reserved proofs are on the books while the peer is looked for')
  t.is(owed[0].amount, 21, 'for the amount that was reserved')
  t.is(owed[0].mintUrl, 'https://mint.example', 'at the mint it was reserved from')

  // What lib/cli/tui.mjs does once the screen is gone.
  owed[0].stop()
  await owed[0].giveBack()
  await ui.flush(8)
  t.ok(
    api.calls.some(([name]) => name === 'cancelGive'),
    'and giving them back is a call the api understands'
  )

  ui.app.unmount()
})

test('once the token exists nothing is owed back, because it may already be theirs', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('give')
  await ui.type('\r')
  await ui.type('21')
  await ui.enter(4)

  t.ok(ui.screen().includes('cashuBtoken'), 'the token is out there')
  t.is(api.holding().length, 0, 'so the session has nothing it can simply hand back')

  ui.app.unmount()
})

test('enter in a field moves on; only the button acts', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('deposit')
  await ui.type('100')
  await ui.type('\t')
  await ui.type('https://mint.example')
  await ui.type('\x1b[A') // back to the amount, so the walk below starts where it did

  // Three fields and a button. Enter walks them without asking anything of the mint.
  for (let i = 0; i < 3; i++) {
    await ui.type('\r')
    t.absent(
      api.calls.some(([name]) => name === 'deposit'),
      `enter ${i + 1} moved on rather than depositing`
    )
  }
  t.ok(ui.screen().includes('Enter asks the mint for an invoice'), 'the button has the keyboard')

  await ui.type('\r')
  t.ok(
    api.calls.some(([name]) => name === 'deposit'),
    'and the press on the button is what deposits'
  )

  ui.app.unmount()
})

test('enter stops on the button rather than wrapping back to the first field', async (t) => {
  const ui = mount(fakeApi())
  await ui.flush()

  await ui.pick('deposit')
  await ui.enter(3) // onto the button
  t.ok(ui.screen().includes('an amount is needed'), 'nothing was filled in, so it is not ready')

  // Held down past the end, it stays put: landing back in the first field would read as
  // the form having rejected something.
  await ui.enter(3)
  t.ok(ui.screen().includes('an amount is needed'), 'still on the button, still refusing')

  // Arrows do wrap, because that is what a list of slots is for.
  await ui.type('\x1b[B')
  await ui.type('100')
  t.ok(ui.screen().includes('100'), 'down from the button comes back round to the amount')

  ui.app.unmount()
})

test('the button will not act until the form is ready', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('withdraw')
  await ui.enter(2) // onto the button with no invoice typed
  await ui.type('\r')
  t.absent(
    api.calls.some(([name]) => name === 'planWithdraw'),
    'an empty invoice is not quoted'
  )

  await ui.type('\x1b[B') // down from the button wraps round to the invoice field
  await ui.type('lnbc1test')
  await ui.enter(3)
  t.ok(
    api.calls.some(([name]) => name === 'planWithdraw'),
    'and it is once there is one'
  )

  ui.app.unmount()
})

test('settings shows where this session runs and what it wears', async (t) => {
  const ui = mount(fakeApi(), { columns: 100 })
  await ui.flush()

  t.ok(ui.screen().includes('ephemeral'), 'the address mode is in the top bar from the start')
  t.ok(
    ui.screen().includes('via socks5://127.0.0.1:1080'),
    'and so is the proxy the traffic goes through'
  )

  await ui.pick('settings')
  const screen = ui.screen()
  t.ok(screen.includes('/tmp/bare'), 'the binary that is running')
  t.ok(screen.includes('/tmp/wallet'), 'the storage this run uses')
  t.ok(screen.includes('/tmp/wallet/wallet.json'), 'and the file in it that is the wallet')
  t.ok(screen.includes('the seed is inside this file'), 'said so nobody hunts for a seed file')
  t.ok(screen.includes('socks5://127.0.0.1:1080'), 'the proxy in force')
  t.ok(screen.includes('from ALL_PROXY'), 'and where it came from')
  t.ok(screen.includes('en0'), 'the interface the hyperdht is pinned to')

  ui.app.unmount()
})

test('with no proxy the top bar says nothing about one', async (t) => {
  const ui = mount(fakeApi({ proxy: () => null }), { columns: 100 })
  await ui.flush()

  t.absent(ui.screen().includes('via '), 'nothing is claimed about a wire that is direct')

  ui.app.unmount()
})

test('the address mode is switched here and the whole app follows', async (t) => {
  const api = fakeApi()
  const ui = mount(api, { columns: 100 })
  await ui.flush()

  await ui.pick('settings')
  t.ok(ui.screen().includes('a new key every run, on every wire'), 'ephemeral says what it means')
  t.ok(
    ui.screen().includes('Enter switches to stable'),
    'and the row says what enter does and what it would become'
  )
  t.absent(
    ui.screen().includes('anyone scanning the room'),
    'and costs nothing worth warning about'
  )

  await ui.type('\r')
  t.is(api.addressMode(), 'stable', 'enter switches it')
  t.ok(ui.screen().includes('the same on every wire'), 'and says what that means')
  t.ok(ui.screen().includes('Enter switches to ephemeral'), 'the row now offers the way back')

  // The cost is not the same on each wire, so it is said once per wire rather than once.
  const screen = ui.screen()
  t.ok(screen.includes('announced to the world'), 'the hyperdht cost is spelled out')
  t.ok(screen.includes('anyone scanning the room'), 'and the bluetooth one')
  t.ok(screen.includes('multicast query'), 'and the local network one')

  // The top bar is the point of it being global: it is true of every screen, not this one.
  await ui.type('\x1b')
  const top = ui.screen().split('\n')[0]
  t.ok(top.includes('stable'), 'the top bar carries it back to the menu')
  t.absent(top.includes('ephemeral'), 'and no longer says otherwise')

  await ui.pick('settings')
  await ui.type('\r')
  t.is(api.addressMode(), 'ephemeral', 'and it switches back')

  ui.app.unmount()
})

test('only the setting that can move is the one enter acts on', async (t) => {
  const api = fakeApi()
  const ui = mount(api, { columns: 100 })
  await ui.flush()

  await ui.pick('settings')
  await ui.type('\x1b[B') // down to binary, which is not a choice anybody can make here
  t.absent(ui.screen().includes('Enter to switch address'), 'the hint line offers no key here')
  t.ok(
    ui.screen().includes('Enter switches to stable'),
    'while the address row keeps saying it is the one that moves'
  )

  await ui.type('\r')
  t.is(api.addressMode(), 'ephemeral', 'and enter on it changes nothing')

  ui.app.unmount()
})

test('a token that wraps can be dragged out with a mouse, and copied with a key', async (t) => {
  const long = fakeApi().longToken
  const api = fakeApi({
    executeGive: () => Promise.resolve({ operation: { id: 'op1' }, token: long }),
    awaitClaim: () => new Promise(() => {}) // stays waiting, which is when it is copied
  })
  const ui = mount(api, { columns: 76, rows: 40 })
  await ui.flush()

  await ui.pick('give')
  await ui.type('\r') // hand over
  await ui.type('21')
  await ui.enter(4) // past the mint and unit fields, onto the button, then press it

  const lines = ui.screen().split('\n')
  const first = lines.findIndex((line) => line.includes('cashuB'))
  t.ok(first > 0, 'the token is on screen')

  const body = []
  for (let i = first; i < lines.length && /^[a-zA-Z0-9]+$/.test(lines[i]); i++) {
    body.push(lines[i])
  }
  t.ok(body.length > 1, 'and it wraps onto more than one line')
  t.absent(
    body.some((line) => line.includes('│')),
    'no line of it has a box side on it'
  )
  t.is(body.join(''), long, 'the lines put back together are exactly the token')

  await ui.type('c')
  t.is(api.calls.find(([name]) => name === 'copy')?.[1], long, 'and c copies the whole of it')
  t.ok(ui.screen().includes('copied to the clipboard'), 'saying so on the rule above it')

  ui.app.unmount()
})

test('Q and Ctrl-C leave the same way, and Ctrl-C leaves from anywhere', async (t) => {
  for (const [key, what] of [
    ['q', 'Q'],
    ['\x03', 'Ctrl-C'],
    ['Q', 'shift-Q']
  ]) {
    const ui = mount(fakeApi())
    await ui.flush()
    await ui.type(key)
    await ui.app.waitUntilExit()
    t.is(ui.stdin.raw, false, `${what} hands the terminal back`)
  }

  // Q is the menu's, because everywhere else it is a character somebody may be typing.
  // Ctrl-C is the session's, and has to work wherever the keyboard happens to be.
  for (const [name, keys] of [
    ['the settings screen', ['\r']],
    ['a form', ['\x1b[B', '\r']],
    // A modal takes the keyboard, which is its job — but not the way out of the session.
    [
      'the withdraw confirmation',
      ['\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\r', 'lnbc1t', '\r', '\r', '\r']
    ]
  ]) {
    const api = fakeApi()
    const ui = mount(api)
    await ui.flush()
    for (const key of keys) await ui.type(key)
    await ui.type('\x03')
    await ui.app.waitUntilExit()
    t.is(ui.stdin.raw, false, `Ctrl-C ends the session from ${name}`)
    t.absent(
      api.calls.some(([called]) => called === 'settleWithdraw'),
      `and spends nothing on the way out of ${name}`
    )
  }
})

test('the menu shows the total and nothing about which mint it is at', async (t) => {
  const ui = mount(fakeApi(), { columns: 96 })
  await ui.flush()

  t.ok(ui.screen().includes('8000 sat'), 'the total is on the menu')
  t.absent(ui.screen().includes('mint.example'), 'no mint is named there')
  t.ok(ui.screen().includes('what each holds'), 'and the detail is an action away')

  ui.app.unmount()
})

test('the mints screen says what each mint holds, and in what', async (t) => {
  const api = fakeApi()
  const ui = mount(api, { columns: 96 })
  await ui.flush()

  await ui.pick('mints')
  const screen = ui.screen()

  t.ok(screen.includes('mints (2)'), 'both mints are counted')
  t.ok(screen.includes('https://mint.example'), 'and named')
  t.ok(screen.includes('8000 sat'), 'with what each is worth')
  t.ok(screen.includes('137 sat'), 'including the smaller one')

  // The part a balance cannot answer: what the money is made of.
  t.ok(screen.includes('3 proofs'), 'how many proofs the first holds')
  t.ok(screen.includes('4096  2048  8×2'), 'and in which denominations, biggest first')
  t.ok(screen.includes('1×9'), 'a repeated denomination is counted rather than repeated')

  // Reserved proofs are a count and an amount, and they are two different numbers.
  t.ok(screen.includes('sat · 5 proofs'), 'the second mint is counted too')
  t.ok(screen.includes('2 reserved'), 'with the proofs an operation is holding')
  t.ok(screen.includes('21 sat'), 'and what they come to')

  // The second mint issues two units, so it holds two of everything: two balances, two
  // proof counts and two sets of denominations, none of which are summed across.
  t.ok(screen.includes('137 sat  12 usd'), 'a mint with two units is worth both')
  t.ok(screen.includes('usd · 2 proofs'), 'its units are counted apart, and named')
  t.ok(screen.includes('8  4'), 'and each carries its own denominations')
  t.absent(screen.includes('7 proofs'), 'proofs are never pooled across units')

  // And the mint issuing one unit says so plainly — a label would be noise.
  t.ok(screen.includes('  3 proofs'), 'a single-unit mint is not labelled')

  await ui.type('\x1b')
  t.ok(ui.screen().includes('what each holds'), 'escape comes back to the menu')

  ui.app.unmount()
})

// A wallet with one of each, which is what the trust rows are about.
function mintList() {
  return [
    {
      mintUrl: 'https://mint.example',
      trusted: true,
      units: [
        {
          unit: 'sat',
          spendable: 8000,
          reserved: 0,
          proofs: 3,
          reservedProofs: 0,
          denominations: [{ amount: 4096, count: 1 }]
        }
      ]
    },
    { mintUrl: 'https://quarantined.example', trusted: false, units: [] }
  ]
}

test('the mints screen says which mints are trusted, and what untrusted costs', async (t) => {
  const ui = mount(fakeApi({ mints: () => Promise.resolve(mintList()) }), { columns: 96 })
  await ui.flush()

  await ui.pick('mints')
  const screen = ui.screen()
  t.ok(screen.includes('trusted'), 'a trusted mint says so')
  t.ok(
    screen.includes('nothing here can be spent until it is trusted again'),
    'and an untrusted one says what that means rather than just naming itself'
  )
  // A mint holding nothing is still on the list: untrusted, or trusted by name and never
  // used, it is still something to see and act on.
  t.ok(screen.includes('quarantined.example'), 'a mint with no ecash at it is still listed')

  ui.app.unmount()
})

test('A adds a mint by url, and the list picks it up', async (t) => {
  const api = fakeApi({ mints: () => Promise.resolve(mintList()) })
  const ui = mount(api, { columns: 96 })
  await ui.flush()

  await ui.pick('mints')
  await ui.type('a')
  t.ok(ui.screen().includes('Enter trusts it'), 'A opens a field to type one into')
  t.ok(ui.screen().includes('mint.example'), 'and the list stays visible behind it')

  await ui.type('https://new.example')
  await ui.type('\r')
  await ui.flush(6)

  t.is(
    api.calls.find(([name]) => name === 'trustMint')?.[1],
    'https://new.example',
    'enter trusts what was typed'
  )
  t.absent(ui.screen().includes('Enter trusts it'), 'and the field closes once it worked')

  ui.app.unmount()
})

test('the add field owns the keyboard, since a url is full of letters that do things', async (t) => {
  const api = fakeApi({ mints: () => Promise.resolve(mintList()) })
  const ui = mount(api, { columns: 96 })
  await ui.flush()

  await ui.pick('mints')
  await ui.type('a')
  // r reads the list again and t toggles trust — both are in `https://retest.example`, and
  // a field that let them through would be impossible to type a url into.
  await ui.type('https://retest.example')

  t.ok(ui.screen().includes('https://retest.example'), 'every character reaches the field')
  t.absent(
    api.calls.some(([name]) => name === 'untrustMint' || name === 'trustMint'),
    'and none of them acted on the mint under the cursor'
  )

  await ui.type('\x1b')
  t.absent(ui.screen().includes('Enter trusts it'), 'escape closes it')
  t.absent(
    api.calls.some(([name]) => name === 'trustMint'),
    'and nothing was trusted on the way out'
  )

  ui.app.unmount()
})

test('a url that is not a mint keeps the field open to be corrected', async (t) => {
  // Trusting reaches the mint, so this is where a typo is found out. Clearing the field on
  // failure would mean typing the whole url again to fix one character of it.
  const api = fakeApi({
    mints: () => Promise.resolve(mintList()),
    trustMint: () => Promise.reject(new Error('could not reach it'))
  })
  const ui = mount(api, { columns: 96 })
  await ui.flush()

  await ui.pick('mints')
  await ui.type('a')
  await ui.type('https://typo.example')
  await ui.type('\r')
  await ui.flush(6)

  t.ok(ui.screen().includes('could not reach it'), 'the failure is on screen')
  t.ok(ui.screen().includes('https://typo.example'), 'and what was typed is still there')

  ui.app.unmount()
})

test('T trusts a mint back without asking, since nothing is taken away by it', async (t) => {
  const api = fakeApi({ mints: () => Promise.resolve(mintList()) })
  const ui = mount(api, { columns: 96 })
  await ui.flush()

  await ui.pick('mints')
  await ui.type('\x1b[B') // onto the untrusted one
  await ui.type('t')
  await ui.flush(6)

  t.is(
    api.calls.find(([name]) => name === 'trustMint')?.[1],
    'https://quarantined.example',
    'T on an untrusted mint trusts it'
  )
  t.absent(ui.screen().includes('Untrust'), 'and asks nothing, because nothing is lost by it')

  ui.app.unmount()
})

test('untrusting a mint that holds something is asked about first', async (t) => {
  const api = fakeApi({ mints: () => Promise.resolve(mintList()) })
  const ui = mount(api, { columns: 96 })
  await ui.flush()

  await ui.pick('mints')
  await ui.type('t')

  t.ok(ui.screen().includes('Untrust https://mint.example?'), 'the question names the mint')
  t.ok(ui.screen().includes('8000 sat'), 'and what stops being spendable')
  t.absent(
    api.calls.some(([name]) => name === 'untrustMint'),
    'nothing has moved while the question stands'
  )

  await ui.type('n')
  await ui.flush(6)
  t.absent(
    api.calls.some(([name]) => name === 'untrustMint'),
    'and refusing leaves it trusted'
  )

  await ui.type('t')
  await ui.type('y')
  await ui.flush(6)
  t.is(
    api.calls.find(([name]) => name === 'untrustMint')?.[1],
    'https://mint.example',
    'accepting untrusts it'
  )

  ui.app.unmount()
})

test('untrusting a mint holding nothing needs no question', async (t) => {
  const empty = [{ mintUrl: 'https://empty.example', trusted: true, units: [] }]
  const api = fakeApi({ mints: () => Promise.resolve(empty) })
  const ui = mount(api, { columns: 96 })
  await ui.flush()

  await ui.pick('mints')
  await ui.type('t')
  await ui.flush(6)

  t.is(
    api.calls.find(([name]) => name === 'untrustMint')?.[1],
    'https://empty.example',
    'there is nothing to lose, so there is nothing to ask'
  )

  ui.app.unmount()
})

test('a wallet with nothing in it says so rather than showing an empty box', async (t) => {
  const api = fakeApi({ mints: () => Promise.resolve([]) })
  const ui = mount(api, { columns: 96 })
  await ui.flush()

  await ui.pick('mints')
  t.ok(ui.screen().includes('no mints yet'), 'the screen says there is nothing to show')

  ui.app.unmount()
})

test("the relay screen says whether the list is this wallet's or the built-in one", async (t) => {
  const ui = mount(fakeApi())
  await ui.flush()

  await ui.pick('relays')
  for (const url of BUILT_IN_RELAYS) t.ok(ui.screen().includes(url), `${url} is on the list`)
  t.ok(
    ui.screen().includes('the relays built into this binary'),
    'and the screen says nobody chose them'
  )

  ui.app.unmount()
})

test("A adds a relay, and the list becomes this wallet's own", async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('relays')
  await ui.type('a')
  // Typed rather than pressed: the letters of a relay url must not move the selection
  // about while the field is open.
  await ui.type('relay.example')
  t.absent(
    api.calls.some(([name]) => name === 'addRelay'),
    'nothing is written while typing'
  )

  await ui.type('\r')
  const call = api.calls.find(([name]) => name === 'addRelay')
  t.is(call[1], 'relay.example', 'enter adds what was typed')
  t.ok(ui.screen().includes('wss://relay.example'), 'and it appears on the list')
  t.ok(ui.screen().includes("this wallet's own list"), 'which is now this wallet’s own')

  ui.app.unmount()
})

test('X removes the selected relay, with nothing to confirm', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('relays')
  t.ok(ui.screen().includes(`relays (${BUILT_IN_RELAYS.length})`), 'the list is the built-in one')

  await ui.type('x')
  const call = api.calls.find(([name]) => name === 'removeRelay')
  t.is(call[1], BUILT_IN_RELAYS[0], 'the one the marker was on')
  t.ok(ui.screen().includes(`relays (${BUILT_IN_RELAYS.length - 1})`), 'and it is off the list')
  t.ok(ui.screen().includes(`removed ${BUILT_IN_RELAYS[0]}`), 'which the pane says, without asking')
  t.ok(ui.screen().includes(BUILT_IN_RELAYS[1]), 'the rest are still standing')

  ui.app.unmount()
})

test('B goes back to the built-in list, after asking', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('relays')
  t.absent(ui.screen().includes('built into this binary?'), 'nothing to discard yet, so no B')

  await ui.type('x') // now the list is this wallet's own
  await ui.type('b')
  t.ok(ui.screen().includes('built into this binary?'), 'B asks first')
  t.absent(
    api.calls.some(([name]) => name === 'resetRelays'),
    'and nothing moves while it asks'
  )

  await ui.type('n')
  t.absent(
    api.calls.some(([name]) => name === 'resetRelays'),
    'refusing keeps the list'
  )

  await ui.type('b')
  await ui.type('y')
  t.ok(
    api.calls.some(([name]) => name === 'resetRelays'),
    'accepting puts the built-in list back'
  )
  for (const url of BUILT_IN_RELAYS) t.ok(ui.screen().includes(url), `${url} is back`)

  ui.app.unmount()
})

test('the actions are in three groups, and the gaps are not selectable', async (t) => {
  const ui = mount(fakeApi(), { columns: 96 })
  await ui.flush()

  const chosen = () =>
    ui
      .screen()
      .split('\n')
      .find((line) => line.includes('\u203a'))

  // Nine actions, so nine downs come back to the top — the blank lines between the groups
  // are not stops on the way.
  t.ok(chosen().includes('settings'), 'starts on the first')
  for (let i = 0; i < ACTIONS.length; i++) await ui.type('\x1b[B')
  t.ok(chosen().includes('settings'), 'and wraps after exactly as many downs as there are actions')

  // The groups themselves: what the wallet is, what it can do, and who it can pay.
  const lines = ui.screen().split('\n')
  const rowOf = (label) =>
    lines.findIndex((line) => line.includes(`${label} `) && line.includes('│'))
  t.ok(rowOf('in flight') + 1 < rowOf('deposit'), 'a blank line separates the first two groups')
  t.ok(rowOf('withdraw') + 1 < rowOf('zap'), 'and the second from the third')

  ui.app.unmount()
})

test('zap quotes before it spends, and says whether there will be a receipt', async (t) => {
  const api = fakeApi()
  const ui = mount(api, { columns: 96 })
  await ui.flush()

  await ui.pick('zap')
  await ui.type('npub1someone')
  await ui.enter(1)
  await ui.type('21')
  await ui.enter(3) // past the comment field, onto the button, then press it

  t.is(api.calls.find(([name]) => name === 'planZap')?.[1].amount, 21, 'the amount is quoted')
  t.ok(ui.screen().includes('Zap 21 sat to npub1someone?'), 'and confirmation is asked for')
  t.ok(ui.screen().includes('you typed  npub1someone'), 'showing what was typed')
  t.ok(ui.screen().includes(`their key  ${'b'.repeat(64)}`), 'and who the lookup found')
  t.absent(
    api.calls.some(([name]) => name === 'settleZap'),
    'nothing is spent while the question stands'
  )

  await ui.type('y')
  t.ok(
    api.calls.some(([name]) => name === 'settleZap'),
    'Y pays it'
  )
  t.ok(ui.screen().includes('receipt'), 'and says the receipt is coming')

  ui.app.unmount()
})

test('a zap with no receipt says so before it is paid', async (t) => {
  const api = fakeApi({
    planZap: ({ amount }) => ({
      label: 'someone@example.com',
      amount,
      receipt: false,
      warnings: ['no nostr key there — this pays the lightning address, with no zap receipt'],
      melt: { payable: true, lines: ['Paying from https://mint.example'] }
    })
  })
  const ui = mount(api, { columns: 96 })
  await ui.flush()

  await ui.pick('zap')
  await ui.type('someone@example.com')
  await ui.enter(1)
  await ui.type('21')
  await ui.enter(3)

  t.ok(ui.screen().includes('no zap receipt'), 'the thing that makes it a zap is missing, and said')

  ui.app.unmount()
})

test('a nutzap reserves proofs, and refusing hands them back', async (t) => {
  const api = fakeApi()
  const ui = mount(api, { columns: 96 })
  await ui.flush()

  await ui.pick('nutzap')
  await ui.type('npub1someone')
  await ui.enter(1)
  await ui.type('21')
  await ui.enter(4) // past mint and comment, onto the button, then press it

  t.ok(
    api.calls.some(([name]) => name === 'planNutzap'),
    'they are looked up first'
  )

  // The lookup is the half that could have gone somewhere unexpected, so the confirmation
  // shows what it decided before it asks — who they turned out to be, and which key the
  // ecash gets locked to, neither of which was typed.
  const asked = ui.screen()
  t.ok(asked.includes('you typed  npub1someone'), 'what was typed is repeated back')
  t.ok(asked.includes(`their key  ${'a'.repeat(64)}`), 'with the key it resolved to')
  t.ok(asked.includes(`locked to  02${'a'.repeat(64)}`), 'and the key the ecash is locked to')
  t.ok(asked.includes('cannot be reclaimed'), 'and the one-way door is named before it opens')
  t.absent(
    api.calls.some(([name]) => name === 'settleNutzap'),
    'nothing is published while the question stands'
  )

  await ui.type('n')
  t.ok(
    api.calls.some(([name]) => name === 'cancelNutzap'),
    'refusing gives the reserved proofs back rather than just closing the question'
  )
  t.absent(
    api.calls.some(([name]) => name === 'settleNutzap'),
    'and publishes nothing'
  )

  ui.app.unmount()
})

test('a nutzap no relay accepted is not reported as a send that can be retried', async (t) => {
  const api = fakeApi({
    settleNutzap: () => ({ accepted: 0, results: [{ ok: false }], event: { id: 'e1' } })
  })
  const ui = mount(api, { columns: 96 })
  await ui.flush()

  await ui.pick('nutzap')
  await ui.type('npub1someone')
  await ui.enter(1)
  await ui.type('21')
  await ui.enter(4)
  await ui.type('y')

  t.ok(ui.screen().includes('no relay accepted'), 'the screen says nothing carried it')
  t.ok(ui.screen().includes('cannot be reclaimed'), 'and that the ecash is gone all the same')

  ui.app.unmount()
})

test('escape leaves the menu on the action it just came out of', async (t) => {
  const ui = mount(fakeApi(), { columns: 96 })
  await ui.flush()

  const chosen = () =>
    ui
      .screen()
      .split('\n')
      .find((line) => line.includes('\u203a'))

  // Not just the first one: an action from each group, since the gaps between them are
  // where an index and a row number stop agreeing.
  for (const action of ['mints', 'withdraw', 'nutzap']) {
    await ui.pick(action)
    await ui.type('\x1b')
    t.ok(chosen().includes(action), `coming back from ${action} leaves the marker on it`)
  }

  // And it is a starting point, not a lock — the arrows still move from there.
  await ui.type('\x1b[A')
  t.absent(
    chosen().includes('nutzap'),
    'the remembered row is where the keyboard starts, not where it stays'
  )

  ui.app.unmount()
})

test('a confirmation and its answer keys fit on a short terminal', async (t) => {
  // The question is the whole point of these two screens, and it is the last thing drawn —
  // so it is the first thing a terminal too short for everything cuts off.
  for (const [action, keys] of [
    ['withdraw', ['lnbc1test', '\r', '\r', '\r']],
    ['zap', ['npub1someone', '\r', '21', '\r', '\r', '\r']],
    ['nutzap', ['npub1someone', '\r', '21', '\r', '\r', '\r', '\r']],
    // The trust question has the most to lose by being cut off: it is the one that decides
    // whether a stranger's mint goes into this wallet for good.
    ['get', ['\r', 'cashuBfromastranger', '\r', '\r']]
  ]) {
    for (const rows of [24, 30, 40]) {
      const ui = mount(fakeApi(), { columns: 96, rows })
      await ui.flush()
      await ui.pick(action)
      for (const key of keys) await ui.type(key)

      const screen = ui.screen()
      t.ok(
        screen.includes('Y to accept'),
        `${action} at ${rows} rows: the way to say yes is on screen`
      )
      t.ok(screen.includes('N to refuse'), `${action} at ${rows} rows: and the way to say no`)
      t.ok(
        screen.includes('?'),
        `${action} at ${rows} rows: and the question those answer is on screen too`
      )

      ui.app.unmount()
    }
  }
})

test('what the wallet says about itself lands in the log, not over the layout', async (t) => {
  const { note } = await import('../lib/notes.mjs')
  const ui = mount(fakeApi())
  await ui.flush()

  note('reclaimed 5 sat reserved by a send that never happened')
  await ui.flush()

  const screen = ui.screen()
  t.ok(screen.includes('reclaimed 5 sat'), 'the line is on screen')
  const lines = screen.split('\n')
  const at = lines.findIndex((line) => line.includes('reclaimed 5 sat'))
  t.ok(lines[at].includes('│'), 'inside the log pane, not written across it')

  ui.app.unmount()
  note('after the ui is gone')
  t.pass('and note() goes back to stderr once the session ends')
})

test('the layout survives a terminal being resized under it', async (t) => {
  const ui = mount(fakeApi(), { columns: 100, rows: 30 })
  await ui.flush()

  ui.stdout.resize(48, 14)
  await ui.flush()

  const lines = ui.stdout.frames().pop()
  t.ok(
    lines.every((line) => line.length <= 48),
    'nothing is wider than the terminal now is'
  )
  t.ok(ui.screen().includes('8000 sat'), 'and the wallet is still on screen')

  ui.app.unmount()
})

test('a screen that throws hands the error back rather than closing quietly', async (t) => {
  const stdout = new FakeStdout({ columns: 80, rows: 24 })
  const stdin = new FakeStdin()
  const boom = new Error('the screen fell over')
  function Broken() {
    throw boom
  }

  // `cashme ui` reports whatever the session ended with, so an error that ends it has to
  // be the value it ends with — unmounting first and reporting after resolved with nothing
  // and lost it on the way out.
  const app = render(h(Broken), { stdout, stdin })
  const result = await app.waitUntilExit()
  t.is(result, boom, 'the error is what the session resolves with')
  t.ok(
    stdout.writes.join('').includes('\x1b[?1049l'),
    'and the terminal is put back on the way out'
  )
})

test('the frame stops one cell short of the terminal in both directions', async (t) => {
  // The last row scrolls some terminals on the alternate screen, and the last column is
  // both where a pending wrap lives and where an overlay scrollbar sits — which for this
  // UI would hide every box's right border and the last digit of the balance.
  for (const [columns, rows] of [
    [105, 29],
    [80, 24],
    [60, 20]
  ]) {
    const ui = mount(fakeApi(), { columns, rows })
    await ui.flush()

    const painted = ui.stdout.writes.filter((chunk) => chunk.startsWith('\x1b[H')).pop()
    const lines = painted
      .replace(/\x1b\[H/, '')
      .replace(/\x1b\[J$/, '')
      .split('\r\n')
      .map((line) => strip(line.replace(/\x1b\[K$/, '')))

    t.ok(lines.length <= rows - 1, `${columns}x${rows}: no more rows than the frame allows`)
    t.ok(
      lines.every((line) => line.length <= columns - 1),
      `${columns}x${rows}: no line reaches the last column`
    )
    // And the border really is the last thing on a box line, not cut off it.
    const top = lines.find((line) => line.startsWith('╭'))
    t.ok(top.endsWith('╮'), `${columns}x${rows}: the top border closes`)
    t.ok(
      lines.filter((line) => line.startsWith('│')).every((line) => line.endsWith('│')),
      `${columns}x${rows}: and every side of it is there`
    )

    ui.app.unmount()
  }
})
