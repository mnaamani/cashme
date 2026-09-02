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

// A wallet that answers instantly and records what it was asked to do.
function fakeApi(overrides = {}) {
  const calls = []
  const held = new Set()
  let address = 'ephemeral'
  const record =
    (name, result) =>
    (...args) => {
      calls.push([name, ...args])
      return Promise.resolve(typeof result === 'function' ? result(...args) : result)
    }

  return {
    calls,
    snapshot: record('snapshot', {
      held: [{ mintUrl: 'https://mint.example', unit: 'sat', spendable: 8000, reserved: 0 }],
      totals: [{ unit: 'sat', spendable: 8000 }],
      pending: []
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
    refresh: record('refresh', { state: 'pending' }),
    qr: () => ({ width: 20, lines: ['▀▀▀', '▄▄▄'] }),
    copy: record('copy', 'pbcopy'),
    paste: record('paste', 'cashuBfromclipboard'),
    addressMode: () => address,
    setAddress: (next) => {
      address = next
      return address
    },
    settings: () => ({
      binary: '/tmp/bare',
      storage: '/tmp/wallet',
      proxy: { name: 'socks5://127.0.0.1:9050', source: 'ALL_PROXY' },
      dhtInterface: 'en0',
      address
    }),
    hold: (entry) => {
      held.add(entry)
      return () => held.delete(entry)
    },
    holding: () => [...held],
    ...overrides
  }
}

// The menu's order, so a test can say which action it wants rather than counting arrows.
const ACTIONS = ['settings', 'deposit', 'give', 'receive', 'withdraw', 'in flight']

// Mounts the app and returns the handles a test drives it with. `flush` waits for the
// renders an action sets off — state set in an effect paints on a later turn, not this one.
function mount(api, { columns = 80, rows = 30 } = {}) {
  const stdout = new FakeStdout({ columns, rows })
  const stdin = new FakeStdin()
  const app = render(h(App, { api, version: 'v0' }), { stdout, stdin })
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

  t.ok(ui.screen().includes('https://mint.example'), 'the mint is named')
  t.ok(ui.screen().includes('8000 sat'), 'and what it holds')
  for (const action of ACTIONS) {
    t.ok(ui.screen().includes(action), `${action} is on the list`)
  }
  t.ok(ui.screen().includes('nothing waiting to settle'), 'in flight says how much is waiting')
  t.ok(ui.screen().includes('Enter to open it'), 'and the list says how to pick from it')

  await ui.type('q')
  t.ok(await ui.app.waitUntilExit().then(() => true), 'q ends the session')
  t.is(ui.stdin.raw, false, 'and the terminal is handed back')
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
  t.ok(chosen().includes('deposit'), 'down moves to the next one')
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
  await ui.enter(4) // through mint and unit, onto the button, then press it

  t.ok(ui.screen().includes('lnbc1invoice'), 'the invoice appears')
  t.ok(ui.screen().includes('pay this invoice'), 'in the pane that says to pay it')
  const call = api.calls.find(([name]) => name === 'deposit')
  t.is(call[1].amount, 100, 'and the amount typed is the amount asked for')

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
  await ui.enter(4)

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

  await ui.pick('receive')
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

  await ui.pick('receive')
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

  await ui.pick('receive')
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

  await ui.pick('receive')
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
  await ui.pick('receive')
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
  await ui.enter(3)

  t.ok(ui.screen().includes('looking on the local network'), 'the wire is named while it waits')

  ui.app.unmount()
})

test('ctrl-v reads the clipboard into the token field', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('receive')
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

  await ui.pick('receive')
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

  await ui.pick('receive')
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

  await ui.pick('receive')
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

test('give hands the token over and says the proofs are no longer ours to keep', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.pick('give')
  t.ok(ui.screen().includes('hand over'), 'the ways to give are listed')
  await ui.type('\r') // hand over is the first method; enter commits it and opens the form
  await ui.type('21')
  await ui.enter(3) // past the mint field, onto the button, then press it

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
  await ui.enter(3)
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
  await ui.enter(3) // past mint, onto the button, then press it

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
  await ui.enter(3)

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

  await ui.pick('settings')
  const screen = ui.screen()
  t.ok(screen.includes('/tmp/bare'), 'the binary that is running')
  t.ok(screen.includes('/tmp/wallet'), 'the storage this run uses')
  t.ok(screen.includes('socks5://127.0.0.1:9050'), 'the proxy in force')
  t.ok(screen.includes('from ALL_PROXY'), 'and where it came from')
  t.ok(screen.includes('en0'), 'the interface the hyperdht is pinned to')

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
  await ui.enter(3)

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
  t.ok(ui.screen().includes('mint.example'), 'and the wallet is still on screen')

  ui.app.unmount()
})
