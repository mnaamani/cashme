// Forwarding through an http proxy for Bare, as an http agent bare-fetch and bare-ws can be
// handed. Node's http-proxy-agent, and the same half of the job: the request goes to the
// proxy with the whole url in the request line — `GET http://mint.example/v1/info HTTP/1.1`,
// what RFC 9112 §3.2.2 calls absolute-form — and the proxy makes the request onwards.
//
// The other half is bare-https-proxy-agent, which asks the proxy for a tunnel with CONNECT
// instead. The split is worth keeping for the same reason Node keeps it: forwarding is the
// form every http proxy must accept, while a proxy configured to allow CONNECT to port 443
// only — a common Squid default — will refuse a tunnel to port 80 and forward this happily.
//
// http:// targets only, exactly as Node's http-proxy-agent. The proxy makes the request, so
// there is no end-to-end connection for TLS to run over and nothing here for an https://
// target to use; bare-https-proxy-agent's tunnel is what leaves TLS to the target intact.
//
// An `https://` proxy url means the first hop is itself TLS, so the request — and any
// Proxy-Authorization on it — is encrypted to the proxy rather than sent in the clear. What
// the proxy does onwards is unchanged, and it still reads the whole request.
//
// The socket, the agent base and the error type are bare-proxy-agent's.
import {
  ProxyError,
  ProxyHTTPAgent,
  hasCredentials,
  parseProxyUrl,
  proxyErrorIn
} from 'bare-proxy-agent'

// The schemes a proxy url may be written with. It is the proxy url being read here, not
// the target's, so an https:// one is a proxy reached over TLS. No default port goes with
// them: a port-less proxy url is refused rather than read as 80 or 443, which is what
// http-proxy-agent reads it as — see parseProxyUrl.
export const SCHEMES = ['http:', 'https:']

export function parse(url) {
  const proxy = parseProxyUrl(url, SCHEMES)
  // The one thing the base cannot work out for itself: whether to reach the proxy over TLS.
  proxy.secure = proxy.protocol === 'https:'
  return proxy
}

// There is no handshake to speak here — the connection to the proxy is the connection, and
// the request itself is what says where it is going. ProxySocket takes one anyway, and this
// is it: what it buys is TLS to the proxy for an https:// proxy url, and the socket calls
// bare-http1 makes on a connection that is still opening. ProxyHTTPAgent wraps it with the
// one refusal every plaintext proxy agent shares — an https: target that reached the agent
// built for http: — so there is nothing left for this one to do.
//
// It also means the handshake timeout has nothing to time out. That is right rather than
// missing: a forwarding proxy says nothing until it has answered the request, so a proxy
// that is listening and not answering is the request's own timeout to report, not ours.
//
// Nothing to await: ProxySocket awaits whatever this returns, and there is nothing to wait
// for.
function connected() {}

function forward(proxy) {
  const parsed = typeof proxy === 'object' && proxy !== null && !isURL(proxy) ? proxy : parse(proxy)
  return { proxy: parsed, handshake: connected }
}

function isURL(value) {
  return typeof value.href === 'string' && typeof value.protocol === 'string'
}

// The schemes this agent speaks. The same pair http-proxy-agent lists, and for the same
// reason: an https:// url is a proxy reached over TLS, not a target.
const PROTOCOLS = ['http', 'https']

export class HttpProxyAgent extends ProxyHTTPAgent {
  static protocols = PROTOCOLS

  constructor(proxy, opts = {}) {
    super(forward(proxy), opts)
    // As http-proxy-agent's: an object, or a function called per request.
    this.proxyHeaders = opts.headers ?? {}
  }

  // Where the request-line rewrite goes in, since it is the only place an agent is handed
  // the request at all.
  //
  // http-proxy-agent does the rewrite here too, by assigning `req.path` and calling
  // `req.setHeader`. That cannot work as it stands under bare-http1: this is called from
  // the ClientRequest constructor *before* it assigns `_path` and `_headers`, so anything
  // written to them here is overwritten a line later. So the rewrite is deferred to the one
  // point where the request line is actually made — `_header()`, called once when the
  // headers are flushed — by shadowing that method on this request. Same edit, same values,
  // applied later than Node applies it.
  addRequest(req, opts) {
    super.addRequest(req, opts)

    const agent = this
    const inherited = req._header
    let rewritten = false

    req._header = function () {
      // A flag rather than http-proxy-agent's test for `://` in the path. That test asks
      // whether the path is already absolute, and answers yes for any path that merely
      // contains a url — `/callback?to=https://example.com`, which is what half of lnurl
      // looks like. The request then goes to the proxy in origin-form, with no
      // Proxy-Authorization on it, and the proxy reads it as a request for itself.
      if (!rewritten) {
        rewritten = true
        this._path = absolute(this, opts)

        for (const [name, value] of Object.entries(agent._headersFor())) {
          if (value === undefined || value === null || value === '') continue
          set(this, name, value)
        }
      }
      return inherited.call(this)
    }
  }

  // Everything the proxy — rather than the target — is being told, which for a forwarded
  // request travels in the request's own headers. http-proxy-agent's set, and its order:
  // the caller's headers first, then credentials, then Proxy-Connection if nothing above
  // has already said one.
  _headersFor() {
    const headers = {
      ...(typeof this.proxyHeaders === 'function' ? this.proxyHeaders() : this.proxyHeaders)
    }
    const proxy = this.proxy

    if (hasCredentials(proxy)) {
      const credentials = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')
      headers['Proxy-Authorization'] = `Basic ${credentials}`
    }
    if (!headers['Proxy-Connection']) {
      // `_keepAlive` is bare-http1's, and -1 is its way of saying keep-alive is off.
      headers['Proxy-Connection'] = this._keepAlive === -1 ? 'close' : 'Keep-Alive'
    }
    return headers
  }
}

// The request line a forwarding proxy is given: the target's origin, then the path exactly
// as it stands.
//
// The origin comes from the Host header, as http-proxy-agent does, so a caller that set one
// of its own is the one deciding what the proxy is asked for. The path is appended rather
// than resolved against it: `new URL(path, origin)`, which is what http-proxy-agent does,
// reads a path beginning with `//` as an authority, so `http://mint.example//v1/info` would
// be forwarded as a request to a host called `v1`. bare-http1 has already refused a path
// carrying whitespace or a control character, which is what the request line needs of it.
function absolute(req, opts) {
  const authority = new URL(`http://${req.getHeader('host') || 'localhost'}`)
  if (opts.port && Number(opts.port) !== 80) authority.port = String(opts.port)
  const path = req._path.startsWith('/') ? req._path : `/${req._path}`
  return `http://${authority.host}${path}`
}

// Set a header without leaving a differently-cased one beside it — `_header()` lowercases
// every name on the way out, so two spellings of one name would go out as two headers.
function set(req, name, value) {
  const lower = name.toLowerCase()
  for (const existing of Object.keys(req._headers)) {
    if (existing !== lower && existing.toLowerCase() === lower) delete req._headers[existing]
  }
  req.setHeader(lower, value)
}

export { ProxyError, proxyErrorIn }
