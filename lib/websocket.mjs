import { Socket } from 'bare-ws'
import { requestOptions } from './net.mjs'

// nostr-tools drives a browser WebSocket — an object with onopen/onmessage/onclose/onerror
// and a readyState — while bare-ws gives us a duplex stream where every 'data' event is one
// complete message. This is the whole adapter between them.
//
// Deliberately not `bare-ws/global`, which assigns that same duplex stream as `WebSocket`:
// it speaks the protocol but has none of the API, so assigning `onopen` to it would do
// nothing and every relay would hang until its timeout instead of failing.
//
// Just as deliberately not assigned to globalThis. Both coco and cashu-ts feature-detect a
// global WebSocket and, finding one, run NUT-17 mint subscriptions over it instead of
// polling — on this class, which is shaped for nostr relays and reports every close as
// abnormal. It is handed to the relay pool by name and reaches nothing else.
export class BareWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  onopen = null
  onmessage = null
  onerror = null
  onclose = null

  constructor(url) {
    this.url = url
    // A relay is a TCP connection like a mint's, so the same policy decides it. The agent
    // comes from lib/net.mjs, which picks by scheme rather than by what is at the far end:
    // wss: takes the proxy a mint's https: takes, ws: the one http: takes — which the
    // environment may set to two different proxies. bare-ws hands its options straight to
    // bare-http1, which is where an agent belongs.
    this.readyState = BareWebSocket.CONNECTING
    // The 'error' listener is not optional: an unhandled stream error would take the run
    // down instead of costing us one relay.
    this.socket = new Socket(url, requestOptions(url))
      .on('open', () => {
        this.readyState = BareWebSocket.OPEN
        this.onopen?.()
      })
      .on('data', (data) => this.onmessage?.({ data: data.toString() }))
      .on('error', (err) => this.onerror?.(err))
      .on('close', () => {
        this.readyState = BareWebSocket.CLOSED
        this.onclose?.({ code: 1006, reason: '' })
      })
  }

  send(data) {
    // bare-ws only takes 'buffer' or 'utf8': a string written as utf8 becomes a TEXT frame.
    this.socket.write(data, 'utf8')
  }

  close() {
    this.readyState = BareWebSocket.CLOSING
    this.socket.destroy()
  }
}
