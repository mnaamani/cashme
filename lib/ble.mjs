import './polyfills.mjs'
import debuglog from 'bare-debug-log'
import crypto from 'hypercore-crypto'
import BluetoothSwarm from 'ble-swarm'
import Protomux from 'protomux'
import c from 'compact-encoding'
import { getTokenMetadata } from '@cashu/coco-core'
import { isMac } from 'which-runtime'
import { note } from './notes.mjs'

const debug = debuglog('cashme:ble')

// every peer must derive the SAME topic; the service UUID is hashed from it
const topicName = 'aleph-hackathon/v0/test'
const topic = crypto.hash(Buffer.from(topicName))

const PROTOCOL = 'cashme/token/v0'

// how long the sender waits for the receiver's ACK before giving up
const ACK_TIMEOUT = 15000

// how long each side waits for the other's goodbye before forcing the radio
// down. There is no usable flush(): NoiseSecretStream.flush() only proves the
// bytes reached the L2CAP write queue, and closing the swarm destroys that
// channel outright. So neither side tears down on its own timing — it waits for
// a frame the peer could only have sent after ours arrived.
const HANGUP_TIMEOUT = 5000

function withTimeout(promise, ms, value) {
  let timer
  return Promise.race([
    promise.then((v) => {
      clearTimeout(timer)
      return v
    }),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(value), ms)
    })
  ])
}

// Resolves when the link goes down. NOT a FIN: conn.end() puts nothing on the
// wire — NoiseSecretStream._final just calls end() on the L2CAP stream, which
// has no _final. The peer only learns we are gone once the native channel
// disconnects, after our teardown. A cleanup signal, never delivery proof.
function linkDown(conn) {
  return new Promise((resolve) => {
    conn.on('close', () => resolve())
    conn.on('end', () => resolve())
    conn.on('error', () => resolve())
  })
}

async function joinBluetoothSwarm() {
  const keyPair = crypto.keyPair()
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

function openChannel(conn, handlers) {
  const mux = Protomux.from(conn)
  const channel = mux.createChannel({
    protocol: PROTOCOL,
    onopen: handlers.onopen,
    onclose: handlers.onclose
  })
  const token = channel.addMessage({ encoding: c.utf8, onmessage: handlers.ontoken })
  const ack = channel.addMessage({ encoding: c.bool, onmessage: handlers.onack })
  channel.open()
  return { channel, token, ack }
}

// Resolves to a function that sends a payload to the neighbour once found. `cancelled`, if
// given, settles when the caller gives up — the neighbour may never show up, and the sender
// has proofs reserved while it waits.
export async function findNeighbour(pubKey, { cancelled } = {}) {
  const { swarm } = await joinBluetoothSwarm()

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

      // resolves when the receiver confirms it got a valid token
      let onack
      const acked = new Promise((resolve) => {
        onack = resolve
      })

      const handle = openChannel(conn, {
        onack,
        onopen() {
          // return a method the caller can use to send a string payload then disconnect
          handed = true
          resolve(async (payload) => {
            // Every step is timed: each ends in either a handshake with the peer or a
            // timeout, so a `give` that will not exit is read off the last step logged.
            const startedAt = Date.now()
            const step = (what) => debug(`${what} +${Date.now() - startedAt}ms`)

            handle.token.send(typeof payload === 'string' ? payload : payload.toString())
            step('token sent')
            // the ACK is how we know the token landed, so wait for it
            const ok = await withTimeout(acked, ACK_TIMEOUT, false)
            step(ok ? 'ack received' : 'ack timed out')
            if (!ok) note('no ACK from receiver — token may not have been delivered')
            // protomux close() writes a real CLOSE frame, and we only reach here
            // after the ACK — so it tells the receiver its ACK landed, which is
            // its cue to let go of the link.
            handle.channel.close()
            conn.end()
            // let the receiver drop the link: closing the swarm ourselves would
            // tear the L2CAP channel down with that CLOSE frame still queued
            await withTimeout(linkDown(conn), HANGUP_TIMEOUT, undefined)
            step('link down')
            await shutdown()
            step('radio down')
            return ok === true
          })
        }
      })
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
// Several neighbours can be paying us at once, so links are handled concurrently — each
// sender gets its ACK as soon as its token parses — while `ontoken` calls are queued, since
// they swap against a mint through a single wallet.
//
// `cancelled` settles when the caller wants to stop; the radio comes down before returning.
export async function receiveTokens({ ontoken, cancelled } = {}) {
  const { swarm, keyPair } = await joinBluetoothSwarm()
  // the sender needs this to find us, so print it rather than debug-log it
  note('our public key:', keyPair.publicKey.toString('hex'))
  note('waiting for tokens — Ctrl-C to stop')

  // One token at a time: coco serialises its own work, but a queue preserves arrival order
  // and stops one slow mint interleaving two receives. A throwing handler must not take the
  // listener down — the next neighbour is still coming.
  let queue = Promise.resolve()
  function enqueue(token) {
    queue = queue
      .then(() => ontoken(token))
      .catch((err) => {
        // The sender has been told the token arrived and will stop tracking those proofs,
        // so this string is now the only copy of the money. An unreachable mint is the
        // usual reason and it passes — print the token rather than drop it.
        note('[app:error] could not receive that token:', err.message)
        note('the sender has let go of it, so keep this and claim it later:')
        note(token)
      })
    return queue
  }

  function onconnection(conn) {
    debug('incoming connection', conn.remotePublicKey.toString('hex'))
    conn.on('error', (err) => debug('connection error:', err))

    // the sender closes only after our ACK reaches it, so its CLOSE frame is
    // our delivery receipt
    let onackdelivered
    const ackDelivered = new Promise((resolve) => {
      onackdelivered = resolve
    })

    const handle = openChannel(conn, {
      onclose(isRemote) {
        if (isRemote) onackdelivered(true)
      },
      async ontoken(token) {
        debug('received payload')
        try {
          // is the token valid?
          getTokenMetadata(token)
          debug('token is valid')
        } catch (_) {
          note('Invalid token received!')
          return // no ACK: the sender keeps its proofs
        }
        handle.ack.send(true)

        // Before the goodbye, not after: the wallet work and this link's hangup have
        // nothing to say to each other, and the sender is waiting on the hangup.
        enqueue(token)

        // Do NOT tear down here: with no usable flush(), closing the swarm now
        // destroys the channel with the ACK still queued inside it. Holding the
        // link open until the sender confirms is what lets it drain.
        const delivered = await withTimeout(
          Promise.race([ackDelivered, linkDown(conn).then(() => false)]),
          HANGUP_TIMEOUT,
          false
        )
        if (!delivered) note('sender never acknowledged our ACK')
        // we hang up first, since the sender waits on the link dropping. Only this link:
        // the swarm stays up for whoever comes next.
        debug('hanging up on', conn.remotePublicKey.toString('hex'))
        conn.destroy()
      }
    })
  }

  swarm.on('connection', onconnection)

  await cancelled

  debug('shutting down ble-swarm')
  swarm.off('connection', onconnection)
  // Let a receive still in flight finish, or a Ctrl-C mid-swap closes the wallet under it.
  await queue
  await teardown(swarm)
}
