import './polyfills.mjs'
import process from 'bare-process'
import crypto from 'hypercore-crypto'
import BluetoothSwarm from 'ble-swarm'
import Protomux from 'protomux'
import c from 'compact-encoding'
import { getTokenMetadata } from '@cashu/cashu-ts'

// every peer must derive the SAME topic; the service UUID is hashed from it
const topic = crypto.hash(Buffer.from('aleph-hackathon/v0/test'))

const PROTOCOL = 'cashme/token/v0'

let swarm

async function joinBluetoothSwarm() {
  const keyPair = crypto.keyPair()
  swarm = new BluetoothSwarm({
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
  console.log('joined BLE swarm, our publickKey:', keyPair.publicKey.toString('hex'))
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

export async function sendToken(pubKey, payload, timeout = 60000) {
  if (!swarm) {
    await joinBluetoothSwarm()
  }
  return new Promise((resolve, reject) => {
    console.log('looking for', pubKey, 'over BLE')

    const timer = setTimeout(() => done(new Error('timed out looking for ' + pubKey)), timeout)

    function done(err) {
      clearTimeout(timer)
      swarm.off('connection', onconnection)
      swarm.stop().catch((err) => console.log(err))
      if (err) reject(err)
      else resolve()
    }

    function onconnection(conn) {
      // conn is a NoiseSecretStream: publicKey, remotePublicKey, isInitiator.
      // Handshake done, duplicate links already deduped.
      const neighbour = conn.remotePublicKey.toString('hex')
      console.log('connected to', neighbour)
      if (!neighbour.startsWith(pubKey)) {
        console.log('not who we are looking for')
        conn.destroy()
        return
      }
      conn.on('error', (err) => console.log(err))

      const handle = openChannel(conn, {
        onopen() {
          console.log('sending payload')
          handle.token.send(typeof payload === 'string' ? payload : payload.toString())
          console.log('payload sent')
          conn.end() // flush
          // only tear down the swarm once the stream is actually closed
          conn.once('close', () => done(null))
        }
      })
    }

    swarm.on('connection', onconnection)
  })
}

// timeout = how much time to wait to receive token after incoming stream is established.
export async function receiveToken(timeout = 20000) {
  if (!swarm) {
    await joinBluetoothSwarm()
  }
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

      openChannel(conn, {
        // onopen(_handshake, channel) {
        //   console.log('channel opened')
        // },
        ontoken(tokenString) {
          console.log('got message', tokenString.length, 'chars')
          conn.end()
          // validate/parse the token here and destroy + keep listening if bogus
          try {
            getTokenMetadata(tokenString)
            done(null, tokenString)
          } catch (_) {
            console.log('Invalid token received')
          }
        }
      })
    }

    swarm.on('connection', onconnection)
  })
}
