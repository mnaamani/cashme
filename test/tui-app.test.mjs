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
    prepareGive: record('prepareGive', { mintUrl: 'https://mint.example', prepared: {}, fee: 0 }),
    executeGive: record('executeGive', { operation: { id: 'op1' }, token: 'cashuBtoken' }),
    cancelGive: record('cancelGive'),
    finalizeGive: record('finalizeGive'),
    reclaim: record('reclaim'),
    awaitClaim: record('awaitClaim', true),
    reach: record('reach', () => () => Promise.resolve(true)),
    inspect: (token) => ({ amount: 21, unit: 'sat', mintUrl: 'https://stranger.example', token }),
    trusted: record('trusted', false),
    trust: record('trust'),
    claim: record('claim'),
    listen: record('listen'),
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
    ...overrides
  }
}

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
  return { app, stdout, stdin, flush, type, screen: () => stdout.screen() }
}

test('the dashboard shows what the wallet holds', async (t) => {
  const ui = mount(fakeApi())
  await ui.flush()

  t.ok(ui.screen().includes('https://mint.example'), 'the mint is named')
  t.ok(ui.screen().includes('8000 sat'), 'and what it holds')
  t.ok(ui.screen().includes('nothing waiting to settle'), 'in flight says so when nothing is')
  t.ok(ui.screen().includes('d deposit'), 'the keys are on screen')

  await ui.type('q')
  t.ok(await ui.app.waitUntilExit().then(() => true), 'q ends the session')
  t.is(ui.stdin.raw, false, 'and the terminal is handed back')
})

test('deposit puts the invoice on screen while the mint is still waiting to be paid', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.type('d')
  t.ok(ui.screen().includes('deposit'), 'd opens the deposit screen')

  await ui.type('100')
  await ui.type('\r')

  t.ok(ui.screen().includes('lnbc1invoice'), 'the invoice appears')
  t.ok(ui.screen().includes('pay this invoice'), 'in the pane that says to pay it')
  const call = api.calls.find(([name]) => name === 'deposit')
  t.is(call[1].amount, 100, 'and the amount typed is the amount asked for')

  ui.app.unmount()
})

test('a token from an unknown mint is not claimed until the question is answered', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.type('r')
  await ui.type('cashuBtoken')
  await ui.type('\r')

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

  await ui.type('r')
  await ui.type('cashuBtoken')
  await ui.type('\r')
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

test('withdraw quotes before it spends, and spends only once confirmed', async (t) => {
  const api = fakeApi()
  const ui = mount(api)
  await ui.flush()

  await ui.type('w')
  await ui.type('lnbc1test')
  await ui.type('\r')

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

  await ui.type('g')
  t.ok(ui.screen().includes('hand over'), 'the ways to give are listed')
  await ui.type('21')
  await ui.type('\r')

  t.ok(ui.screen().includes('cashuBtoken'), 'the token is on screen')
  t.ok(
    api.calls.some(([name]) => name === 'awaitClaim'),
    'and the mint is polled for whether it was claimed'
  )

  ui.app.unmount()
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
