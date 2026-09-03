// Token delivery over a bluetooth radio link: find the neighbour, hand over, hang up.
// The frames themselves are lib/token-wire.mjs, shared with the hyperdht transport.
import './polyfills.mjs'
import debuglog from 'bare-debug-log'
import crypto from 'hypercore-crypto'
import BluetoothSwarm from 'ble-swarm'
import { isMac } from 'which-runtime'
import { note } from './notes.mjs'
import {
  senderChannel,
  receiverChannel,
  tokenQueue,
  withTimeout,
  HANGUP_TIMEOUT
} from './token-wire.mjs'

const debug = debuglog('cashme:ble')

// every peer must derive the SAME topic; the service UUID is hashed from it
const topicName = 'cashme/ble/v1'
const topic = crypto.hash(Buffer.from(topicName))

// `keyPair` is who we are to everyone in range: it is the swarm's advertised key and the
// one the Noise handshake presents, which are the same key here. Given by the caller so
// that --stable reaches this wire too — a run-only key when it is not asked for, which is
// what the default still is.
async function joinBluetoothSwarm(keyPair = crypto.keyPair()) {
  const swarm = new BluetoothSwarm({
    keyPair,
    topic,
    online: false // be aggressive in finding peers
  })
  // Thrown, not exited: bin.mjs prints the message, closes the wallet and flushes stderr
  // on the way out. Exiting here skipped all three — including the message itself, which
  // is queued (see lib/notes.mjs) and dropped by an exit that does not wait for it.
  if (!swarm.supported) throw new Error('bluetooth (BLE) is not supported on this runtime')
  await swarm.start()
  debug('joined BLE swarm, our publicKey:', keyPair.publicKey.toString('hex'), 'topic:', topicName)
  return { swarm, keyPair }
}

// Full teardown. close() stops scanning/advertising and destroys peers, but
// deliberately leaves the native CoreBluetooth managers alive (transport._close:
// destroying them double-frees during a live session) — and those keep the event
// loop alive forever. ble-swarm only frees them on macOS, via destroyManagers.
async function teardown(swarm) {
  const transport = swarm.transport
  // a close() that never settles must not strand us before destroyManagers
  await withTimeout(
    swarm.close().catch((err) => debug('swarm close failed:', err)),
    HANGUP_TIMEOUT,
    undefined
  )
  if (isMac && transport) transport.destroyManagers()
}

// Resolves to a function that sends a payload to the neighbour once found. `cancelled`, if
// given, settles when the caller gives up — the neighbour may never show up, and the sender
// has proofs reserved while it waits.
export async function findNeighbour(pubKey, { keyPair, cancelled } = {}) {
  const { swarm } = await joinBluetoothSwarm(keyPair)

  let onconnection
  let handed = false

  const finding = new Promise((resolve, _reject) => {
    note('looking for', pubKey, 'over BLE')
    let found = false

    // A link that drops and comes back is announced again; report each key once so a
    // flapping neighbour does not fill the screen.
    const reported = new Set()

    async function shutdown() {
      debug('shutting down ble-swarm')
      swarm.off('connection', onconnection)
      await teardown(swarm)
    }

    onconnection = function onconnection(conn) {
      // conn is a NoiseSecretStream, handshake done and duplicate links deduped
      const neighbour = conn.remotePublicKey.toString('hex')
      debug('connected to', neighbour)
      if (!neighbour.startsWith(pubKey) || found) {
        // Reaching a peer we cannot use looks like reaching nobody, unless we say so. The
        // usual reason is a `--public-key` copied from an earlier run: the receiver's key
        // is fresh on every `cashme get`.
        if (!found && !reported.has(neighbour)) {
          reported.add(neighbour)
          note(`saw ${neighbour} — not the neighbour we are looking for`)
        }
        conn.destroy()
        return
      }
      found = true
      conn.on('error', (err) => debug('connection error:', err))

      // return a method the caller can use to send a string payload then disconnect
      senderChannel(conn, {
        trace: debug,
        // the radio has to come down with the link, or the run never exits (see teardown)
        after: shutdown,
        onopen() {
          handed = true
        }
      }).then(resolve)
    }

    swarm.on('connection', onconnection)
  })

  if (!cancelled) return finding

  return Promise.race([
    finding,
    cancelled.then(async (reason) => {
      // The neighbour got here first and owns the radio; do not tear down a handoff.
      if (handed) return finding

      // Radio down before the failure goes back: a run that skips teardown never exits
      // (see teardown).
      swarm.off('connection', onconnection)
      await teardown(swarm)
      throw reason instanceof Error ? reason : new Error(String(reason ?? 'cancelled'))
    })
  ])
}

// Listen for tokens until the caller gives up, calling `ontoken` once per valid one.
//
// Several neighbours can be paying us at once, so links are handled concurrently while
// `ontoken` calls are queued, since they swap against a mint through a single wallet. The
// queue has a finite capacity; beyond it a sender is not acknowledged and retains its proofs.
//
// `cancelled` settles when the caller wants to stop; the radio comes down before returning.
export async function receiveTokens({ keyPair, ontoken, onaddress, cancelled } = {}) {
  const { swarm, keyPair: ours } = await joinBluetoothSwarm(keyPair)
  // the sender needs this to find us, so print it rather than debug-log it
  const address = ours.publicKey.toString('hex')
  note('our public key:', address)
  // A screen that owns the terminal has nowhere to read that line from, so it is handed
  // over as well as printed — see lib/tui/screens/get.mjs.
  onaddress?.(address)
  note('waiting for tokens — Ctrl-C to stop')

  const queue = tokenQueue(ontoken)

  function onconnection(conn) {
    debug('incoming connection', conn.remotePublicKey.toString('hex'))
    conn.on('error', (err) => debug('connection error:', err))
    receiverChannel(conn, { ontoken: queue.enqueue, canReceive: queue.canReceive })
  }

  swarm.on('connection', onconnection)

  await cancelled

  debug('shutting down ble-swarm')
  swarm.off('connection', onconnection)
  // Let a receive still in flight finish, or a Ctrl-C mid-swap closes the wallet under it.
  await queue.drained()
  await teardown(swarm)
}
