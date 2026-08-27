// Must come first: @noble needs TextEncoder at module scope.
import '../lib/polyfills.mjs'
import test from 'brittle'
import { schnorr } from '@noble/curves/secp256k1.js'
import {
  parsePublicKey,
  isAddress,
  verifyEvent,
  decodeNpub,
  ephemeralKeypair,
  signEvent,
  tagValue,
  tagValues
} from '../lib/nostr.mjs'

// The one key form a user is likely to paste. Vector: jack's npub, from NIP-19.
const NPUB = 'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m'
const HEX = '82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2'

test('an npub decodes to the x-only key nostr uses everywhere else', (t) => {
  t.is(decodeNpub(NPUB), HEX)
  t.is(parsePublicKey(NPUB), HEX)
  t.is(parsePublicKey(HEX.toUpperCase()), HEX, 'hex is accepted in either case')
  t.is(parsePublicKey(`  ${NPUB}  `), HEX, 'a pasted key may carry whitespace')
})

test('anything that is not a public key is refused', (t) => {
  t.exception.all(
    () => parsePublicKey('nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5'),
    /npub/
  )
  t.exception.all(() => parsePublicKey(HEX.slice(0, 40)), /not a nostr public key/)
  t.exception.all(() => parsePublicKey('npub1zzz'), 'a broken npub is not a key')
})

// NIP-01: the id is the hash of a canonical array and the signature is over that id. A
// relay recomputes both, so getting either wrong means every nutzap is silently dropped.
test('a signed event carries an id and signature a relay will accept', (t) => {
  const { secretKey, publicKey } = ephemeralKeypair()
  const event = signEvent(
    { kind: 9321, content: 'hi', tags: [['p', HEX]], created_at: 1700000000 },
    secretKey
  )

  t.is(event.pubkey, publicKey)
  t.is(event.created_at, 1700000000)
  t.ok(/^[0-9a-f]{64}$/.test(event.id))
  t.ok(
    schnorr.verify(
      Buffer.from(event.sig, 'hex'),
      Buffer.from(event.id, 'hex'),
      Buffer.from(event.pubkey, 'hex')
    )
  )

  // Same input, same id: the serialization must not depend on anything but the event.
  const again = signEvent(
    { kind: 9321, content: 'hi', tags: [['p', HEX]], created_at: 1700000000 },
    secretKey
  )
  t.is(again.id, event.id)
})

// A kind 10019 has one pubkey and any number of mints and relays.
test('tags are read by name, one or many', (t) => {
  const event = {
    tags: [
      ['pubkey', '02abc'],
      ['mint', 'https://a.example', 'sat'],
      ['mint', 'https://b.example'],
      ['relay', 'wss://r.example']
    ]
  }
  t.is(tagValue(event, 'pubkey'), '02abc')
  t.is(tagValue(event, 'nothing'), null)
  t.alike(tagValues(event, 'mint'), ['https://a.example', 'https://b.example'])
  t.alike(tagValues(event, 'nothing'), [])
})

// A relay is not a trusted third party: it chooses what to send us, and a forged kind 10019
// would name the key a nutzap locks ecash to. Everything a query returns is checked.
test('a tampered or forged event does not verify', (t) => {
  const { secretKey } = ephemeralKeypair()
  const event = signEvent({ kind: 10019, content: '', tags: [['pubkey', '02abc']] }, secretKey)

  t.ok(verifyEvent(event), 'an event we signed ourselves verifies')

  // The id covers the content, so changing a tag breaks the id before the signature.
  t.absent(
    verifyEvent({ ...event, tags: [['pubkey', '02evil']] }),
    'a rewritten tag is caught by the id'
  )
  t.absent(verifyEvent({ ...event, content: 'other' }), 'rewritten content is caught by the id')

  // An attacker who recomputes the id to match still has to sign it.
  const forged = signEvent(
    { kind: 10019, content: '', tags: [['pubkey', '02evil']] },
    ephemeralKeypair().secretKey
  )
  t.absent(verifyEvent({ ...forged, pubkey: event.pubkey }), 'a signature by another key fails')

  t.absent(verifyEvent({ ...event, sig: 'ff'.repeat(64) }), 'a junk signature fails')
})

test('an event that is not shaped like an event does not verify', (t) => {
  const { secretKey } = ephemeralKeypair()
  const event = signEvent({ kind: 10019, content: '', tags: [] }, secretKey)

  t.absent(verifyEvent(null))
  t.absent(verifyEvent('not an event'))
  t.absent(verifyEvent({ ...event, id: undefined }))
  t.absent(verifyEvent({ ...event, sig: undefined }))
  t.absent(verifyEvent({ ...event, pubkey: 'nope' }))
  t.absent(verifyEvent({ ...event, kind: '10019' }), 'a kind must be a number, not a string')
  t.absent(verifyEvent({ ...event, tags: 'nope' }))
  t.absent(verifyEvent({ ...event, content: 42 }))
})

// NIP-05: `name@domain`, told apart from a key without touching the network.
test('a nostr address is told apart from a key', (t) => {
  t.ok(isAddress('alice@example.com'))
  t.ok(isAddress('_@fiatjaf.com'), 'the bare-domain form')
  t.ok(isAddress('a.b-c_d@sub.example.co.uk'), 'the local part allows -_. and the domain nests')
  t.ok(isAddress('  alice@example.com  '), 'a pasted address may carry whitespace')

  t.absent(isAddress(NPUB), 'an npub is a key, not an address')
  t.absent(isAddress(HEX), 'hex is a key, not an address')
  t.absent(isAddress('example.com'), 'a bare domain is not an address; NIP-05 wants _@domain')
  t.absent(isAddress('alice@'), 'half an address is not one')
  t.absent(isAddress('alice+tag@example.com'), 'NIP-05 local parts are narrower than email')
  t.absent(isAddress('alice@example'), 'a domain needs a tld')
})
