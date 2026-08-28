// The little bit of nostr a nutzap needs: keys, signed events, and relays.
//
// Deliberately not a nostr client. Nothing here subscribes for long or keeps state between
// runs. `cashme nutzap` reads kind 10019 (where a user says how to nutzap them) and writes
// kind 9321 (the nutzap itself); `cashme zap` reads kind 0 (for the lightning address in a
// user's profile) and writes kind 9734 (the zap request an lnurl host turns into a
// receipt). That is the whole surface.
import './polyfills.mjs'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bech32 } from '@scure/base'
import { Socket as WebSocket } from 'bare-ws'
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

// npubs are bech32 with no length limit; @scure/base caps at 90 characters unless told
// otherwise.
const BECH32_LIMIT = 5000

export function decodeNpub(npub) {
  const { prefix, words } = bech32.decode(npub, BECH32_LIMIT)
  if (prefix !== 'npub') throw new Error(`expected an npub, got a ${prefix}1... key`)
  const bytes = bech32.fromWords(words)
  if (bytes.length !== 32) throw new Error(`an npub holds 32 bytes, this one has ${bytes.length}`)
  return Buffer.from(bytes).toString('hex')
}

// Accepts either form a user is likely to paste. Returns the x-only public key as hex,
// which is how nostr writes it everywhere except bech32.
export function parsePublicKey(value) {
  const key = String(value).trim()
  if (key.startsWith('npub1')) return decodeNpub(key)
  if (/^[0-9a-f]{64}$/i.test(key)) return key.toLowerCase()
  throw new Error(`not a nostr public key: "${value}" — pass an npub1... or 64 hex characters`)
}

// NIP-05: the local part of an address, `a-z0-9-_.` — deliberately narrower than an email
// local part, so an address is safe to put straight into a query string.
const NIP05 = /^([a-z0-9\-_.]+)@([a-z0-9\-.]+\.[a-z]{2,})$/i

// Is this a `name@domain` nostr address rather than a key?
export function isAddress(value) {
  return NIP05.test(String(value).trim())
}

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
  const match = NIP05.exec(String(address).trim())
  if (!match) throw new Error(`not a nostr address: "${address}" — expected name@domain`)
  const [, name, domain] = match

  const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`
  let response
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } })
  } catch (err) {
    throw new Error(`could not reach ${domain} to look up ${address}: ${err.message}`)
  }

  // NIP-05 forbids following redirects, and bare-fetch has no way to say so up front — so
  // a redirected answer is refused after the fact rather than trusted. The point is that a
  // redirect moves the claim to a host the user never named.
  if (response.redirected) {
    throw new Error(`${domain} redirected the lookup for ${address}, which NIP-05 does not allow`)
  }
  if (!response.ok) {
    throw new Error(`${domain} does not know ${address} (HTTP ${response.status})`)
  }

  let body
  try {
    body = await response.json()
  } catch {
    throw new Error(`${domain} answered the lookup for ${address} with something that is not json`)
  }

  // Names are matched case-insensitively: a host may list `Alice` for `alice@domain`.
  const names = body?.names ?? {}
  const key = Object.entries(names).find(([listed]) => listed.toLowerCase() === name.toLowerCase())
  if (!key) throw new Error(`${domain} does not list ${name} — no such nostr address`)

  const pubkey = parsePublicKey(key[1])
  // The optional relay hints: where that user is said to post. Worth having, since we are
  // about to go looking for their kind 10019.
  const relays = (body?.relays?.[pubkey] ?? []).filter((relay) => /^wss?:\/\//i.test(relay))
  return { pubkey, relays }
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
  const secretKey = schnorr.utils.randomSecretKey()
  return { secretKey, publicKey: Buffer.from(schnorr.getPublicKey(secretKey)).toString('hex') }
}

// NIP-01: the id is the sha256 of a canonical array, and the signature is over that id.
export function signEvent({ kind, content = '', tags = [], created_at }, secretKey) {
  const event = {
    pubkey: Buffer.from(schnorr.getPublicKey(secretKey)).toString('hex'),
    created_at: created_at ?? Math.floor(Date.now() / 1000),
    kind,
    tags,
    content
  }
  const id = eventId(event)
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, 'hex'), secretKey)).toString('hex')
  return { ...event, id, sig }
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
    // The id first: it is what the signature covers, so an event whose id does not match
    // its contents is tampered with even if the signature checks out against that id.
    if (eventId(event) !== event.id) return false
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

function eventId({ pubkey, created_at, kind, tags, content }) {
  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content])
  return Buffer.from(sha256(Buffer.from(serialized, 'utf8'))).toString('hex')
}

// The first value of the first tag of that name, or null. Tags are `[name, ...values]` and
// may repeat; NIP-61 has one pubkey but many mints and relays.
export function tagValue(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1] ?? null
}

export function tagValues(event, name) {
  return event.tags.filter((tag) => tag[0] === name && tag[1]).map((tag) => tag[1])
}

// One relay connection. bare-ws gives us a duplex stream where every 'data' event is one
// complete websocket message, so a relay's line protocol needs no framing of its own.
class Relay {
  constructor(url) {
    this.url = url
    this.alive = true
    this.listeners = new Set()
    this.socket = new WebSocket(url)
    // The 'error' listener is not optional: nothing awaits this socket, and an unhandled
    // stream error would take the run down instead of costing us one relay.
    this.socket
      .on('data', (data) => this._onmessage(data))
      .on('error', (err) => this._onclose(err))
      .on('close', () => this._onclose())
  }

  _onmessage(data) {
    let message
    try {
      message = JSON.parse(data.toString())
    } catch {
      // A relay that speaks something other than NIP-01 is simply not useful to us.
      return debug('%s sent something that is not json', this.url)
    }
    debug('%s -> %o', this.url, message[0])
    for (const listener of this.listeners) listener(message)
  }

  _onclose(err) {
    if (err) debug('%s: %s', this.url, err.message)
    this.alive = false
    // Waiters are resolved by their own timeout; this only stops us writing to a dead socket.
  }

  send(message) {
    if (!this.alive) return false
    try {
      // bare-ws only takes 'buffer' or 'utf8': a string written as utf8 becomes a TEXT frame.
      this.socket.write(JSON.stringify(message), 'utf8')
      return true
    } catch (err) {
      this._onclose(err)
      return false
    }
  }

  listen(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  destroy() {
    this.alive = false
    this.listeners.clear()
    this.socket.destroy()
  }
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
export class RelayPool {
  constructor(urls, { timeout = 8000 } = {}) {
    this.timeout = timeout
    this.relays = [...new Set(urls)].map((url) => new Relay(url))
  }

  // A relay whose socket has already failed is known to be gone. A relay we have not
  // spoken to yet is only hopeful — the websocket handshake is not awaited anywhere, so
  // this counts sockets that have not failed *yet*, which is why nutzap queries before it
  // spends: a query that comes back empty from every relay is the real reachability test.
  get live() {
    return this.relays.filter((relay) => relay.alive)
  }

  // Ask every relay for the events matching `filter` and return them, newest first. Ends at
  // EOSE from all live relays, or at the timeout — whichever comes first.
  //
  // Only signed, matching events come back: a relay decides what to send us, so what it
  // sends is checked rather than believed. Anything that fails is dropped silently, since a
  // relay serving junk is a reason to ignore that relay, not to fail the run.
  async query(filter) {
    const id = `cashme-${Math.random().toString(16).slice(2, 10)}`
    const events = new Map()

    await this._gather(['REQ', id, filter], (message, done, relay) => {
      const [type, subscription, event] = message
      if (subscription !== id) return
      if (type === 'EVENT') {
        if (!matchesFilter(event, filter)) debug('%s sent an event we did not ask for', relay.url)
        else if (!verifyEvent(event)) debug('%s sent an event that does not verify', relay.url)
        else events.set(event.id, event)
      }
      if (type === 'EOSE' || type === 'CLOSED') done()
    })

    for (const relay of this.live) relay.send(['CLOSE', id])
    return [...events.values()].sort((a, b) => b.created_at - a.created_at)
  }

  // Returns one result per relay we could write to. `ok` is the relay's own OK frame: it
  // has stored the event and will serve it to the recipient.
  async publish(event) {
    const results = []

    await this._gather(['EVENT', event], (message, done, relay) => {
      if (message[0] !== 'OK' || message[1] !== event.id) return
      results.push({ relay: relay.url, ok: message[2] === true, message: message[3] || '' })
      done()
    })

    return results
  }

  // Send one frame to every live relay and wait until each has said its piece or the
  // deadline passes. The per-relay `done()` is what makes a slow relay cost only the
  // timeout, not the whole run.
  _gather(frame, onmessage) {
    const waiting = this.live.filter((relay) => relay.send(frame))
    if (!waiting.length) return Promise.resolve()

    return new Promise((resolve) => {
      let outstanding = waiting.length
      const stops = []
      const finish = () => {
        clearTimeout(timer)
        for (const stop of stops) stop()
        resolve()
      }
      const timer = setTimeout(finish, this.timeout)

      for (const relay of waiting) {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          if (--outstanding === 0) finish()
        }
        stops.push(relay.listen((message) => onmessage(message, done, relay)))
      }
    })
  }

  destroy() {
    for (const relay of this.relays) relay.destroy()
  }
}

// A signature proves who wrote an event, not that it is the one we asked for: a relay is
// free to answer a question with something else. Covers the parts of a filter this module
// actually sends — kinds, authors, ids — and ignores the rest.
function matchesFilter(event, filter) {
  if (!event || typeof event !== 'object') return false
  if (filter.ids && !filter.ids.includes(event.id)) return false
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false
  return true
}
