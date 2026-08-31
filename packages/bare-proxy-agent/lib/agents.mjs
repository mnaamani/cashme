import http from 'bare-http1'
import tls from 'bare-tls'
import { ProxySocket } from './socket.mjs'
import { proxyName } from './url.mjs'

// An agent is where bare-http1 gets its connections, and bare-fetch and bare-ws both take
// one — so a pair of these is the whole of routing a program's traffic through a proxy.
//
// Keep-alive is on for the same reason it is on bare's own agents, and matters more here: a
// reused tunnel is a handshake, and with Tor a circuit, that is not built again.
export class ProxyHTTPAgent extends http.Agent {
  // What Node's proxy agents carry, so code can ask an agent what it speaks. Filled in by
  // the packages that know: ['socks5', 'socks5h'], ['http', 'https'].
  static protocols = []

  constructor(tunnel, opts = {}) {
    // `handshakeTimeout` is ours and stops here — everything else is bare-http1's, and it
    // copies its options onto every request's connection.
    const { handshakeTimeout, ...agentOpts } = opts
    super({ keepAlive: 1000, timeout: 5000, ...agentOpts })
    this._tunnel = handshakeTimeout ? { ...tunnel, timeout: handshakeTimeout } : tunnel
  }

  // The proxy as its package parsed it, and the address it was configured with. Named after
  // socks-proxy-agent's pair, which is the closest thing Node has to a convention.
  get proxy() {
    return this._tunnel.proxy
  }

  get proxyUrl() {
    return proxyName(this._tunnel.proxy)
  }

  // What a connection is opened with. A getter so a subclass can fold in something that may
  // change between requests — bare-https-proxy-agent's `proxyHeaders` is the case in point.
  get tunnel() {
    return this._tunnel
  }

  createConnection(opts) {
    return new ProxySocket(this.tunnel, opts)
  }
}

export class ProxyHTTPSAgent extends ProxyHTTPAgent {
  constructor(tunnel, opts) {
    super(tunnel, { defaultPort: 443, ...opts })
  }

  createConnection(opts) {
    // `opts.host` is the target, so the certificate is checked against the host that was
    // asked for and not against the proxy that carried the bytes.
    return new SecureProxySocket(super.createConnection(opts), opts)
  }
}

// What bare-https wraps its own sockets in, which its exports do not reach: a TLS socket
// that passes the socket-level calls an http agent makes down to the connection underneath.
class SecureProxySocket extends tls.Socket {
  setKeepAlive(...args) {
    this.socket.setKeepAlive(...args)
    return this
  }

  setNoDelay(...args) {
    this.socket.setNoDelay(...args)
    return this
  }

  setTimeout(...args) {
    this.socket.setTimeout(...args)
    return this
  }

  ref() {
    this.socket.ref()
    return this
  }

  unref() {
    this.socket.unref()
    return this
  }
}

// The pair a caller usually wants: one agent for http urls, one for https, both tunnelling
// through the same proxy. `tunnel` is `{ proxy, handshake }` — what ProxySocket takes.
export function createAgents(tunnel, opts) {
  return { http: new ProxyHTTPAgent(tunnel, opts), https: new ProxyHTTPSAgent(tunnel, opts) }
}
