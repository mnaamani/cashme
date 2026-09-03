// The frames a token travels in, and the handshake around them, independent of what
// carries the bytes. Both transports — lib/ble.mjs over a radio link, lib/dht.mjs over the
// hyperdht — open this same channel on a NoiseSecretStream, so a token sent over one is
// byte-for-byte the token sent over the other.
//
// The exchange, in full:
//
//   sender                    receiver
//     token  ------------------>
//            <------------------  ack(true)      the token parsed; proofs are theirs now
//     close  ------------------>                 our ack reached them, let go
//            <------------------  hangup
//
// Every step is a frame the peer could only have sent after ours arrived, because there is
// no usable flush(): NoiseSecretStream.flush() only proves bytes reached the transport's
// write queue, and tearing the transport down destroys that queue outright (which BLE does
// on close, see lib/ble.mjs). So neither side ever hangs up on its own timing.
import './polyfills.mjs'
import Protomux from 'protomux'
import c from 'compact-encoding'
import { getTokenMetadata } from '@cashu/coco-core'
import { note } from './notes.mjs'

const PROTOCOL = 'cashme/token/v0'

// How long the sender waits for the receiver's durable receipt before giving up. Receiving
// can include a mint request, so this is deliberately longer than the old parse-only ACK.
export const ACK_TIMEOUT = 60000

// how long each side waits for the other's goodbye before forcing the link down
export const HANGUP_TIMEOUT = 5000

export function withTimeout(promise, ms, value) {
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

// Resolves when the link goes down. NOT a FIN: over BLE, conn.end() puts nothing on the
// wire — NoiseSecretStream._final just calls end() on the L2CAP stream, which has no
// _final. A cleanup signal, never delivery proof.
export function linkDown(conn) {
  return new Promise((resolve) => {
    conn.on('close', () => resolve())
    conn.on('end', () => resolve())
    conn.on('error', () => resolve())
  })
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

// The sending half of one link. Resolves, once the peer has the channel open, to a
// function that sends one token and resolves to whether the receiver acknowledged it.
//
// `onopen` runs the moment the channel opens, before the caller is handed anything — the
// transports use it to mark the link as committed, so a cancellation arriving now does not
// tear down a handover already under way. `after` runs once the link is down, which is
// where a transport brings its radio or its node down. `trace` logs each step of the
// exchange to the transport's own debug channel.
export function senderChannel(conn, { onopen, after, trace = noop } = {}) {
  return new Promise((resolve) => {
    // resolves when the receiver confirms it got a valid token
    let onack
    const acked = new Promise((r) => {
      onack = r
    })

    const handle = openChannel(conn, {
      onack,
      onopen() {
        if (onopen) onopen()
        resolve(async (payload) => {
          // Every step is timed: each ends in either a handshake with the peer or a
          // timeout, so a `give` that will not exit is read off the last step logged.
          const startedAt = Date.now()
          const step = (what) => trace(`${what} +${Date.now() - startedAt}ms`)

          handle.token.send(typeof payload === 'string' ? payload : payload.toString())
          step('token sent')
          // the ACK is how we know the token landed, so wait for it
          const ok = await withTimeout(acked, ACK_TIMEOUT, false)
          step(ok ? 'ack received' : 'ack timed out')
          if (!ok) note('no ACK from receiver — token may not have been delivered')
          // protomux close() writes a real CLOSE frame, and we only reach here after the
          // ACK — so it tells the receiver its ACK landed, which is its cue to let go.
          handle.channel.close()
          conn.end()
          // let the receiver drop the link: tearing ours down first would take that CLOSE
          // frame with it, still queued
          await withTimeout(linkDown(conn), HANGUP_TIMEOUT, undefined)
          step('link down')
          if (after) await after()
          step('transport down')
          return ok === true
        })
      }
    })
  })
}

// The receiving half of one link: validate a token, hand it to `ontoken`, then ACK only
// after that promise resolves. `ontoken` is the durable receipt: for the wallet it resolves
// only once the token has been written to disk. This is intentionally before the sender can
// finalize their send — a parsed string in process memory is not a safe copy of bearer cash.
export function receiverChannel(conn, { ontoken }) {
  // the sender closes only after our ACK reaches it, so its CLOSE frame is our delivery
  // receipt
  let onackdelivered
  const ackDelivered = new Promise((resolve) => {
    onackdelivered = resolve
  })

  const handle = openChannel(conn, {
    onclose(isRemote) {
      if (isRemote) onackdelivered(true)
    },
    async ontoken(token) {
      try {
        // is the token valid?
        getTokenMetadata(token)
      } catch (_) {
        note('Invalid token received!')
        return // no ACK: the sender keeps its proofs
      }
      try {
        await ontoken(token)
      } catch (err) {
        // No durable receipt means no ACK. The sender will retain or reclaim its proofs,
        // rather than finalizing a send based on a token this wallet did not keep.
        note('[app:error] could not receive that token; sender was not acknowledged:', err.message)
        conn.destroy()
        return
      }
      handle.ack.send(true)

      // Do NOT tear the transport down here: with no usable flush(), doing so destroys the
      // channel with the ACK still inside it. Holding the link open until the sender
      // confirms is what lets it drain.
      const delivered = await withTimeout(
        Promise.race([ackDelivered, linkDown(conn).then(() => false)]),
        HANGUP_TIMEOUT,
        false
      )
      if (!delivered) note('sender never acknowledged our ACK')
      // we hang up first, since the sender waits on the link dropping. Only this link:
      // whatever we are listening on stays up for whoever comes next.
      conn.destroy()
    }
  })
}

// One token at a time: coco serialises its own work, but a queue preserves arrival order
// and stops one slow mint interleaving two receives. A throwing handler rejects that
// token's receipt (so its sender is not acknowledged), while the queue itself recovers for
// the next neighbour.
export function tokenQueue(ontoken) {
  let queue = Promise.resolve()
  return {
    enqueue(token) {
      const receipt = queue.then(() => ontoken(token))
      // Keep the next token independent, but hand this one’s failure back to its wire so it
      // can withhold the ACK. Swallowing here would falsely say the wallet has the token.
      queue = receipt.catch(() => {})
      return receipt
    },
    drained: () => queue
  }
}

function noop() {}
