import './polyfills.mjs'
import process from 'bare-process'
import crypto from 'hypercore-crypto'
import BluetoothSwarm from 'ble-swarm'
import Protomux from 'protomux'
import c from 'compact-encoding'
import { getTokenMetadata } from '@cashu/cashu-ts'

// every peer must derive the SAME topic; the service UUID is hashed from it
const topicName = 'aleph-hackathon/v0/test'
const topic = crypto.hash(Buffer.from(topicName))

const PROTOCOL = 'cashme/token/v0'

async function joinBluetoothSwarm() {
  const keyPair = crypto.keyPair()
  const swarm = new BluetoothSwarm({
    keyPair,
    topic,
    online: false // be aggressive to find peers
  })
  if (!swarm.supported) {
    console.error('Bluetooth (BLE) unsupported on this runtime')
    process.exit(1)
  }
  await swarm.start()
  // return our public key so it can be shared with the neighbour in person
  console.log(
    'joined BLE swarm, our publickKey:',
    keyPair.publicKey.toString('hex'),
    'topic:',
    topicName
  )
  return swarm
}

function openChannel(conn, handlers) {
  const mux = Protomux.from(conn)
  const channel = mux.createChannel({
    protocol: PROTOCOL,
    onopen: handlers.onopen,
    onclose: handlers.onclose
  })
  const token = channel.addMessage({ encoding: c.utf8, onmessage: handlers.ontoken })
  channel.open()
  return { channel, token }
}

// return a function which can be used to send a payload to the neighbour when found
export async function findNeighbour(pubKey) {
  const swarm = await joinBluetoothSwarm()

  return new Promise((resolve, reject) => {
    console.log('looking for', pubKey, 'over BLE')
    let found = false

    function shutdown() {
      swarm.off('connection', onconnection)
      swarm.stop().catch((err) => console.log(err))
    }

    function onconnection(conn) {
      // conn is a NoiseSecretStream: publicKey, remotePublicKey, isInitiator.
      // Handshake done, duplicate links already deduped.
      const neighbour = conn.remotePublicKey.toString('hex')
      console.log('connected to', neighbour)
      if (!neighbour.startsWith(pubKey) || found) {
        conn.destroy()
        return
      }
      found = true
      conn.on('error', (err) => console.log(err))

      const handle = openChannel(conn, {
        onopen() {
          // return a method the caller can use to send a string payload then disconnect
          resolve((payload) => {
            handle.token.send(typeof payload === 'string' ? payload : payload.toString())
            conn.end() // flush
            // only tear down the swarm once the stream is actually closed
            conn.once('close', () => {
              handle.destroy()
              shutdown()
            })
          })
        }
      })
    }

    swarm.on('connection', onconnection)
  })
}

// timeout = how much time to wait to receive token after incoming stream is established.
export async function receiveToken(timeout = 20000) {
  const swarm = await joinBluetoothSwarm()

  return new Promise((resolve, reject) => {
    function done(err, token) {
      swarm.off('connection', onconnection)
      swarm.stop().catch(() => {})
      if (err) reject(err)
      else resolve(token)
    }

    function onconnection(conn) {
      console.log('incoming connection', conn.remotePublicKey.toString('hex'))
      conn.on('error', (err) => console.log(err))
      conn.setTimeout(timeout)

      const handle = openChannel(conn, {
        ontoken(token) {
          console.log('received payload:', token)
          conn.end()
          try {
            // is the token valid?
            getTokenMetadata(token)
            console.log('Token is valid.')
            handle.destroy()
            done(null, token)
          } catch (_) {
            console.log('Invalid token received!')
          }
        }
      })
    }

    swarm.on('connection', onconnection)
  })
}
