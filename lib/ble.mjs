import './polyfills.mjs'
import process from 'bare-process'
import debuglog from 'bare-debug-log'
import crypto from 'hypercore-crypto'
import BluetoothSwarm from 'ble-swarm'
import Protomux from 'protomux'
import c from 'compact-encoding'
import { getTokenMetadata } from '@cashu/coco-core'
import { isMac } from 'which-runtime'

const debug = debuglog('cashme:ble')

// every peer must derive the SAME topic; the service UUID is hashed from it
const topicName = 'aleph-hackathon/v0/test'
const topic = crypto.hash(Buffer.from(topicName))

const PROTOCOL = 'cashme/token/v0'

// how long the sender waits for the receiver's ACK before giving up
const ACK_TIMEOUT = 15000

// how long each side waits for the other's goodbye before forcing the radio
// down. The BLE transport has no flush(): NoiseSecretStream.flush() only proves
// the bytes reached the L2CAP stream's write queue, and closing the swarm
// destroys that channel outright, dropping whatever it still holds. So neither
// side may tear down on its own timing — it waits for a frame from the peer
// that could only have been sent after ours arrived.
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

// Resolves when the link goes down. Note this is NOT a FIN: conn.end() puts
// nothing on the wire here — NoiseSecretStream._final just calls end() on the
// L2CAP stream, which has no _final and so never tells its channel anything.
// The peer only learns we are gone when the native channel disconnects, i.e.
// after our teardown. So it is a cleanup signal, never a delivery proof.
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
  if (!swarm.supported) {
    console.error('Bluetooth (BLE) unsupported on this runtime')
    process.exit(1)
  }
  await swarm.start()
  debug('joined BLE swarm, our publicKey:', keyPair.publicKey.toString('hex'), 'topic:', topicName)
  return { swarm, keyPair }
}

// Full teardown for a one-shot CLI run. close() stops scanning/advertising and
// destroys peers, but deliberately leaves the native CoreBluetooth managers
// alive (see transport._close: destroying them double-frees during a live
// session). Those managers keep the event loop alive, so the process never
// exits. ble-swarm itself only ever frees them on macOS, via destroyManagers.
async function teardown(swarm) {
  const transport = swarm.transport
  // don't let a close() that never settles strand us before destroyManagers:
  // if the managers are not freed, the process never exits
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

// return a function which can be used to send a payload to the neighbour when found.
// `cancelled`, if given, is a promise that settles when the caller gives up waiting — the
// neighbour may never show up, and the sender has proofs reserved while it waits.
export async function findNeighbour(pubKey, { cancelled } = {}) {
  const { swarm } = await joinBluetoothSwarm()

  let onconnection
  let handed = false

  const finding = new Promise((resolve, _reject) => {
    console.error('looking for', pubKey, 'over BLE')
    let found = false

    async function shutdown() {
      debug('shutting down ble-swarm')
      swarm.off('connection', onconnection)
      await teardown(swarm)
    }

    onconnection = function onconnection(conn) {
      // conn is a NoiseSecretStream: publicKey, remotePublicKey, isInitiator.
      // Handshake done, duplicate links already deduped.
      const neighbour = conn.remotePublicKey.toString('hex')
      debug('connected to', neighbour)
      if (!neighbour.startsWith(pubKey) || found) {
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
            handle.token.send(typeof payload === 'string' ? payload : payload.toString())
            // wait for the receiver's ACK before tearing the radio down, so we
            // know the token actually landed
            const ok = await withTimeout(acked, ACK_TIMEOUT, false)
            if (!ok) console.error('no ACK from receiver — token may not have been delivered')
            // protomux close() writes a real CLOSE frame, and we only get here
            // after the ACK, so receiving it tells the receiver its ACK landed.
            // That is the receiver's cue to let go of the link.
            handle.channel.close()
            conn.end()
            // wait for the receiver to drop the link rather than destroying it
            // ourselves — closing the swarm would tear the L2CAP channel down
            // with that CLOSE frame still queued inside it
            await withTimeout(linkDown(conn), HANGUP_TIMEOUT, undefined)
            await shutdown()
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
      // The neighbour arrived first and owns the radio now; leave the race to it rather
      // than tearing down a link that is mid-handoff.
      if (handed) return finding

      // Take the radio down before handing the failure back: ble-swarm leaves the native
      // managers alive after close(), and they keep bare's loop running, so a run that
      // skips teardown never exits.
      swarm.off('connection', onconnection)
      await teardown(swarm)
      throw reason instanceof Error ? reason : new Error(String(reason ?? 'cancelled'))
    })
  ])
}

export async function receiveToken() {
  const { swarm, keyPair } = await joinBluetoothSwarm()
  // the sender needs this to find us, so it is output rather than debug logging
  console.error('our public key:', keyPair.publicKey.toString('hex'))

  return new Promise((resolve, reject) => {
    let finished = false

    async function done(err, token) {
      if (finished) return
      finished = true
      debug('shutting down ble-swarm')
      swarm.off('connection', onconnection)
      // resolve first: teardown is best-effort cleanup, the caller already has
      // its token and must not be held up by a slow radio
      if (err) reject(err)
      else resolve(token)
      await teardown(swarm)
    }

    function onconnection(conn) {
      debug('incoming connection', conn.remotePublicKey.toString('hex'))
      conn.on('error', (err) => debug('connection error:', err))

      // the sender closes the channel only after our ACK reaches it, so its
      // CLOSE frame is our delivery receipt
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
            console.error('Invalid token received!')
            return // no ACK: the sender keeps its proofs
          }
          handle.ack.send(true)
          // Do NOT tear down here: conn.flush() cannot see past the secret
          // stream (the L2CAP stream has no flush()), so closing the swarm now
          // destroys the channel with the ACK still queued inside it. Hold the
          // link open until the sender confirms, which is what lets it drain.
          const delivered = await withTimeout(
            Promise.race([ackDelivered, linkDown(conn).then(() => false)]),
            HANGUP_TIMEOUT,
            false
          )
          if (!delivered) console.error('sender never acknowledged our ACK')
          // we hang up first; the sender is waiting on the link dropping
          done(null, token)
        }
      })
    }

    swarm.on('connection', onconnection)
  })
}
