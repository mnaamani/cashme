// Giving and getting over the local network, driven through the CLI a user actually types.
//
// Nothing in this transport leaves the machine's own LAN, so unlike the hyperdht tests
// there is no third party involved in finding each other — the two runs discover one
// another over loopback and the interfaces this machine happens to have. What still needs
// the network is the mint: claiming a token is a swap, so these are skipped by
// CASHME_TEST_OFFLINE=1 along with the rest of the spending tests.
import '../../lib/polyfills.mjs'
import test from 'brittle'
import { cli, session, walletdir, satsIn, MINT, OFFLINE } from './helpers.mjs'

const opts = { skip: OFFLINE, timeout: 300000 }

const KEY = /our public key: ([0-9a-f]{64})/

// Start a listener and read the key off it. It stays up — the caller either pays it or
// leaves it to the teardown.
//
// --mint is what makes an unattended receive possible: these wallets are fresh, so the mint
// the incoming token names is one they have never used, and with no terminal to ask on
// `get` refuses it rather than trusting whoever paid it (see lib/cli/get.mjs).
async function listening(t, dir) {
  const run = session(t, dir, ['get', '--lan', '--mint', MINT])
  const output = await run.waitFor(KEY)
  run.key = KEY.exec(output)[1]
  return run
}

test('get --lan listens on a key belonging to that run alone', opts, async (t) => {
  const dir = walletdir(t)

  const first = await listening(t, dir)
  t.ok(/waiting for tokens on the local network/.test(first.output), 'and says which wire')
  first.kill()

  // Same wallet, same seed, second run: nothing on this transport is derived from either,
  // which is the property this exists to catch a regression in.
  const second = await listening(t, dir)
  t.not(second.key, first.key, 'the next run announces a different one')
  second.kill()
})

test('ecash crosses the local network to the key the receiver printed', opts, async (t) => {
  const sender = walletdir(t)
  const receiver = walletdir(t)
  await cli(sender, ['deposit', '--amount', '200', '--mint', MINT])

  const listener = await listening(t, receiver)

  // A prefix, not the whole key: the beacon carries the full key and the handshake proves
  // it, so — as on bluetooth and unlike the DHT — enough to be unambiguous is enough to
  // type.
  const prefix = listener.key.slice(0, 12)
  const give = await cli(sender, ['give', '--lan', '--public-key', prefix, '--amount', '21'])
  t.is(
    give.code,
    0,
    `\`cashme give --lan\` finds the peer and hands the token over${give.code === 0 ? '' : `. Output:\n${give.output}`}`
  )
  t.ok(/looking for .* on the local network/.test(give.output), 'over the LAN and nothing else')

  await listener.waitFor(/New Balance/)
  t.ok(/receiving 21 sat/.test(listener.output), 'the receiver claims it')
  // Claiming swaps at the mint, which charges its input fee — so what lands is the 21 sat
  // less that, never more.
  const claimed = satsIn(listener.output, 'New Balance')
  t.ok(claimed <= 21 && claimed >= 20, `and the amount lands in its balance (${claimed} sat)`)

  // The token was acknowledged, so the send settles rather than staying outstanding.
  listener.kill()
  const pending = await cli(sender, ['pending'])
  t.ok(/No sends waiting to settle/.test(pending.output), 'nothing is left pending')
})

test('a key from another run is reported rather than silently waited on', opts, async (t) => {
  const sender = walletdir(t)
  // Funded, or the run stops on the balance before it reaches a wire at all — the reserved
  // proofs are what make this the interesting case: they are handed back when the run is
  // stopped without a peer.
  await cli(sender, ['deposit', '--amount', '200', '--mint', MINT])
  const listener = await listening(t, walletdir(t))

  // The listener is up and answering, but under a different key — the shape of a
  // `--public-key` copied from an earlier `cashme get`. Nothing is spent here: the run
  // never finds its peer, so it is stopped once it has said so.
  const wrong = 'ff'.repeat(4)
  const give = await cli(sender, ['give', '--lan', '--public-key', wrong, '--amount', '21'], {
    until: /not the neighbour we are looking for/
  })
  t.ok(/not the neighbour we are looking for/.test(give.output))
  t.ok(give.output.includes(listener.key), 'naming the wallet that did answer')
  listener.kill()
})

// The receiver prints the key the sender was given, so by the time `give` runs it was
// listening moments ago — which is what makes silence worth reporting rather than waiting
// through. The two ways it goes quiet are fixed differently, so they are told apart.
test('a search that finds nobody gives up and says what to check', opts, async (t) => {
  const sender = walletdir(t)
  await cli(sender, ['deposit', '--amount', '200', '--mint', MINT])

  // Nothing listening at all: the shape of two people on networks that do not carry
  // multicast between them.
  const alone = await cli(sender, ['give', '--lan', '-k', 'ab', '-a', '21'], { timeout: 120000 })
  t.not(alone.code, 0)
  t.ok(/nobody answered on the local network within 30s/.test(alone.output))
  t.ok(/same network/.test(alone.output) && /guest wi-fi/.test(alone.output), 'naming the causes')
  t.ok(/--dht/.test(alone.output), 'and the wire that does not care about any of them')
  // The proofs were reserved before the search — a give that finds nobody must hand them
  // back, or the amount is missing from the balance until a later run sweeps it.
  const pending = await cli(sender, ['pending'])
  t.ok(/No sends waiting to settle/.test(pending.output), 'and the reserved proofs come back')

  // Something is listening, so the network is fine and the key is the problem instead.
  const listener = await listening(t, walletdir(t))
  const stale = await cli(sender, ['give', '--lan', '-k', 'ab', '-a', '21'], { timeout: 120000 })
  t.not(stale.code, 0)
  t.ok(/no wallet matching ab answered within 30s/.test(stale.output))
  t.ok(/prints a new key every run/.test(stale.output), 'pointing at the key, not the network')
  listener.kill()
})

test('--lan and --dht together are refused rather than one quietly winning', opts, async (t) => {
  // No network in this one: it never gets as far as a wire.
  const run = await cli(walletdir(t), ['get', '--lan', '--dht'], { timeout: 60000 })
  t.ok(/two different wires/.test(run.output))
  t.not(run.code, 0)
})
