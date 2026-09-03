// HTTP CONNECT (RFC 9110 §9.3.6) for Bare, as http agents bare-fetch and bare-ws can be
// handed. Named for what Node's https-proxy-agent does: ask an http proxy for a tunnel and
// speak to the target through it.
//
// Both http:// and https:// targets can go through the tunnel, which is why there are two
// agents here — Node's HttpsProxyAgent covers both in one class by reading the endpoint's
// protocol off `opts.secureEndpoint`, and bare-http1 tells an agent no such thing. What a
// tunnel to an http:// target is *for* is the other package's business: bare-http-proxy-agent
// forwards those instead, which is what Node's http-proxy-agent does and what a proxy that
// only allows CONNECT to port 443 will accept. Use this pair's http agent when the tunnel is
// wanted for an http:// target specifically.
//
// An `https://` proxy url means the first hop is itself TLS — the request head below,
// including any Proxy-Authorization, is then encrypted to the proxy rather than sent in the
// clear. The tunnel inside it is unchanged.
//
// The socket, the agents and the error type are bare-proxy-agent's; this is the handshake.
import {
  ProxyError,
  ProxyHTTPAgent,
  ProxyHTTPSAgent,
  Reader,
  authority,
  hasCredentials,
  parseProxyUrl,
  proxyErrorIn,
  proxyName
} from 'bare-proxy-agent'

// Where a CONNECT proxy listens when the url names no port.
export const PORTS = { 'http:': 8080, 'https:': 443 }

export function parse(url) {
  const proxy = parseProxyUrl(url, PORTS)
  // The one thing the base cannot work out for itself: whether to reach the proxy over TLS.
  proxy.secure = proxy.protocol === 'https:'
  return proxy
}

// Ask for a tunnel; everything after the blank line is the target's. Nothing is sent beyond
// what the method needs — no user agent, no cookies — since the proxy is the one hop that
// sees these headers rather than the ciphertext inside them.
export async function handshake({ socket, reader, proxy, target, headers }) {
  const name = proxyName(proxy)
  const to = authority(target)

  let head = `CONNECT ${to} HTTP/1.1\r\nHost: ${to}\r\n`
  if (hasCredentials(proxy)) {
    const credentials = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')
    head += `Proxy-Authorization: Basic ${credentials}\r\n`
  }
  // Anything the caller wants the proxy to see, as https-proxy-agent's `headers` does. The
  // proxy is the one hop reading these, so nothing is added here that was not asked for.
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value !== undefined && value !== null) head += `${name}: ${value}\r\n`
  }
  socket.write(`${head}\r\n`)

  const response = (await reader.until('\r\n\r\n')).toString()
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(response)?.[1])
  if (!status) throw new ProxyError(`${name} answered a CONNECT with something that is not HTTP`)
  if (status === 407) {
    throw new ProxyError(
      `${name} wants authentication — put a username and password in the proxy url`
    )
  }
  if (status !== 200) throw new ProxyError(`${name} refused a tunnel to ${to}: HTTP ${status}`)
}

function tunnel(proxy) {
  const parsed = typeof proxy === 'object' && proxy !== null && !isURL(proxy) ? proxy : parse(proxy)
  return { proxy: parsed, handshake }
}

function isURL(value) {
  return typeof value.href === 'string' && typeof value.protocol === 'string'
}

// Headers may be given as an object or as a function called per tunnel, which is how
// https-proxy-agent takes them.
function headersOf(headers) {
  return typeof headers === 'function' ? headers() : headers
}

// The schemes these agents speak. The same pair https-proxy-agent lists, and for the same
// reason: an https:// url is a proxy reached over TLS, not a target.
const PROTOCOLS = ['http', 'https']

// For http:// targets.
export class HttpsProxyHTTPAgent extends ProxyHTTPAgent {
  static protocols = PROTOCOLS

  constructor(proxy, opts = {}) {
    super(tunnel(proxy), opts)
    this.proxyHeaders = opts.headers ?? {}
  }

  // Read per connection, so headers given as a function are called per tunnel rather than
  // once at construction.
  get tunnel() {
    const headers = headersOf(this.proxyHeaders)
    return { ...this._tunnel, handshake: (args) => handshake({ ...args, headers }) }
  }
}

// For https:// targets: the same tunnel, with TLS to the target negotiated inside it.
export class HttpsProxyHTTPSAgent extends ProxyHTTPSAgent {
  static protocols = PROTOCOLS

  constructor(proxy, opts = {}) {
    super(tunnel(proxy), opts)
    this.proxyHeaders = opts.headers ?? {}
  }

  get tunnel() {
    const headers = headersOf(this.proxyHeaders)
    return { ...this._tunnel, handshake: (args) => handshake({ ...args, headers }) }
  }
}

// Both at once, which is what a program routing all of its traffic wants.
export function createAgents(proxy, opts) {
  return {
    http: new HttpsProxyHTTPAgent(proxy, opts),
    https: new HttpsProxyHTTPSAgent(proxy, opts)
  }
}

export { ProxyError, proxyErrorIn, Reader }
