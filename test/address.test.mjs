// Which hyperdht key a run presents, and what it says about it.
//
// The choice has no wire in it — `--stable` or nothing, on either side of the link — so it
// is checked here rather than against a real DHT. What matters is which way it falls when
// the flag is absent: a run-only key that leaves nothing to look up afterwards. The
// wallet's own address is a lasting public identifier, and reaching it by accident is the
// mistake worth a test.
import '../lib/polyfills.mjs'
import test from 'brittle'
import process from 'bare-process'
import { wireIdentity } from '../lib/cli/address.mjs'
import { transportFrom, BLE, LAN, DHT } from '../lib/cli/transport.mjs'
import { dhtAddress } from '../lib/dht.mjs'
import { seedFromHex } from '../lib/seed.mjs'
import { give, get, root } from '../lib/cli/commands.mjs'

// The one thing wireIdentity reads off a wallet.
const SEED_HEX = 'a1'.repeat(64)
const wallet = { repos: { seedHex: SEED_HEX } }

const hex = (keyPair) => keyPair.publicKey.toString('hex')

// Everything these functions say goes through lib/notes.mjs to stderr, and the saying is
// half of what is under test: a key whose permanence the user is not told about is the
// same mistake as the wrong key.
function said(fn) {
  const stderr = process.stderr
  const original = stderr.write
  let output = ''
  stderr.write = (chunk) => {
    output += chunk
    return true
  }
  try {
    fn()
  } finally {
    stderr.write = original
  }
  return output
}

// The same capture where it is the returned key that matters and the note is only noise in
// the test output.
function quietly(fn) {
  let result
  said(() => {
    result = fn()
  })
  return result
}

test('without --stable a run gets a key of its own, on both sides of the link', (t) => {
  const first = quietly(() => wireIdentity(wallet, {}))
  const second = quietly(() => wireIdentity(wallet, {}))
  const listening = quietly(() => wireIdentity(wallet, {}, { listening: true }))

  t.not(hex(first), hex(second), 'a second run is not the first one again')
  t.not(hex(first), hex(listening), 'and receiving is no different from sending')
  for (const keyPair of [first, second, listening]) {
    t.not(hex(keyPair), hex(dhtAddress(seedFromHex(SEED_HEX))), 'none of them is the wallet')
  }
})

test("--stable is the wallet's own address, the same every run", (t) => {
  const own = hex(dhtAddress(seedFromHex(SEED_HEX)))

  const stable = (opts) => hex(quietly(() => wireIdentity(wallet, { stable: true }, opts)))

  t.is(stable(), own)
  t.is(stable(), own, 'unchanged by being asked twice')
  t.is(stable({ listening: true }), own, 'either side')
})

test('a run says which kind of key it is on', (t) => {
  t.ok(
    /this run only/.test(said(() => wireIdentity(wallet, {}, { listening: true }))),
    'a receiver is told the sender needs the key now'
  )
  t.ok(
    /the same every run/.test(
      said(() => wireIdentity(wallet, { stable: true }, { listening: true }))
    ),
    'and told when it is instead the one they can keep'
  )
  t.ok(
    /one-run key/.test(said(() => wireIdentity(wallet, {}))),
    'a sender is told this send is not tied to the wallet'
  )
  // Nothing to weigh on this one: the sender is presenting the address they already
  // announce, and asked for it.
  t.is(
    said(() => wireIdentity(wallet, { stable: true })),
    '',
    'and nothing when they asked for it'
  )
})

test('one identity serves every wire, so a stable key is the same on all three', (t) => {
  // The three transports all end in the same Noise handshake, and each takes the keypair
  // from here — so --stable is one address a sender can keep and reach this wallet on
  // whichever way they find it, rather than a hyperdht-only choice.
  const stable = hex(quietly(() => wireIdentity(wallet, { stable: true })))
  const listening = hex(quietly(() => wireIdentity(wallet, { stable: true }, { listening: true })))
  t.is(stable, listening, 'the same key whether sending or listening')

  const again = hex(quietly(() => wireIdentity(wallet, { stable: true })))
  t.is(again, stable, 'and the same key on the next run')

  const runOnly = hex(quietly(() => wireIdentity(wallet, {})))
  t.not(runOnly, stable, 'while the default is a key of this run alone')
})

// Which wire a run uses is read the same way by both commands, and the two network flags
// are a contradiction rather than a precedence.
test('the transport is the flag that was passed, and only one may be', (t) => {
  t.is(transportFrom({}), BLE, 'bluetooth needs nothing but the room')
  t.is(transportFrom({ lan: true }), LAN)
  t.is(transportFrom({ dht: true }), DHT)
  t.exception(() => transportFrom({ dht: true, lan: true }), /pass one of them/)
})

// The flag itself, as typed. `flags.stable` is what every check above reads, so a short
// flag wired to something else would leave all of them passing and the CLI wrong.
test('--stable and -s reach both commands', (t) => {
  const flags = (argv) => {
    root.parse(argv)
    return root.current.flags
  }

  t.ok(flags(['give', '--dht', '--stable', '-k', 'ab', '-a', '1']).stable)
  t.ok(flags(['give', '--dht', '-s', '-k', 'ab', '-a', '1']).stable, 'give takes the short flag')
  t.absent(flags(['give', '--dht', '-k', 'ab', '-a', '1']).stable, 'and is off without it')
  t.ok(flags(['get', '--dht', '--stable']).stable)
  t.ok(flags(['get', '--dht', '-s']).stable, 'get takes the short flag')
  t.absent(flags(['get', '--dht']).stable, 'and is off without it')

  // The flag this replaced. Left accepted it would silently do nothing, on a command
  // whose default it used to change.
  t.exception(() => flags(['get', '--dht', '--ephemeral']), /no --ephemeral flag/)
  t.exception(() => flags(['give', '--dht', '-e', '-k', 'ab', '-a', '1']), /no -e flag/)
  t.ok(give.name && get.name, 'both commands are the ones the CLI dispatches on')
})
