// What the wallet does with what a relay sends it.
//
// A relay is not a trusted third party: it chooses what to answer with, and the one place
// that matters is the key a nutzap locks ecash to. These tests run against a relay that
// lies, which is the only way to show the checking works. No network, no mint.
import '../../lib/polyfills.mjs'
import test from 'brittle'
import { RelayPool, signEvent, ephemeralKeypair, NUTZAP_INFO_KIND } from '../../lib/nostr.mjs'
import { StubRelay } from './helpers.mjs'

const TIMEOUT = 4000

test('a query returns the events a relay was asked for', async (t) => {
  const relay = await StubRelay.open(t)
  const { secretKey, publicKey } = ephemeralKeypair()
  const event = signEvent(
    { kind: NUTZAP_INFO_KIND, content: '', tags: [['pubkey', '02ab']] },
    secretKey
  )
  relay.serve(event)

  const pool = new RelayPool([relay.url], { timeout: TIMEOUT })
  t.teardown(() => pool.destroy())

  const events = await pool.query({ kinds: [NUTZAP_INFO_KIND], authors: [publicKey] })
  t.is(events.length, 1)
  t.is(events[0].id, event.id)
})

test('an event the relay was not asked for is dropped', async (t) => {
  const relay = await StubRelay.open(t)
  const { secretKey, publicKey } = ephemeralKeypair()
  // Signed, genuine, and not what we asked for. A relay may answer a question with
  // something else, so matching the filter is checked rather than assumed.
  relay.serve(signEvent({ kind: 1, content: 'a note', tags: [] }, secretKey))

  const pool = new RelayPool([relay.url], { timeout: TIMEOUT })
  t.teardown(() => pool.destroy())

  t.alike(await pool.query({ kinds: [NUTZAP_INFO_KIND], authors: [publicKey] }), [])
})

test('a forged event is dropped even when it is the only answer', async (t) => {
  const relay = await StubRelay.open(t)
  const { secretKey, publicKey } = ephemeralKeypair()
  const honest = signEvent(
    { kind: NUTZAP_INFO_KIND, content: '', tags: [['pubkey', '02honest']] },
    secretKey
  )
  // The attack this exists to stop: a relay naming its own key in a kind 10019, so a
  // nutzap locks the ecash to the relay instead of the recipient. Nothing valid is served
  // alongside it, so nothing but the signature check can be what rejects it.
  relay.serve({ ...honest, tags: [['pubkey', '02attacker']] })

  const pool = new RelayPool([relay.url], { timeout: TIMEOUT })
  t.teardown(() => pool.destroy())

  t.alike(await pool.query({ kinds: [NUTZAP_INFO_KIND], authors: [publicKey] }), [])
})

test('a publish reports every relay, reachable or not', async (t) => {
  const relay = await StubRelay.open(t)
  const dead = 'ws://127.0.0.1:1' // nothing listens here, and nothing should hang on it
  const { secretKey } = ephemeralKeypair()
  const event = signEvent({ kind: 1, content: 'published', tags: [] }, secretKey)

  const pool = new RelayPool([relay.url, dead], { timeout: TIMEOUT })
  t.teardown(() => pool.destroy())

  const results = await pool.publish(event)
  t.is(results.length, 2, 'one result per relay')

  const accepted = results.find((result) => result.relay === relay.url)
  t.ok(accepted.ok, 'the relay that is listening stores it')
  t.absent(results.find((result) => result.relay === dead).ok, 'the one that is not says so')

  t.is(relay.received.length, 1, 'the relay really got it')
  t.is(relay.received[0].id, event.id)
})

test('events come back newest first', async (t) => {
  const relay = await StubRelay.open(t)
  const { secretKey, publicKey } = ephemeralKeypair()
  for (const created_at of [1700000000, 1800000000, 1600000000]) {
    relay.serve(signEvent({ kind: 0, content: `${created_at}`, tags: [], created_at }, secretKey))
  }

  const pool = new RelayPool([relay.url], { timeout: TIMEOUT })
  t.teardown(() => pool.destroy())

  const events = await pool.query({ kinds: [0], authors: [publicKey] })
  t.alike(
    events.map((event) => event.created_at),
    [1800000000, 1700000000, 1600000000]
  )
})
