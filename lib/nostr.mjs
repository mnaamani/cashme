// The little bit of nostr a nutzap needs: keys, signed events, and relays.
//
// Deliberately not a nostr client. Nothing here subscribes for long or keeps state between
// runs. `cashme nutzap` reads kind 10019 (where a user says how to nutzap them) and writes
// kind 9321 (the nutzap itself); `cashme zap` reads kind 0 (for the lightning address in a
// user's profile) and writes kind 9734 (the zap request an lnurl host turns into a
// receipt). That is the whole surface.
import './polyfills.mjs'
import { schnorr } from '@noble/curves/secp256k1.js'
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import * as nip05 from 'nostr-tools/nip05'
import { SimplePool } from 'nostr-tools/pool'
import { BareWebSocket } from './websocket.mjs'
import debuglog from 'bare-debug-log'

const debug = debuglog('cashme:nostr')

// NIP-61 event kinds. 10019 is the recipient's "here is how to nutzap me" event — which
// mints they trust, which relays to send to, and the key to lock the ecash to. 9321 is the
// nutzap: proofs carried in the tags of an event addressed to them.
export const NUTZAP_INFO_KIND = 10019
export const NUTZAP_KIND = 9321

// NIP-01 kind 0 is the user's profile, whose content holds the lightning address a zap is
// sent to. NIP-57: 9734 is the zap request we sign and hand to the lnurl host, 9735 the
// receipt that host publishes once the invoice is paid.
export const PROFILE_KIND = 0
export const ZAP_REQUEST_KIND = 9734
export const ZAP_RECEIPT_KIND = 9735

// nip19.decode understands every bech32 form nostr defines and raises the 90-character
// bech32 cap that npubs exceed. We accept only the one that names a public key, and check
// the length ourselves: nip19 hands back whatever bytes the string carried.
export function decodeNpub(npub) {
  const { type, data } = nip19.decode(npub)
  if (type !== 'npub') throw new Error(`expected an npub, got a ${type}1... key`)
  if (data.length !== 64) throw new Error(`an npub holds 32 bytes, this one has ${data.length / 2}`)
  return data
}

// Accepts either form a user is likely to paste. Returns the x-only public key as hex,
// which is how nostr writes it everywhere except bech32.
export function parsePublicKey(value) {
  const key = String(value).trim()
  if (key.startsWith('npub1')) return decodeNpub(key)
  if (/^[0-9a-f]{64}$/i.test(key)) return key.toLowerCase()
  throw new Error(`not a nostr public key: "${value}" — pass an npub1... or 64 hex characters`)
}

// Is this a `name@domain` nostr address rather than a key? nip05's own definition, which
// also accepts a bare `domain` — NIP-05 reads that as `_@domain`, and queryProfile
// resolves it that way.
export function isAddress(value) {
  return nip05.isNip05(String(value).trim())
}

// nip05.queryProfile answers every failure with null, and it asks with `redirect: 'manual'`
// — which bare-fetch ignores, following the redirect anyway. Both are fixed here rather
// than by reimplementing the lookup: the response is refused after the fact, and the reason
// is kept so resolveAddress can say more than "no".
let lookupFailure = null

nip05.useFetchImplementation(async (url, options) => {
  lookupFailure = null
  const host = new URL(url).host
  const fail = (message) => {
    lookupFailure = new Error(message)
    throw lookupFailure
  }

  let response
  try {
    response = await fetch(url, options)
  } catch (err) {
    fail(`could not reach ${host}: ${err.message}`)
  }
  // A redirect moves the claim to a host the user never named, which NIP-05 forbids.
  if (response.redirected) fail(`${host} redirected the lookup, which NIP-05 does not allow`)
  if (!response.ok) fail(`${host} answered the lookup with HTTP ${response.status}`)
  return response
})

// Resolve `name@domain` to a public key by asking the domain (NIP-05).
//
// A different kind of trust from everything else here: the domain's word, over TLS, that
// this name is that key. Nothing is signed, so an address is only as good as the host
// serving it — which is why nutzap still locks to the key from the recipient's own signed
// kind 10019 wherever it can, and uses this only to find whose 10019 to look for.
//
// `_@domain` is NIP-05's way of writing an address that is just the domain; it is resolved
// like any other name.
export async function resolveAddress(address) {
  const target = String(address).trim()
  if (!isAddress(target)) throw new Error(`not a nostr address: "${address}" — name@domain`)

  const profile = await nip05.queryProfile(target)
  if (!profile) throw lookupFailure ?? new Error(`nobody answers for ${target} — no such address`)

  // The key is whatever json the host served, so it is parsed rather than trusted to be a
  // key at all. The relay hints are optional: where that user is said to post, worth having
  // since we are about to go looking for their kind 10019.
  return {
    pubkey: parsePublicKey(profile.pubkey),
    relays: (profile.relays ?? []).filter((relay) => /^wss?:\/\//i.test(relay))
  }
}

// One entry point for whatever the user typed: an npub, hex, or a nostr address. Only the
// address form touches the network.
export function resolveRecipient(value) {
  if (isAddress(value)) return resolveAddress(value)
  return Promise.resolve({ pubkey: parsePublicKey(value), relays: [] })
}

// A nostr key used once, for one nutzap, and then forgotten.
//
// The nutzap is signed because relays only accept signed events, not because anyone needs
// to know who sent it: a fresh key means the zap carries no identity. The trade is that the
// recipient sees an anonymous zap, and that we cannot later prove it was ours.
export function ephemeralKeypair() {
  const secretKey = generateSecretKey()
  return { secretKey, publicKey: getPublicKey(secretKey) }
}

// NIP-01: the id is the sha256 of a canonical array, and the signature is over that id.
// finalizeEvent fills in the pubkey, id and sig, but wants a complete template — the
// defaults are ours.
export function signEvent({ kind, content = '', tags = [], created_at }, secretKey) {
  const event = finalizeEvent(
    { kind, content, tags, created_at: created_at ?? Math.floor(Date.now() / 1000) },
    secretKey
  )
  // finalizeEvent stamps a "this one is verified" symbol on what it returns. It survives a
  // spread, so a copy with a rewritten tag would inherit it and pass nostr-tools' own
  // verifyEvent unchecked. Nothing here should carry that claim around; see verifyEvent.
  for (const key of Object.getOwnPropertySymbols(event)) delete event[key]
  return event
}

// Is this event really the author's, unchanged?
//
// A relay saying an event is by someone is not evidence that it is: relays are not trusted
// third parties, and the one place it matters here is the key a nutzap locks ecash to. A
// relay that could forge a kind 10019 could name its own key and take the ecash. So every
// event a query returns is checked, and one that fails is dropped as if the relay had
// never sent it.
export function verifyEvent(event) {
  if (!event || typeof event !== 'object') return false
  if (!/^[0-9a-f]{64}$/.test(event.id ?? '')) return false
  if (!/^[0-9a-f]{64}$/.test(event.pubkey ?? '')) return false
  if (!/^[0-9a-f]{128}$/.test(event.sig ?? '')) return false
  if (!Number.isInteger(event.kind) || !Number.isInteger(event.created_at)) return false
  if (!Array.isArray(event.tags) || typeof event.content !== 'string') return false

  try {
    // Deliberately not nostr-tools' verifyEvent: that one caches its answer on the event
    // under a symbol and returns the cached value without looking, so an event that
    // carries the symbol is believed. Only the canonical hashing is borrowed.
    //
    // The id first: it is what the signature covers, so an event whose id does not match
    // its contents is tampered with even if the signature checks out against that id.
    if (getEventHash(event) !== event.id) return false
    return schnorr.verify(
      Buffer.from(event.sig, 'hex'),
      Buffer.from(event.id, 'hex'),
      Buffer.from(event.pubkey, 'hex')
    )
  } catch {
    // Malformed keys and signatures throw rather than return false.
    return false
  }
}

// The first value of the first tag of that name, or null. Tags are `[name, ...values]` and
// may repeat; NIP-61 has one pubkey but many mints and relays.
export function tagValue(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1] ?? null
}

export function tagValues(event, name) {
  return event.tags.filter((tag) => tag[0] === name && tag[1]).map((tag) => tag[1])
}

// The newest kind 0 for this user, read for the two fields a zap needs: lud16 (a lightning
// address) and lud06 (an lnurl). The pool has already checked the signature and the author,
// so these are the user's own word about where their money goes — not a relay's.
//
// A profile whose content is not json is a profile we cannot read, which is not an error
// worth failing a run over: the caller says so and asks for an address instead.
export async function readProfile(pool, pubkey) {
  const [event] = await pool.query({ kinds: [PROFILE_KIND], authors: [pubkey], limit: 1 })
  if (!event) return null

  let profile
  try {
    profile = JSON.parse(event.content)
  } catch {
    debug('kind 0 for %s is not json', pubkey)
    return null
  }

  return {
    name: typeof profile?.name === 'string' ? profile.name : null,
    lud16: typeof profile?.lud16 === 'string' ? profile.lud16.trim() : null,
    lud06: typeof profile?.lud06 === 'string' ? profile.lud06.trim() : null
  }
}

// Every relay is treated as unreliable and none is required: a query takes whatever comes
// back before the deadline, and a publish counts as done when any one relay accepts it.
//
// SimplePool does the connecting, the REQ/EOSE bookkeeping and the per-relay timeouts. Two
// things are ours: the websocket, and `verifyEvent` — a relay chooses what to send us, and
// the pool checks every event against the filter and this function before handing it over.
export class RelayPool {
  constructor(urls, { timeout = 8000 } = {}) {
    this.timeout = timeout
    this.urls = [...new Set(urls)]
    this.pool = new SimplePool({ websocketImplementation: BareWebSocket, verifyEvent })
  }

  // Ask every relay for the events matching `filter` and return them, newest first. Ends at
  // EOSE from all live relays, or at the timeout — whichever comes first.
  async query(filter) {
    const events = await this.pool.querySync(this.urls, filter, { maxWait: this.timeout })
    const byId = new Map(events.map((event) => [event.id, event]))
    return [...byId.values()].sort((a, b) => b.created_at - a.created_at)
  }

  // Returns one result per relay we could write to. `ok` is the relay's own OK frame: it
  // has stored the event and will serve it to the recipient. A relay we could not reach, or
  // that never answered, is reported rather than thrown — one relay is not the run.
  async publish(event) {
    const settled = await Promise.allSettled(this.pool.publish(this.urls, event))
    return settled.map((result, i) => ({
      relay: this.urls[i],
      ok: result.status === 'fulfilled',
      message: result.status === 'fulfilled' ? result.value || '' : String(result.reason ?? '')
    }))
  }

  destroy() {
    this.pool.destroy()
  }
}

// The event id a zap is aimed at, in any of the three forms NIP-19 writes one: bare hex,
// `note1…` (the id alone), or `nevent1…` (the id plus hints — relays it was seen on, and
// sometimes its author). None of them is typeable; 32 bytes of hash is a paste either way,
// which is the reason all three are accepted rather than just the one this wallet prints.
//
// The hints are worth keeping: the relays are where the note is most likely to still be
// found, and the author is a claim we can check against the person being paid before any
// relay is asked anything.
export function parseNoteId(value) {
  const typed = String(value).trim()
  if (/^[0-9a-f]{64}$/i.test(typed)) return { id: typed.toLowerCase(), relays: [], author: null }

  if (typed.startsWith('note1') || typed.startsWith('nevent1')) {
    const { type, data } = nip19.decode(typed)
    if (type === 'note') return { id: eventId(data), relays: [], author: null }
    return {
      id: eventId(data.id),
      relays: (data.relays ?? []).filter((relay) => /^wss?:\/\//i.test(relay)),
      author: data.author ? parsePublicKey(data.author) : null
    }
  }

  throw new Error(`not a nostr note: "${value}" — pass a note1…, an nevent1…, or 64 hex characters`)
}

function eventId(id) {
  const hex = String(id ?? '')
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('a nostr event id is 32 bytes; this is not')
  return hex.toLowerCase()
}

// The note being zapped, read back from the relays and checked to be the recipient's own.
//
// Nothing downstream checks an `e` tag: the tag is what puts the zap under a note, and a
// mis-pasted id would attribute the money to a stranger's note — or to nothing at all —
// after it has moved. Neither zap can be taken back, so the check belongs here, before
// anything is spent.
//
// What makes the author's key evidence rather than the relay's word is the pool: every
// event it hands over has already been checked against its own id and signature, so a relay
// cannot answer with somebody else's note under this id, or with a note it wrote itself and
// attributed to them.
export async function readNote(pool, target, author) {
  // The nevent's own claim, checked first because it costs nothing and a disagreement here
  // means the wrong thing was pasted rather than a note we failed to find.
  if (target.author && target.author !== author) {
    throw new Error(
      `that nevent says the note is ${target.author.slice(0, 12)}…'s, but you are paying ` +
        `${author.slice(0, 12)}… — one of the two was pasted from somewhere else`
    )
  }

  const [event] = await pool.query({ ids: [target.id], limit: 1 })
  if (!event || event.id !== target.id) {
    throw new Error(
      `no note ${target.id.slice(0, 12)}… on the ${pool.urls.length} relays asked, so there ` +
        'is no way to tell whose it is — add the relay it is on and try again'
    )
  }
  if (event.pubkey !== author) {
    throw new Error(
      `note ${target.id.slice(0, 12)}… was written by ${event.pubkey.slice(0, 12)}…, not by ` +
        `${author.slice(0, 12)}… — this would pay one person for another's note`
    )
  }

  return event
}

// The first line of a note, short enough to sit in a confirmation.
//
// This is the one place a stranger's text reaches the screen, so the control characters go
// first: a note carrying an escape sequence could otherwise repaint the confirmation it is
// being shown in, which is the last screen anything should be able to lie on.
export function notePreview(event, width = 60) {
  const line = event.content
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!line) return `kind ${event.kind}, no text`
  return line.length > width ? `${line.slice(0, width - 1)}…` : line
}
