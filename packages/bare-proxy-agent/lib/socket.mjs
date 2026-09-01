import { Duplex } from 'bare-stream'
import tcp from 'bare-tcp'
import tls from 'bare-tls'
import { ProxyError } from './errors.mjs'
import { Reader } from './reader.mjs'
import { proxyName } from './url.mjs'

// How long the proxy has to answer its own handshake. When tunneling it takes
// seconds; a port that is listening but is not a proxy answers nothing at all, and without
// this the request would wait there rather than say so.
const HANDSHAKE_TIMEOUT = 30000

// A connection to `target` that runs through `proxy`.
//
// Duplex rather than a wrapper around a connected socket, because an http agent asks for a
// connection and gets one back on the spot, while a proxy handshake takes round trips.
// Writes made before it finishes are held by the stream and go out after — which is what
// lets a TLS socket be layered straight on top of one of these: its ClientHello is written
// during construction and leaves once the tunnel is open.
//
// The handshake itself is not this class's business. `handshake` is called once, with the
// socket to the proxy and a Reader over it, and either resolves — the tunnel is open, and
// everything after belongs to the target — or throws a ProxyError saying why not.
export class ProxySocket extends Duplex {
  constructor({ proxy, handshake, timeout = HANDSHAKE_TIMEOUT }, opts = {}) {
    super({ eagerOpen: true })

    this._proxy = proxy
    this._handshake = handshake
    this._handshakeTimeout = timeout
    this._target = { host: opts.host, port: opts.port }
    this._socket = null
    this._timer = null

    // Held until there is a socket to apply them to: an agent sets keep-alive and unrefs a
    // connection it is done with, both of which may happen mid-handshake.
    this._keepAlive = null
    this._noDelay = false
    this._timeout = 0
    this._unrefed = false
  }

  get proxy() {
    return this._proxy
  }

  get target() {
    return this._target
  }

  get remoteAddress() {
    // The far end of our socket is the proxy, and saying so is more honest than reporting
    // a target we never opened a socket to.
    return this._socket?.remoteAddress
  }

  get remotePort() {
    return this._socket?.remotePort
  }

  _open(cb) {
    let settled = false
    const done = (err) => {
      if (settled) return
      settled = true
      clearTimeout(this._timer)
      this._timer = null
      cb(err)
    }

    this._timer = setTimeout(() => {
      const seconds = this._handshakeTimeout / 1000
      done(
        new ProxyError(
          `${proxyName(this._proxy)} did not answer within ${seconds}s — is it a proxy?`
        )
      )
      // cb(err) destroys the stream, and _destroy below brings the socket down with it.
    }, this._handshakeTimeout)

    this._connect().then(() => done(null), done)
  }

  async _connect() {
    const proxy = this._proxy
    const raw = tcp.createConnection({ host: proxy.host, port: proxy.port, noDelay: true })

    // The socket the handshake is spoken on: the tcp connection, or TLS to the proxy over
    // it when the proxy url said so.
    this._socket = proxy.secure ? new tls.Socket(raw, { host: proxy.host }) : raw

    const reader = new Reader(this._socket, proxy)
    try {
      await this._handshake({ socket: this._socket, reader, proxy, target: this._target })
    } catch (err) {
      reader.release()
      this._socket.destroy()
      throw err
    }

    // Anything the target has already said arrives in the same read as the end of the
    // handshake, so it is taken off the reader rather than lost with it.
    const spare = reader.release()

    this._apply()
    this._attach()
    if (spare.byteLength > 0) this.push(spare)
  }

  // Settings an agent made while there was no socket to make them on.
  _apply() {
    if (this._keepAlive) this._socket.setKeepAlive(...this._keepAlive)
    if (this._noDelay) this._socket.setNoDelay(true)
    if (this._timeout) this._socket.setTimeout(this._timeout)
    if (this._unrefed) this._socket.unref()
  }

  _attach() {
    this._socket
      .on('data', (data) => {
        if (!this.push(data)) this._socket.pause()
      })
      .on('end', () => this.push(null))
      .on('timeout', () => this.emit('timeout'))
      .on('error', (err) => this.destroy(err))
      .on('close', () => this.destroy())
  }

  _read() {
    this._socket?.resume()
  }

  _write(data, encoding, cb) {
    if (this._socket.write(data)) cb(null)
    else this._socket.once('drain', () => cb(null))
  }

  _final(cb) {
    this._socket.end()
    cb(null)
  }

  _predestroy() {
    clearTimeout(this._timer)
    this._timer = null
    this._socket?.destroy()
  }

  _destroy(err, cb) {
    clearTimeout(this._timer)
    this._timer = null
    this._socket?.destroy()
    cb(err)
  }

  // The rest is what bare-http1 expects of a socket it was handed. Each one is remembered
  // as well as forwarded, since the agent may call it before the tunnel exists.
  setKeepAlive(enable = false, delay = 0) {
    this._keepAlive = [enable, delay]
    this._socket?.setKeepAlive(enable, delay)
    return this
  }

  setNoDelay(enable = true) {
    this._noDelay = enable
    this._socket?.setNoDelay(enable)
    return this
  }

  setTimeout(ms, ontimeout) {
    if (ontimeout) this.once('timeout', ontimeout)
    this._timeout = ms
    this._socket?.setTimeout(ms)
    return this
  }

  ref() {
    this._unrefed = false
    this._socket?.ref()
    return this
  }

  unref() {
    this._unrefed = true
    this._socket?.unref()
    return this
  }
}
