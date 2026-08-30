// Token delivery over the hyperdht: the same handover as bluetooth, to someone who is not
// in the room. The frames are lib/token-wire.mjs, byte-for-byte what the radio carries —
// only the way the two sides find each other changes.
//
// Bluetooth finds a neighbour by scanning a topic and matching a key prefix, so the key can
// be partial. Here the key IS the address: hyperdht connects to the peer listening on that
// exact ed25519 public key, holepunching a direct UDP link and doing the same Noise
// handshake at the end of it. So it must be the whole key.
//
// Being an address rather than a scan target, it can be kept: dhtAddress derives one from
// the wallet seed, the same on every run, so a sender can save it the way they save a phone
// number instead of being read a fresh one per payment. That is not what a run does unless
// asked (--stable): ephemeralAddress gives it a key of its own and leaves nothing reusable
// behind — see both below for which to reach for.
import './polyfills.mjs'
import debuglog from 'bare-debug-log'
import DHT from 'hyperdht'
import crypto from 'hypercore-crypto'
import { note } from './notes.mjs'
import { assertUnproxied, dhtOptions } from './net.mjs'
import { senderChannel, receiverChannel, tokenQueue } from './token-wire.mjs'

const debug = debuglog('cashme:dht')

// Domain separation: the wallet seed also derives every blinded secret sent to a mint
// (NUT-13), and a key published to a public DHT must not lead back to it. The hash is
// one-way, so the address gives nothing away about the seed behind it.
const DERIVATION = 'cashme/dht/v1'

// how long to wait for the holepunch before giving up on a peer that is not there. A
// direct connect is usually under a second; a relayed one, several.
const CONNECT_TIMEOUT = 30000

// This wallet's reusable address: same seed, same key, so `cashme get --dht --stable`
// prints the same thing every run and a sender can keep it.
//
// What that costs is worth being clear about, because it is not undone later. Listening
// announces this key on the DHT together with the address — or the relay nodes — that
// reach this machine, so anyone ever given it can afterwards check whether this wallet is
// online, and roughly from where, for as long as the wallet exists. Handing it to someone
// is closer to giving out a phone number than a one-time code. Which is why it is asked for
// rather than assumed: ephemeralAddress is what a run is paid on otherwise.
//
// One key per wallet file, so the same seed restored onto two machines announces the same
// address from both, and senders reach whichever the DHT picks. Nothing here prevents that
// — the seed lives only in the wallet file, so it is unlikely rather than guarded against.
export function dhtAddress(seed) {
  const material = crypto.hash(Buffer.concat([Buffer.from(DERIVATION), Buffer.from(seed)]))
  return DHT.keyPair(material)
}

// A key for one run, gone with it: nothing to look up afterwards, and nothing linking this
// run to the next. Receiving with it costs the sender knowing the current key, so it only
// works where they can be told it now; sending with it costs nothing but recognisability.
// The default on both sides, dhtAddress above being the deliberate exception.
export function ephemeralAddress() {
  return DHT.keyPair()
}

function parseKey(pubKey) {
  const key = Buffer.from(String(pubKey), 'hex')
  if (key.length !== 32) {
    // The two mistakes worth naming: a BLE key prefix pasted into a DHT send, and a key
    // from the receiver's last run. Bluetooth matches prefixes; the DHT resolves an exact
    // key and has nothing to scan.
    throw new Error(`--public-key must be the receiver's full 64-character key, got ${pubKey}`)
  }
  return key
}

// Resolves to a function that sends a payload to the peer, once connected.
//
// `keyPair` is who we are to them: the Noise handshake presents it, so it lands on their
// side as conn.remotePublicKey. An ephemeralAddress, which is what a send uses unless
// --stable is asked for, ties this link to nothing. Giving it the same dhtAddress we listen
// on instead makes a wallet one identity on both sides, which is what lets a receiver
// recognise a sender it has been paid by before — and, equally, what lets everyone we pay
// recognise us later.
//
// `cancelled`, if given, settles when the caller gives up — the peer may be offline, and
// the sender has proofs reserved while it waits.
//
// Not async on purpose: a bad key is a mistake in the command line, so it throws where it
// is called rather than resolving into the send's error path.
export function findPeer(pubKey, { keyPair, cancelled } = {}) {
  const key = parseKey(pubKey)
  // Before anything is reserved: a proxy cannot carry this, and the run must not fall back
  // to going out directly under a flag that says it should not (see lib/net.mjs).
  assertUnproxied('a send over the hyperdht')
  // connect() signs the handshake with the node's default pair unless told otherwise, so
  // setting it here is what fixes our identity for the link below.
  const node = new DHT({ keyPair, ...dhtOptions() })
  let handed = false

  async function shutdown() {
    debug('destroying dht node')
    await node.destroy()
  }

  const finding = new Promise((resolve, reject) => {
    note('looking for', pubKey, 'over the hyperdht')
    const conn = node.connect(key)

    // Nothing resolves this on its own: a peer that is not listening looks exactly like one
    // that is slow to punch, until hyperdht gives up on it — which it may never do while it
    // keeps finding fresh nodes to try.
    const timer = setTimeout(() => {
      conn.destroy()
      reject(new Error(`no peer answered on ${pubKey} within ${CONNECT_TIMEOUT / 1000}s`))
    }, CONNECT_TIMEOUT)

    conn.on('error', (err) => {
      debug('connection error:', err)
      // After the handover the link always ends in an error or a close — that is the
      // hangup, not a failure.
      if (handed) return
      clearTimeout(timer)
      reject(err)
    })

    conn.on('open', () => {
      clearTimeout(timer)
      debug('connected to', conn.remotePublicKey.toString('hex'))
      senderChannel(conn, {
        trace: debug,
        // the node has to come down with the link, or the run never exits: hyperdht keeps
        // sockets and a keep-alive timer on the loop.
        after: shutdown,
        onopen() {
          handed = true
        }
      }).then(resolve, reject)
    })
  })

  // A failed connect owns the node too — nothing else will bring it down.
  const attempt = finding.catch(async (err) => {
    if (!handed) await shutdown()
    throw err
  })

  if (!cancelled) return attempt

  return Promise.race([
    attempt,
    cancelled.then(async (reason) => {
      // The peer got here first and owns the node; do not tear down a handoff.
      if (handed) return attempt
      await shutdown()
      throw reason instanceof Error ? reason : new Error(String(reason ?? 'cancelled'))
    })
  ])
}

// Listen for tokens until the caller gives up, calling `ontoken` once per valid one.
//
// Same shape as the bluetooth listener: links are handled concurrently — each sender gets
// its ACK as soon as its token parses — while `ontoken` calls are queued, since they swap
// against a mint through a single wallet.
//
// `keyPair` is the address to listen on — ephemeralAddress, or dhtAddress under --stable. `cancelled`
// settles when the caller wants to stop; the node comes down before returning.
export async function receiveTokens({ keyPair, ontoken, cancelled } = {}) {
  assertUnproxied('listening on the hyperdht')
  // The node's own key, used for anything it dials, is left random: senders come to us
  // here, so the announced key above is the only one that has to be findable.
  const node = new DHT(dhtOptions())
  const queue = tokenQueue(ontoken)

  const server = node.createServer((conn) => {
    debug('incoming connection', conn.remotePublicKey.toString('hex'))
    conn.on('error', (err) => debug('connection error:', err))
    receiverChannel(conn, { ontoken: queue.enqueue })
  })

  // Announced on the DHT from here on, so anyone holding the key can punch to us.
  await server.listen(keyPair)
  debug('listening on', keyPair.publicKey.toString('hex'))

  // the sender needs this to find us, so print it rather than debug-log it
  note('our public key:', keyPair.publicKey.toString('hex'))
  note('waiting for tokens — Ctrl-C to stop')

  await cancelled

  debug('shutting down dht node')
  await server.close()
  // Let a receive still in flight finish, or a Ctrl-C mid-swap closes the wallet under it.
  await queue.drained()
  await node.destroy()
}
