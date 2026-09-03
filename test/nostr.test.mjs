// Must come first: @noble needs TextEncoder at module scope.
import '../lib/polyfills.mjs'
import test from 'brittle'
import * as nip19 from 'nostr-tools/nip19'
import { schnorr } from '@noble/curves/secp256k1.js'
import {
  parsePublicKey,
  isAddress,
  verifyEvent,
  decodeNpub,
  ephemeralKeypair,
  signEvent,
  tagValue,
  tagValues,
  parseNoteId,
  readNote,
  notePreview
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

// nostr-tools' finalizeEvent marks what it returns as already-verified, under a symbol
// its own verifyEvent trusts without rechecking. A spread copies that mark, so if it ever
// leaked out of signEvent a rewritten event would verify. It must not survive.
test('a signed event carries no claim that it is already verified', (t) => {
  const { secretKey } = ephemeralKeypair()
  const event = signEvent({ kind: 9321, content: 'hi', tags: [] }, secretKey)

  t.alike(Object.getOwnPropertySymbols(event), [], 'no symbols ride along on a signed event')
  t.absent(verifyEvent({ ...event, content: 'rewritten' }), 'a copy is checked, not believed')
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
  t.absent(isAddress('alice@'), 'half an address is not one')
  t.absent(isAddress('alice@example'), 'a domain needs a tld')

  // nip05's own definition, wider than the one this module used to carry: a bare domain is
  // NIP-05's `_@domain` written short, and the local part allows `+`. Both go to the
  // network now rather than being refused up front.
  t.ok(isAddress('example.com'), 'a bare domain is the _@domain form')
  t.ok(isAddress('alice+tag@example.com'), 'the local part is as wide as nip05 says')
})

// The note a zap is aimed at, in the three forms NIP-19 writes an event id. Vectors encoded
// from ID below with nip19, which is also what a client's "copy note id" button hands over.
const ID = '5c04292b1080052d593c4b0f22ba9f4f0e01a2c9e0f0b0f4f8d1c3b2a1908070'
const NOTE1 = 'note1tszzj2cssqzj6kfufv8j9w5lfu8qrgkfurctpa8c68pm9gvsspcq2d7ve0'

test('a note id is accepted in every form nostr writes one', (t) => {
  t.alike(parseNoteId(ID), { id: ID, relays: [], author: null }, 'bare hex, as a tag carries it')
  t.is(parseNoteId(`  ${ID.toUpperCase()}  `).id, ID, 'a paste may carry case and whitespace')
  t.is(parseNoteId(NOTE1).id, ID, 'note1… is the id alone')

  // An nevent carries hints as well: relays it was seen on, which is where it is most
  // likely to still be, and sometimes the author it is claimed to belong to.
  const nevent = nip19.neventEncode({
    id: ID,
    relays: ['wss://relay.example', 'nope://x'],
    author: HEX
  })
  t.alike(parseNoteId(nevent), { id: ID, relays: ['wss://relay.example'], author: HEX })
})

test('anything that is not a note is refused before a relay is asked', (t) => {
  t.exception.all(() => parseNoteId(NPUB), /not a nostr note/, 'a key is not a note')
  t.exception.all(() => parseNoteId(ID.slice(0, 40)), /not a nostr note/)
  t.exception.all(() => parseNoteId('note1zzz'), 'a broken note1 is not a note')
  t.exception.all(() => parseNoteId(''), /not a nostr note/)
})

// The check that stands between a zap and paying one person for another's note. What the
// relay says is not evidence — the pool has already verified the id and signature of
// whatever it hands over, so the author's key here is the note's own word.
test('a note is only zapped once it is known to be theirs', async (t) => {
  const { secretKey, publicKey } = ephemeralKeypair()
  const theirs = signEvent({ kind: 1, content: 'hello nostr' }, secretKey)
  const pool = fakePool([theirs])

  const found = await readNote(pool, { id: theirs.id, relays: [], author: null }, publicKey)
  t.is(found.id, theirs.id, 'their own note goes through')

  const other = ephemeralKeypair()
  await t.exception(
    readNote(pool, { id: theirs.id, relays: [], author: null }, other.publicKey),
    /not by/,
    "somebody else's note is refused rather than paid for"
  )

  await t.exception(
    readNote(fakePool([]), { id: theirs.id, relays: [], author: null }, publicKey),
    /no note/,
    'a note no relay has is refused: there is no way to tell whose it is'
  )

  // The nevent's own claim, disagreeing with who is being paid: the wrong thing was
  // pasted, and it costs no relay round trip to say so.
  await t.exception(
    readNote(pool, { id: theirs.id, relays: [], author: other.publicKey }, publicKey),
    /pasted from somewhere else/
  )
})

test('a note preview is one line, and carries no escape sequences', (t) => {
  t.is(notePreview({ kind: 1, content: '  first line\nsecond  ' }), 'first line second')
  t.is(notePreview({ kind: 1, content: '' }), 'kind 1, no text', 'a note with no text says so')
  t.is(
    notePreview({ kind: 1, content: 'gm \x1b[2Jgone' }),
    'gm [2Jgone',
    "the escape is stripped: a stranger's note cannot repaint the confirmation it is shown in"
  )
  t.is(notePreview({ kind: 1, content: 'x'.repeat(80) }, 10), `${'x'.repeat(9)}…`)
})

// Only the two methods readNote uses. A relay is a thing that answers with events; what
// makes the answer trustworthy is checked in RelayPool, not here.
function fakePool(events) {
  return { urls: ['wss://relay.example'], query: () => Promise.resolve(events) }
}
