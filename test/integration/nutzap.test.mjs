// A nutzap all the way through: real ecash, locked at a real mint, published as a real
// kind 9321 to a relay the test controls.
//
// The relay is ours so that nothing here reaches a stranger's, and so the published event
// can be read back and checked. What matters is not that the relay said OK — it is that
// the ecash in the event is locked to the key the recipient's own signed kind 10019 named,
// because that key is the whole security of NIP-61.
import '../../lib/polyfills.mjs'
import test from 'brittle'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bech32 } from '@scure/base'
import {
  signEvent,
  ephemeralKeypair,
  verifyEvent,
  tagValue,
  tagValues,
  NUTZAP_INFO_KIND,
  NUTZAP_KIND
} from '../../lib/nostr.mjs'
import { cli, walletdir, StubRelay, MINT, OFFLINE } from './helpers.mjs'

const opts = { skip: OFFLINE, timeout: 300000 }

// A recipient who exists only for this test: a nostr identity, a key to lock ecash to, and
// the signed kind 10019 that ties them together and names where to deliver.
function recipient(relayUrl, { lockedTo } = {}) {
  const identity = ephemeralKeypair()
  const p2pk = schnorr.utils.randomSecretKey()
  const locked = lockedTo ?? '02' + Buffer.from(schnorr.getPublicKey(p2pk)).toString('hex')
  const info = signEvent(
    {
      kind: NUTZAP_INFO_KIND,
      content: '',
      tags: [
        ['pubkey', locked],
        ['mint', MINT, 'sat'],
        ['relay', relayUrl]
      ]
    },
    identity.secretKey
  )
  const npub = bech32.encode('npub', bech32.toWords(Buffer.from(identity.publicKey, 'hex')), 5000)
  return { npub, pubkey: identity.publicKey, locked, info }
}

test('a nutzap locks real ecash to the key the recipient published', opts, async (t) => {
  const relay = await StubRelay.open(t)
  const to = recipient(relay.url)
  relay.serve(to.info)

  const dir = walletdir(t)
  await cli(dir, ['deposit', '--amount', '200', '--mint', MINT])

  const sent = await cli(dir, [
    'nutzap',
    '--pubkey',
    to.npub,
    '--sats',
    '25',
    '--relay',
    relay.url,
    '--comment',
    'integration test',
    '--yes'
  ])
  t.is(sent.code, 0, '`cashme nutzap` succeeds')
  t.ok(/Nutzapped 25 sat/.test(sent.output), 'and says so')

  t.is(relay.received.length, 1, 'exactly one event was published')
  const event = relay.received[0]

  t.is(event.kind, NUTZAP_KIND)
  t.ok(verifyEvent(event), 'the nutzap is signed')
  t.is(tagValue(event, 'p'), to.pubkey, 'addressed to the recipient')
  t.is(tagValue(event, 'u'), MINT, 'naming the mint the ecash is from')
  t.is(event.content, 'integration test', 'carrying the comment')
  t.not(event.pubkey, to.pubkey, 'signed by a key that is nobody')

  const proofs = tagValues(event, 'proof').map((proof) => JSON.parse(proof))
  t.ok(proofs.length > 0, 'the ecash is in the tags')
  t.is(
    proofs.reduce((total, proof) => total + proof.amount, 0),
    25,
    'and adds up to what was asked for'
  )

  // The part that matters: spendable by the recipient's key and nobody else's.
  const secrets = proofs.map((proof) => JSON.parse(proof.secret))
  t.ok(
    secrets.every((secret) => secret[0] === 'P2PK'),
    'every proof is locked, not bearer'
  )
  t.ok(
    secrets.every((secret) => secret[1].data === to.locked),
    'to the key the kind 10019 named'
  )
})

test('a nutzap is not sent when the recipient never said how', opts, async (t) => {
  const relay = await StubRelay.open(t)
  // A recipient with no kind 10019 anywhere: there is no key to lock to, so there is
  // nothing safe to send. The ecash must stay put.
  const to = recipient(relay.url)

  const dir = walletdir(t)
  await cli(dir, ['deposit', '--amount', '200', '--mint', MINT])

  const sent = await cli(dir, [
    'nutzap',
    '--pubkey',
    to.npub,
    '--sats',
    '25',
    '--relay',
    relay.url,
    '--yes'
  ])
  t.not(sent.code, 0, 'the command fails')
  t.is(relay.received.length, 0, 'and nothing was published')

  const balance = await cli(dir, ['balance'])
  t.ok(/200 sat/.test(balance.output), 'the ecash is untouched')
})
