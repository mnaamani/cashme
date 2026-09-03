// Where this wallet's traffic is allowed to leave from, and how it gets out.
//
// Two things can be asked for, and both are off unless asked for:
//
//   --proxy      every http(s) request and every relay websocket goes through a proxy
//                instead of straight out of this machine (bare-any-proxy-agent, in
//                packages/, picks the agent the proxy url calls for, and the protocol
//                packages beneath it do the carrying)
//   --dht-interface  the hyperdht's sockets leave from one local address rather than
//                    whichever one the routing table picks
//
// Neither is a default because neither is free: a proxy is a machine that sees every mint
// and relay we talk to, and an interface is a claim about this host's routing that only the
// user can make.
//
// What each covers is not the same shape, and the difference is the whole of this module.
//
// A proxy covers a protocol, not a run. It carries http, https and the websockets to
// relays; it does not carry the hyperdht, which holepunches over UDP, nor the local network
// handover, which finds its peer by multicast. That is not a half-applied flag — those two
// wires were never http and there is nothing there for a proxy to carry. `give --dht` under
// a proxy is a mint swap through the proxy and a token handed over the hyperdht, which is
// exactly what was asked for, so it runs and says where each half went.
//
// --dht-interface covers one transport, and says so in its name. A local address can be
// given to a socket that binds, which the hyperdht's do; Bare's TCP stack has no way to bind
// an outgoing connection, so nothing that reaches a mint or a relay can be pinned, and the
// local network handover cannot be either — its discovery sockets bind but the connection
// carrying the token does not. Rather than refuse the commands it cannot cover, the flag
// does what it says and bin.mjs says what it did not reach. --proxy is the flag for hiding
// which address a mint sees.
//
// Beyond --proxy, the environment is read the way curl reads it, so a machine already set
// up for a proxy needs nothing said here. See `configureNetwork` for the precedence.
import os from 'bare-os'
import process from 'bare-process'
import debuglog from 'bare-debug-log'
import { bypassed, fromEnv, noProxy, normalize } from 'bare-proxy-from-env'
import { createAgents, parse, proxyErrorIn, proxyName } from 'bare-any-proxy-agent'

const debug = debuglog('cashme:net')

// How long one http request may take before it is given up on. Bare's fetch has no deadline
// of its own, so a host that accepts a connection and then says nothing holds the wallet
// there for as long as it likes — which is not a hypothetical: a mint doing exactly that is
// what hangs `give` after the proofs are reserved, with nothing on screen to say why.
//
// Per request, not per command, so the polls that wait out a lightning invoice are unaffected
// — each is its own request and each is quick or it is broken.
const DEFAULT_TIMEOUT = 30000

// One entry per destination scheme, because the convention below allows a different proxy
// for http than for https. Both point at the same entry whenever a proxy was named rather
// than inherited from the environment.
let http = null
let https = null
// Whether the proxy was named for this wallet — --proxy or CASHME_PROXY — rather than
// picked up from the ambient environment. What it changes is below: an explicit proxy is
// exempt from no_proxy, and it is the only one that stops the OTA updater.
let explicit = false
let bypass = null
let bound = null
let boundVia = null
let timeout = DEFAULT_TIMEOUT

// Read once, from bin.mjs, before any command runs. `proxy` is a url, `iface` an interface
// name (en0, tun0) or a local address; both may be undefined, which is the ordinary case.
//
// A proxy is looked for in four places, and the first one that has it wins:
//
//   --proxy <url>              this run
//   CASHME_PROXY               every run of this wallet
//   https_proxy / http_proxy   the convention curl and most of the unix world follow
//   ALL_PROXY                  the same convention's fallback for schemes with no proxy set
//
// The first two are a proxy for this wallet and cover every scheme it speaks. The last two
// are the machine's own setting, are read per scheme, and are the only ones no_proxy can
// carve holes in — see `agentFor`.
export function configureNetwork({ proxy: url, iface, requestTimeout } = {}) {
  if (requestTimeout !== undefined) timeout = requestTimeout
  const named = url ?? env('CASHME_PROXY')
  if (named) {
    const entry = open({ url: normalize(named), source: url ? '--proxy' : 'CASHME_PROXY' })
    http = https = entry
    explicit = true
    debug('proxying http(s) and websockets through', entry.name, `(${entry.source})`)
  } else {
    // The convention, spelling rules and all, is bare-proxy-from-env's — including that
    // `http_proxy` is read in lower case only, which is not tidiness but the CGI `Proxy:`
    // header. Each variable is read here rather than through getProxyForUrl() because the
    // wallet wants to say which one it obeyed, and because the two schemes falling back to
    // the same ALL_PROXY must end up sharing one entry rather than opening the proxy twice.
    const secure = fromEnv('https_proxy', 'HTTPS_PROXY')
    const plain = fromEnv('http_proxy')
    const both = fromEnv('all_proxy', 'ALL_PROXY')

    const fallback = both ? open(both) : null
    https = secure ? open(secure) : fallback
    http = plain ? open(plain) : fallback
    bypass = noProxy()
    if (https || http) {
      debug('proxying from the environment:', (https ?? http).name, `(${(https ?? http).source})`)
    }
  }
  if (iface) {
    bound = resolveInterface(iface)
    boundVia = String(iface)
    debug('binding the hyperdht to', bound)
  }
  return { proxy: (https ?? http)?.proxy ?? null, bound }
}

// For tests and for anything that needs to say what is in force.
export function networkPolicy() {
  const entry = https ?? http
  return {
    proxy: entry?.proxy ?? null,
    proxyName: entry?.name ?? null,
    source: entry?.source ?? null,
    explicit,
    bound
  }
}

// What to say about a proxy in a sentence, or null when there is none. Used where a command
// is about to go out over a wire the proxy does not carry, so that it is said rather than
// left for the user to wonder about.
export function proxyInForce() {
  const entry = https ?? http
  return entry ? { name: entry.name, source: entry.source } : null
}

// Reset, so a test can configure a policy and put it back. Nothing in a run calls this —
// a run is one policy from start to finish.
export function clearNetwork() {
  // Tunnels the agents are holding open between requests, which would otherwise keep the
  // loop alive after the policy that opened them is gone. http and https are often the same
  // entry, so each is closed once.
  for (const entry of new Set([http, https].filter(Boolean))) {
    entry.agents.http.destroy()
    entry.agents.https.destroy()
  }
  http = null
  https = null
  explicit = false
  bypass = null
  bound = null
  boundVia = null
  timeout = DEFAULT_TIMEOUT
}

// The agent a request to `url` should go out on — bare-fetch and bare-ws both take one —
// or null when it should connect for itself.
//
// Two different choices are made here. Which proxy carries the request comes from the
// destination scheme, since the environment may name one proxy for http and another for
// https; ws: counts as http and wss: as https, being those two with an upgrade on top.
// Which of that proxy's two agents is used is a separate matter of whether TLS runs to the
// origin. And a proxy taken from the environment answers to no_proxy, while one named for
// this wallet does not — an ambient variable should not be able to punch a hole in a proxy
// the user asked for by name.
export function agentFor(url) {
  const target = typeof url === 'string' ? new URL(url) : url
  const secure = target.protocol === 'https:' || target.protocol === 'wss:'
  const entry = secure ? https : http
  if (!entry) return null
  if (!explicit && bypassed(bypass, target.hostname)) {
    debug('no_proxy exempts', target.hostname)
    return null
  }
  return secure ? entry.agents.https : entry.agents.http
}

// The same as an options object, for the apis that take one.
export function requestOptions(url) {
  const agent = agentFor(url)
  return agent ? { agent } : {}
}

// How --dht-interface was spelled on the command line, or null. For saying what it did and
// did not reach, the way proxyInForce() is.
export function interfaceInForce() {
  return boundVia
}

// The proxy reason behind a failure, however it has been rewrapped, or null.
//
// Our own errors carry a code and are found by it. A library that catches one and rethrows
// its own — coco answers an unreachable mint with `Failed to fetch mint <url>` and the
// message of whatever went wrong underneath — loses the code but keeps the words, so a
// cause that names one of the proxies in force counts too. Only ever consulted when there is
// one, which is what keeps that second test from matching something unrelated.
export function proxyFailure(err) {
  const names = new Set([http, https].filter(Boolean).map((entry) => entry.name))
  if (names.size === 0) return null

  const found = proxyErrorIn(err)
  if (found) return found

  for (let cause = err; cause instanceof Error; cause = cause.cause) {
    if (typeof cause.message !== 'string') continue
    for (const name of names) if (cause.message.includes(name)) return cause
  }
  return null
}

// hyperdht options: which local address its sockets bind to. This is the whole of what
// --dht-interface does — there is no other reader of `bound` in the wallet. Empty unless the
// flag was given, and hyperdht then binds 0.0.0.0 as it always has.
export function dhtOptions() {
  return bound ? { host: bound } : {}
}

// Every http request this wallet makes goes through global fetch — ours in lib/nostr.mjs
// and lib/lnurl.mjs, and coco's to the mints, which we do not otherwise see. Wrapping it
// here is what makes --proxy reach all of them, and the wrapper reads the policy per call
// rather than at install time, so it can be installed from polyfills.mjs before anything is
// configured. Installed once; calling it again is a no-op.
const wrapped = Symbol.for('cashme.net.fetch')

export function installProxyFetch() {
  const direct = globalThis.fetch
  if (typeof direct !== 'function' || direct[wrapped]) return

  function fetch(input, init = {}) {
    let url
    try {
      url = typeof input === 'string' ? new URL(input) : new URL(input.url ?? input)
    } catch (err) {
      // Under a proxy this is the one case that must not be handed on: with nothing to read
      // a destination from there is no policy to apply, and going direct would be a request
      // leaving this machine around the proxy the user asked for. Refused instead. With no
      // proxy configured there is nothing to go around, and bare-fetch has better words for
      // a bad url than we do.
      if (!http && !https) return direct(input, init)
      return Promise.reject(new Error(`not a url, and a proxy is in force: ${err.message}`))
    }
    const agent = agentFor(url)
    const options = agent ? { ...init, agent } : init

    // A caller that brought its own signal has its own idea of when to stop, and two
    // deadlines on one request is a race nobody asked for. Nothing in the wallet does this
    // today; coco's mint requests do not.
    if (init.signal) return send(options)

    const deadline = expiry(timeout, url)
    return send({ ...options, signal: deadline.signal }).finally(deadline.clear)

    function send(opts) {
      const pending = direct(input, opts)
      if (!agent) return pending
      // bare-fetch reports every failure as `NETWORK_ERROR: Network error` and keeps the
      // reason as its cause. When the reason is the proxy — not running, wrong port, wants a
      // password — that is the whole of what the user needs to read.
      return pending.then(sameScheme, (err) => {
        throw proxyErrorIn(err) ?? err
      })
    }

    // bare-fetch follows redirects itself and keeps, for every hop, the agent it was handed
    // — but an agent under bare-http1 *is* the scheme: it is the thing that decides whether
    // TLS runs. So a redirect that changes scheme is carried by an agent built for the other
    // one, and an https: hop reached through the http agent goes out in the clear. Nothing
    // here can re-pick an agent mid-chain, so a response that came back that way is refused
    // rather than returned — the wallet must not act on a body it believes came over TLS
    // when it did not.
    //
    // The agents refuse the common case before anything is written (an http agent asked for
    // port 443); this catches the rest, where an https: url on some other port means the
    // request has already gone out. Only reached when a proxy is in force: with no agent of
    // ours, bare-fetch picks its own per hop and picks correctly.
    function sameScheme(response) {
      const landed = response.url ? new URL(response.url) : url
      if (landed.protocol === url.protocol) return response
      const err = new Error(
        `${url.host} redirected from ${url.protocol}// to ${landed.protocol}//${landed.host}, ` +
          'which cannot be followed through a proxy'
      )
      err.code = 'PROXY_SCHEME_CHANGED'
      throw err
    }
  }

  fetch[wrapped] = true
  globalThis.fetch = fetch
}

// The least of an AbortSignal that bare-fetch reads: whether it has fired, why, and a way to
// be told. Bare has no AbortController of its own, and this needs none of the rest of one.
//
// The reason is what the user sees, so it names the host rather than the whole url — a
// stalled mint is a fact about the mint, and the path it stalled on is noise to whoever has
// to decide whether to try again.
function expiry(ms, url) {
  const listeners = []
  const signal = {
    aborted: false,
    reason: null,
    addEventListener(type, fn) {
      if (type === 'abort') listeners.push(fn)
    },
    removeEventListener(type, fn) {
      if (type !== 'abort') return
      const at = listeners.indexOf(fn)
      if (at !== -1) listeners.splice(at, 1)
    }
  }

  const timer = setTimeout(() => {
    signal.aborted = true
    signal.reason = new Error(`no answer from ${url.host} after ${Math.round(ms / 1000)}s`)
    signal.reason.code = 'REQUEST_TIMEOUT'
    debug('timed out after', ms, 'ms:', url.host)
    for (const fn of listeners.slice()) fn({ type: 'abort' })
  }, ms)

  return { signal, clear: () => clearTimeout(timer) }
}

// A proxy url and the agents to reach it with, from what bare-proxy-from-env read: the url
// with the scheme the convention leaves out already put back, and the name of the place it
// came from, so a bad value says which one to go and fix.
function open({ url, source }) {
  // Something that is not a url at all gets a whole one to copy, since there is nothing in
  // what arrived to correct. Anything else — a scheme no agent speaks, a path where a port
  // should be — bare-any-proxy-agent has better words for than we do, and all the wallet
  // adds is which knob to go and turn.
  if (!isUrl(url)) {
    throw new Error(`${source} is not a proxy url: ${url} — try socks5://127.0.0.1:1080`)
  }
  let proxy
  try {
    proxy = parse(url)
  } catch (err) {
    throw new Error(`${source}: ${err.message}`)
  }
  return { proxy, agents: createAgents(proxy), name: proxyName(proxy), source }
}

function isUrl(value) {
  try {
    return Boolean(new URL(value))
  } catch {
    return false
  }
}

// A variable that is set to nothing is not set, which is how the convention says "no proxy
// here". CASHME_PROXY is the only variable read directly now — everything the convention
// itself defines goes through bare-proxy-from-env, which has the same rule.
function env(name) {
  const value = process.env[name]
  return value && String(value).trim() ? value : undefined
}

// An interface name as `bare-os` reports it, or an address on one. Resolved to a single
// address because that is what a socket binds to: IPv4 first, since the hyperdht's
// bootstrap nodes are reached over IPv4 and binding an IPv6 address would leave it unable
// to speak to them.
function resolveInterface(value) {
  const name = String(value).trim()
  const interfaces = os.networkInterfaces()

  const named = interfaces[name]
  if (named) {
    const address =
      named.find((entry) => entry.family === 'IPv4') ?? named.find((entry) => !entry.internal)
    if (!address) throw new Error(`the ${name} interface has no address to bind to`)
    return address.address
  }

  // An address rather than a name. Checked against what this host actually has, so a typo
  // is a message here instead of an EADDRNOTAVAIL out of the DHT later.
  for (const [, entries] of Object.entries(interfaces)) {
    for (const entry of entries) {
      if (entry.address === name) return entry.address
    }
  }

  const known = Object.keys(interfaces).join(', ')
  throw new Error(`no interface or local address called ${name} — this host has ${known}`)
}
