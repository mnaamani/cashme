import http from 'bare-http1'
import tls from 'bare-tls'
import { ProxyError } from './errors.mjs'
import { ProxySocket } from './socket.mjs'
import { proxyName } from './url.mjs'

// An agent is where bare-http1 gets its connections, and bare-fetch and bare-ws both take
// one — so a pair of these is the whole of routing a program's traffic through a proxy.
//
// Keep-alive is on for the same reason it is on bare's own agents, and matters more here: a
// reused tunnel is a handshake, that is not built again.
export class ProxyHTTPAgent extends http.Agent {
  // What Node's proxy agents carry, so code can ask an agent what it speaks. Filled in by
  // the packages that know: ['socks5', 'socks5h'], ['http', 'https'].
  static protocols = []

  constructor(tunnel, opts = {}) {
    // `handshakeTimeout` is ours and stops here — everything else is bare-http1's, and it
    // copies its options onto every request's connection.
    //
    // `host`, `port` and `path` are dropped on the way, because that copy is a merge in
    // which the agent's options *win*: bare-http1's addRequest does `{ ...opts, ...agentOpts }`,
    // so one of these left on an agent by mistake would silently redirect every request it
    // ever carries to somewhere the caller never named. Nothing else here is load-bearing
    // enough to be worth that.
    const { handshakeTimeout, host, port, path, ...agentOpts } = opts
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

  // Whether what this agent opens carries the request as it stands, with no TLS of its own.
  // True here and false on ProxyHTTPSAgent, which is what makes the guard below the base's
  // business rather than any one protocol's.
  _plaintext = true

  // What a connection is opened with. A getter so a subclass can fold in something that may
  // change between requests — bare-https-proxy-agent's `proxyHeaders` is the case in point.
  // A subclass that overrides this must build on `super.tunnel` rather than on `_tunnel`, or
  // it drops the guard.
  get tunnel() {
    const tunnel = this._tunnel
    if (!this._plaintext) return tunnel
    return {
      ...tunnel,
      handshake: (args) => {
        refuseSecretsInTheClear(args)
        return tunnel.handshake(args)
      }
    }
  }

  createConnection(opts) {
    return new ProxySocket(this.tunnel, opts)
  }
}

// A request this agent is given is written to whatever the handshake opened, with nothing
// negotiated on top — so port 443 means an https: target has reached the agent built for
// http:, and carrying it would send in the clear what was asked for in confidence.
//
// The way that happens is a redirect. bare-fetch follows them itself and keeps, for every
// hop, the agent it was handed; but an agent under bare-http1 *is* the scheme, since it is
// the thing that decides whether TLS runs. So an http: url that redirects to an https: one
// arrives here. Refused, and refused from the handshake rather than from createConnection:
// ProxySocket turns a throw here into a failed connection, which the request reports, while
// a throw from createConnection comes out of the ClientRequest constructor, where bare-fetch
// does not catch it.
function refuseSecretsInTheClear({ proxy, target }) {
  if (Number(target.port) !== 443) return
  throw new ProxyError(
    `${proxyName(proxy)} was asked to carry a plain http request to port 443 of ` +
      `${target.host} — an https: target needs the https agent, which is the one that runs TLS`
  )
}

export class ProxyHTTPSAgent extends ProxyHTTPAgent {
  _plaintext = false

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
