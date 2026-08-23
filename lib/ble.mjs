import process from 'bare-process'
import crypto from 'hypercore-crypto'
import BluetoothSwarm from 'ble-swarm'
import Protomux from 'protomux'
import c from 'compact-encoding'

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
  const token = channel.addMessage({ encoding: c.buffer, onmessage: handlers.ontoken })
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
      swarm.stop().catch(() => {})
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

      openChannel(conn, {
        onopen(_handshake, channel) {
          console.log('sending payload')
          channel.messages[0].send(Buffer.isBuffer(payload) ? payload : Buffer.from(payload))
          console.log('payload sent')
          conn.end()
          done(null)
        }
      })
    }

    swarm.on('connection', onconnection)
  })
}

// timeout = how much time to wait to receive token after incoming stream is established.
export async function receiveToken(timeout = 5000) {
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
        ontoken(msg) {
          console.log('got message', msg.byteLength, 'bytes')
          conn.end()
          // TODO: validate/parse the token here and destroy + keep listening if bogus
          done(null, msg)
        }
      })
    }

    swarm.on('connection', onconnection)
  })
}
