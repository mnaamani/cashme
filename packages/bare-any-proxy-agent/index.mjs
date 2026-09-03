// One entry point for every proxy scheme Bare speaks: hand it a proxy url of any of them and
// get back the agents to use it with. Node's proxy-agent.
//
// This is what a program wants when the proxy url comes from a user or from the environment
// rather than from its own source — the scheme is then a fact about the url, not a choice,
// and the difference between socks5:// and http:// stops being the program's business.
//
// The protocols live in bare-socks-proxy-agent, bare-http-proxy-agent and
// bare-https-proxy-agent, and the shared half in bare-proxy-agent. Nothing is implemented
// here; this is the table.
import { ProxyError, parseProxyUrl, proxyErrorIn, proxyName } from 'bare-proxy-agent'
import * as socks from 'bare-socks-proxy-agent'
import * as forward from 'bare-http-proxy-agent'
import * as connect from 'bare-https-proxy-agent'

// An http proxy is spoken to two different ways depending on where the request is going,
// which is why two packages carry it — the same split Node makes between http-proxy-agent
// and https-proxy-agent, and the same choice between them:
//
//   http:// target   forwarded, with the whole url in the request line, for the proxy to
//                    make onwards. The form every http proxy must accept — a proxy that
//                    allows CONNECT to 443 only, which is a common Squid default, takes
//                    this and would refuse a tunnel to port 80.
//   https:// target  a CONNECT tunnel, with TLS negotiated end to end inside it. There is
//                    nothing to forward: the proxy carries ciphertext and never reads it.
const overHttp = {
  parse: connect.parse,
  createAgents(proxy, opts) {
    return {
      http: new forward.HttpProxyAgent(proxy, opts),
      https: new connect.HttpsProxyHTTPSAgent(proxy, opts)
    }
  }
}

// Which package carries which scheme. socks5h:// is socks5:// with the name resolved at the
// far end, which is what bare-socks-proxy-agent does for both; https:// is an http proxy
// reached over TLS, and is spoken to the same two ways once it is.
const SCHEMES = {
  'socks5:': socks,
  'socks5h:': socks,
  'http:': overHttp,
  'https:': overHttp
}

// The proxy schemes there is an agent for. Node's proxy-agent exports the same list under
// the same name.
export const protocols = Object.keys(SCHEMES).map((scheme) => scheme.slice(0, -1))

// A proxy url of any scheme above, read by the package that speaks it. Throws with the
// schemes named when it is one of the many that no agent here speaks — a proxy url that
// cannot be honoured is better refused than quietly ignored, since going direct is exactly
// what whoever set it was trying to prevent.
export function parse(url) {
  const speaks = SCHEMES[protocolOf(url)]
  if (!speaks) {
    // parseProxyUrl says which schemes are on offer, and says it the same way for a url with
    // no scheme we know as for one that is not a url at all. Both come through here, and
    // both leave by throwing.
    return parseProxyUrl(url, Object.keys(SCHEMES))
  }
  return speaks.parse(url)
}

// `{ http, https }` — an agent for http: targets and one for https: ones, both going
// through `proxy`, which is a url string, a URL, or something `parse()` returned.
export function createAgents(proxy, opts) {
  const parsed = isParsed(proxy) ? proxy : parse(proxy)
  return SCHEMES[parsed.protocol].createAgents(parsed, opts)
}

function protocolOf(url) {
  try {
    return new URL(String(url).trim()).protocol
  } catch {
    return null
  }
}

// What parse() returned, as against a url to hand to it. A URL has `protocol` too, so it is
// the rest of the shape that tells them apart.
function isParsed(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.protocol === 'string' &&
    typeof value.host === 'string' &&
    typeof value.port === 'number'
  )
}

export { ProxyError, proxyErrorIn, proxyName }
