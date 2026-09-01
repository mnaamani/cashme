import { ProxyError } from './errors.mjs'
import { proxyName } from './url.mjs'

// Reads exact counts out of a socket while a handshake is being spoken, and hands back
// whatever is left over when it is done. Only one read is outstanding at a time — a
// handshake is a conversation — so a single pending request is all this holds.
export class Reader {
  constructor(socket, proxy) {
    this._socket = socket
    this._proxy = proxy
    this._buffer = Buffer.alloc(0)
    this._pending = null
    this._error = null
    this._ended = false

    this._ondata = (data) => {
      this._buffer = Buffer.concat([this._buffer, data])
      this._settle()
    }
    this._onerror = (err) => {
      this._error = err
      this._settle()
    }
    this._onend = () => {
      this._ended = true
      this._settle()
    }

    socket.on('data', this._ondata).on('error', this._onerror).on('end', this._onend)
  }

  // Exactly `n` bytes.
  read(n) {
    return this._want({ n })
  }

  // Everything up to and including `delimiter`, which is how an http response head ends.
  until(delimiter) {
    return this._want({ delimiter: Buffer.from(delimiter) })
  }

  // Anything read past the end of the handshake, which belongs to the target and must not
  // be lost with the reader.
  release() {
    this._socket.off('data', this._ondata).off('error', this._onerror).off('end', this._onend)
    this._pending = null
    return this._buffer
  }

  _want(request) {
    return new Promise((resolve, reject) => {
      this._pending = { ...request, resolve, reject }
      this._settle()
    })
  }

  _settle() {
    const pending = this._pending
    if (!pending) return

    const upto = pending.delimiter
      ? indexOfEnd(this._buffer, pending.delimiter)
      : this._buffer.byteLength >= pending.n
        ? pending.n
        : -1

    if (upto !== -1) {
      this._pending = null
      const out = this._buffer.subarray(0, upto)
      this._buffer = this._buffer.subarray(upto)
      pending.resolve(out)
      return
    }

    if (this._error || this._ended) {
      this._pending = null
      const name = proxyName(this._proxy)
      pending.reject(
        this._error
          ? new ProxyError(`could not reach the proxy at ${name}: ${this._error.message}`)
          : new ProxyError(`${name} closed the connection in the middle of its handshake`)
      )
    }
  }
}

// Where `delimiter` ends in `buffer`, or -1.
function indexOfEnd(buffer, delimiter) {
  const at = buffer.indexOf(delimiter)
  return at === -1 ? -1 : at + delimiter.byteLength
}
