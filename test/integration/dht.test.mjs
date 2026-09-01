// Giving and getting over the hyperdht, driven through the CLI a user actually types.
//
// The address a run listens on is the whole difference between the two flavours of `--dht`,
// and it is a decision with no undo: a key announced on a public DHT is a lasting public
// identifier for the wallet, so a run that hands one out when it was not asked to cannot
// take it back. What is checked here is which key each command actually announces — that
// the default is a fresh one every run, and that `--stable` is the wallet's own — and that
// a token still crosses the wire either way.
//
// This talks to the real hyperdht: there is no bootstrap to point at a testnet from the
// CLI, so the runs punch the way a user's do. CASHME_TEST_OFFLINE=1 skips them along with
// the mint tests.
import '../../lib/polyfills.mjs'
import test from 'brittle'
import { cli, session, walletdir, satsIn, MINT, OFFLINE } from './helpers.mjs'

const opts = { skip: OFFLINE, timeout: 300000 }

const KEY = /our public key: ([0-9a-f]{64})/

// Start a listener and read the address off it. It stays up — the caller either pays it or
// leaves it to the teardown.
//
// --mint is what makes an unattended receive possible: these wallets are fresh, so the mint
// the incoming token names is one they have never used, and with no terminal to ask on
// `get` refuses it rather than trusting whoever paid it (see lib/cli/get.mjs). Naming the
// mint here is the same decision a user makes by typing it.
async function listening(t, dir, flags = []) {
  const run = session(t, dir, ['get', '--dht', '--mint', MINT, ...flags])
  const output = await run.waitFor(KEY)
  run.key = KEY.exec(output)[1]
  return run
}

test('get --dht listens on a key belonging to that run alone', opts, async (t) => {
  const dir = walletdir(t)

  const first = await listening(t, dir)
  t.ok(
    /this key is for this run only/.test(first.output),
    'and says so, because the sender needs it now or not at all'
  )
  first.kill()

  // Same wallet, same seed, second run: a key derived from the wallet would repeat here,
  // which is the failure this exists to catch.
  const second = await listening(t, dir)
  t.not(second.key, first.key, 'the next run announces a different one')
  second.kill()
})

test(
  "get --dht --stable listens on the wallet's own address, unchanged between runs",
  opts,
  async (t) => {
    const dir = walletdir(t)

    const first = await listening(t, dir, ['--stable'])
    t.ok(
      /this key is this wallet's address, the same every run/.test(first.output),
      "and says so, because what it costs is the user's to weigh"
    )
    first.kill()

    const second = await listening(t, dir, ['--stable'])
    t.is(second.key, first.key, 'a sender who saved it can still reach us')
    second.kill()

    // A different wallet is a different address: the key is the seed's, not the machine's.
    const other = await listening(t, walletdir(t), ['--stable'])
    t.not(other.key, first.key)
    other.kill()
  }
)

test('--stable without --dht is called redundant rather than ignored', opts, async (t) => {
  // No network in this one: it never gets as far as a wire. `get` with nothing to receive
  // on stdin gives up, which is fine — the note is printed before that.
  const run = await cli(walletdir(t), ['get', '--stable'], { timeout: 60000 })
  t.ok(/--stable is redundant without --dht/.test(run.output))
})

test('ecash crosses the hyperdht to the key the receiver printed', opts, async (t) => {
  const sender = walletdir(t)
  const receiver = walletdir(t)
  await cli(sender, ['deposit', '--amount', '200', '--mint', MINT])

  const listener = await listening(t, receiver)

  // The full 64 characters, because the DHT resolves an exact key rather than scanning for
  // a prefix the way bluetooth does.
  const give = await cli(sender, ['give', '--dht', '--public-key', listener.key, '--amount', '21'])
  t.is(
    give.code,
    0,
    `\`cashme give --dht\` finds the peer and hands the token over${give.code === 0 ? '' : `. Output:\n${give.output}`}`
  )
  t.ok(/sending under a one-run key/.test(give.output), 'under a key of its own by default')

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

test("a send under --stable goes out under the wallet's address instead", opts, async (t) => {
  const sender = walletdir(t)
  const receiver = walletdir(t)
  await cli(sender, ['deposit', '--amount', '200', '--mint', MINT])

  const listener = await listening(t, receiver)
  const give = await cli(sender, [
    'give',
    '--dht',
    '--stable',
    '--public-key',
    listener.key,
    '--amount',
    '21'
  ])

  t.is(give.code, 0, 'the handover works the same way')
  // The key lands on the receiver as conn.remotePublicKey, which the CLI never prints — so
  // what is checked here is the sender's side of it: nothing disowns this send, which is
  // the note the default prints and the only place the two differ on the wire.
  t.absent(/one-run key/.test(give.output), 'and the send is not disowned')

  await listener.waitFor(/New Balance/)
  const claimed = satsIn(listener.output, 'New Balance')
  t.ok(claimed >= 20, `the ecash arrives either way (${claimed} sat)`)
})
