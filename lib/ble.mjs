import './polyfills.mjs'
import process from 'bare-process'
import crypto from 'hypercore-crypto'
import BluetoothSwarm from 'ble-swarm'
import Protomux from 'protomux'
import c from 'compact-encoding'
import { getTokenMetadata } from '@cashu/cashu-ts'
import { isMac } from 'which-runtime'

// every peer must derive the SAME topic; the service UUID is hashed from it
const topicName = 'aleph-hackathon/v0/test'
const topic = crypto.hash(Buffer.from(topicName))

const PROTOCOL = 'cashme/token/v0'

// how long the sender waits for the receiver's ACK before giving up
const ACK_TIMEOUT = 15000

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
  // return our public key so it can be shared with the neighbour in person
  console.error(
    'joined BLE swarm, our publickKey:',
    keyPair.publicKey.toString('hex'),
    'topic:',
    topicName
  )
  return swarm
}

// Full teardown for a one-shot CLI run. close() stops scanning/advertising and
// destroys peers, but deliberately leaves the native CoreBluetooth managers
// alive (see transport._close: destroying them double-frees during a live
// session). Those managers keep the event loop alive, so the process never
// exits. ble-swarm itself only ever frees them on macOS, via destroyManagers.
async function teardown(swarm) {
  const transport = swarm.transport
  await swarm.close().catch((err) => console.error(err))
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

// return a function which can be used to send a payload to the neighbour when found
export async function findNeighbour(pubKey) {
  const swarm = await joinBluetoothSwarm()

  return new Promise((resolve, reject) => {
    console.error('looking for', pubKey, 'over BLE')
    let found = false

    function shutdown() {
      console.error('shutting down ble-swarm')
      swarm.off('connection', onconnection)
      teardown(swarm)
    }

    function onconnection(conn) {
      // conn is a NoiseSecretStream: publicKey, remotePublicKey, isInitiator.
      // Handshake done, duplicate links already deduped.
      const neighbour = conn.remotePublicKey.toString('hex')
      console.error('connected to', neighbour)
      if (!neighbour.startsWith(pubKey) || found) {
        conn.destroy()
        return
      }
      found = true
      conn.on('error', (err) => console.error(err))

      // resolves when the receiver confirms it got a valid token
      let onack
      const acked = new Promise((resolve) => {
        onack = resolve
      })

      const handle = openChannel(conn, {
        onack,
        onopen() {
          // return a method the caller can use to send a string payload then disconnect
          resolve(async (payload) => {
            handle.token.send(typeof payload === 'string' ? payload : payload.toString())
            // wait for the receiver's ACK before tearing the radio down, so we
            // know the token actually landed
            const ok = await Promise.race([
              acked,
              new Promise((r) => setTimeout(() => r(false), ACK_TIMEOUT))
            ])
            if (!ok) console.error('no ACK from receiver — token may not have been delivered')
            handle.channel.close()
            conn.end()
            shutdown()
            return ok === true
          })
        }
      })
    }

    swarm.on('connection', onconnection)
  })
}

// timeout = how much time to wait to receive token after incoming stream is established.
export async function receiveToken(timeout = 10000) {
  const swarm = await joinBluetoothSwarm()

  return new Promise((resolve, reject) => {
    function done(err, token) {
      console.error('shutting down ble-swarm')
      swarm.off('connection', onconnection)
      teardown(swarm)
      if (err) reject(err)
      else resolve(token)
    }

    function onconnection(conn) {
      console.error('incoming connection', conn.remotePublicKey.toString('hex'))
      conn.on('error', (err) => console.error(err))
      conn.setTimeout(timeout)

      const handle = openChannel(conn, {
        async ontoken(token) {
          console.error('received payload')
          try {
            // is the token valid?
            getTokenMetadata(token)
            console.error('Token is valid.')
          } catch (_) {
            console.error('Invalid token received!')
            return // no ACK: the sender keeps its proofs
          }
          handle.ack.send(true)
          // let the ACK actually leave the radio before tearing down
          await conn.flush().catch(() => {})
          handle.channel.close()
          conn.end()
          done(null, token)
        }
      })
    }

    swarm.on('connection', onconnection)
  })
}
