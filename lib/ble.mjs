import process from 'bare-process'
import crypto from 'hypercore-crypto'
import BluetoothSwarm from 'ble-swarm'

// every peer must derive the SAME topic; the service UUID is hashed from it
const topic = crypto.hash(Buffer.from('aleph-hackathon/v0/test'))

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

export async function sendToken(pubKey, payload, timeout) {
  // wait on users connecting, look at their public key over the stream
  // if they are a match send them the payload, (wait for confirmation they received it)?
  // then shutdown the swarm and return result.
  if (!swarm) {
    await joinBluetoothSwarm()
  }
  return new Promise((resolve, reject) => {
    // TODO: add timer to reject promise when we fail to find neighbour
    // so we can reclaim proofs. It might be wiser to not do any wallet.send operation until after we
    // find the neighbour to keep recovery from failure simpler
    swarm.on('connection', (conn) => {
      // conn is a NoiseSecretStream: publicKey, remotePublicKey, isInitiator.
      // Handshake done, duplicate links already deduped.
      console.log('connected to', conn.remotePublicKey)
      if (conn.publicKey === Buffer.from(pubKey, 'hex')) {
        conn.send(payload) // send an un-ordered message (we don't care only sending one)
        conn.end()
        swarm.stop()
        resolve()
      } else {
        conn.close()
      }
    })
  })
}

// timeout = how much time to wait to receive token after incmoing stream is established.
export async function receiveToken(timeout) {
  // for each incoming stream, read a JSON object (maxSize)
  // test parse if it is a valid token.
  // if it passes, respond with a thank you
  // destroy the stream and return the token.
  if (!swarm) {
    await joinBluetoothSwarm()
  }
  return new Promise((resolve, reject) => {
    swarm.on('connection', (conn) => {
      // conn is a NoiseSecretStream: publicKey, remotePublicKey, isInitiator.
      // Handshake done, duplicate links already deduped.
      conn.setTimeout(timeout)
      conn.on('message', (token) => {
        console.log(token)
        conn.end()
        // if the token is legit
        // resolve(token)
        // swarm.stop()
      })
    })
  })
}
