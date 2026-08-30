// Where this wallet's traffic is allowed to leave from, and how it gets out.
//
// Two things can be asked for, and both are off unless asked for:
//
//   --proxy      every http(s) request and every relay websocket goes through a proxy
//                instead of straight out of this machine (bare-socks-proxy-agent and
//                bare-https-proxy-agent, in packages/, do the carrying)
//   --interface  outgoing packets leave from one local address rather than whichever one
//                the routing table picks
//
// Neither is a default because neither is free: a proxy is a machine that sees every mint
// and relay we talk to, and an interface is a claim about this host's routing that only the
// user can make. What is a default is that nothing here silently half-applies. Bare's TCP
// stack cannot bind an outgoing connection to a local address, so --interface can hold for
// the hyperdht (a UDP socket, which can be bound) and not for anything over TCP; the
// hyperdht in turn holepunches over UDP, which no SOCKS5 or CONNECT proxy will carry. So
// each flag covers what it can cover and the run stops at the first thing it cannot — a
// command that would otherwise have gone out unproxied, or from an address the user did not
// choose, says so and does nothing instead.
import os from 'bare-os'
import process from 'bare-process'
import debuglog from 'bare-debug-log'
import { proxyErrorIn, proxyName } from 'bare-proxy-agent'
import * as socks from 'bare-socks-proxy-agent'
import * as connect from 'bare-https-proxy-agent'

const debug = debuglog('cashme:net')

let proxy = null
let agents = null
let bound = null
let boundVia = null

// Which package carries which scheme. socks5h:// is socks5:// with the name resolved at
// the far end, which is what bare-socks-proxy-agent does for both; https:// is a CONNECT
// proxy reached over TLS. Nothing else is a proxy we know how to speak to.
const SCHEMES = {
  'socks5:': socks,
  'socks5h:': socks,
  'http:': connect,
  'https:': connect
}

// Read once, from bin.mjs, before any command runs. `proxy` is a url, `iface` an interface
// name (en0, tun0) or a local address; both may be undefined, which is the ordinary case.
export function configureNetwork({ proxy: url, iface } = {}) {
  const configured = url ?? process.env.CASHME_PROXY
  if (configured) {
    const scheme = schemeOf(configured)
    if (!scheme) throw new Error(`not a proxy url: ${configured} — try socks5://127.0.0.1:9050`)
    const speaks = SCHEMES[scheme]
    if (!speaks) {
      throw new Error(
        `unsupported proxy scheme ${scheme} — use socks5://, socks5h://, http:// or https://`
      )
    }
    proxy = speaks.parse(configured)
    agents = speaks.createAgents(proxy)
    debug('proxying http(s) and websockets through', proxyName(proxy))
  }
  if (iface) {
    bound = resolveInterface(iface)
    boundVia = String(iface)
    debug('binding the hyperdht to', bound)
  }
  return { proxy, bound }
}

// For tests and for anything that needs to say what is in force.
export function networkPolicy() {
  return { proxy, bound, proxyName: proxy ? proxyName(proxy) : null }
}

// Reset, so a test can configure a policy and put it back. Nothing in a run calls this —
// a run is one policy from start to finish.
export function clearNetwork() {
  // Tunnels the agents are holding open between requests, which would otherwise keep the
  // loop alive after the policy that opened them is gone.
  agents?.http.destroy()
  agents?.https.destroy()
  proxy = null
  agents = null
  bound = null
  boundVia = null
}

// The agent a request to `url` should go out on — bare-fetch and bare-ws both take one —
// or null when there is no proxy and they should connect for themselves.
export function agentFor(url) {
  if (!agents) return null
  const protocol = typeof url === 'string' ? new URL(url).protocol : url.protocol
  return protocol === 'https:' || protocol === 'wss:' ? agents.https : agents.http
}

// The same as an options object, for the apis that take one.
export function requestOptions(url) {
  const agent = agentFor(url)
  return agent ? { agent } : {}
}

// Fail closed on the TCP side of --interface. Called from the two places that open a TCP
// connection — the fetch below and lib/websocket.mjs — because Bare offers no way to say
// which address such a connection leaves from, and a request that quietly ignored the flag
// would be exactly the leak the flag was reached for.
export function assertUnbound(what) {
  if (!bound) return
  throw new Error(
    `--interface ${boundVia} cannot hold for ${what}: Bare's TCP stack has no way to bind an ` +
      'outgoing connection to an address, so only the hyperdht (`give --dht`, `get --dht`) ' +
      'can be pinned to one. Drop --interface, or use a command that stays on the hyperdht.'
  )
}

// And fail closed on the UDP side of --proxy: the hyperdht punches a direct UDP path
// between two peers, which is not something a SOCKS5 or CONNECT proxy forwards.
export function assertUnproxied(what) {
  if (!proxy) return
  throw new Error(
    `--proxy cannot carry ${what}: the hyperdht holepunches over UDP, which a SOCKS5 or ` +
      'CONNECT proxy does not forward. Hand the token over another way — bluetooth, or ' +
      '`give --print` — or drop --proxy.'
  )
}

// The proxy reason behind a failure, however it has been rewrapped, or null.
//
// Our own errors carry a code and are found by it. A library that catches one and rethrows
// its own — coco answers an unreachable mint with `Failed to fetch mint <url>` and the
// message of whatever went wrong underneath — loses the code but keeps the words, so a
// cause that names this proxy counts too. Only ever consulted when a proxy is configured,
// which is what keeps that second test from matching something unrelated.
export function proxyFailure(err) {
  if (!proxy) return null

  const found = proxyErrorIn(err)
  if (found) return found

  const name = proxyName(proxy)
  for (let cause = err; cause instanceof Error; cause = cause.cause) {
    if (typeof cause.message === 'string' && cause.message.includes(name)) return cause
  }
  return null
}

// hyperdht options: which local address its sockets bind to. Empty unless --interface was
// given, and hyperdht then binds 0.0.0.0 as it always has.
export function dhtOptions() {
  return bound ? { host: bound } : {}
}

// Why the OTA updater is not being started this run, or null. The updater is a separate
// process that fetches over the hyperdht and has no idea any of this was asked for, so it
// is skipped rather than left to reach the network on its own terms.
export function updaterBlocked() {
  if (proxy) return '--proxy'
  if (bound) return `--interface ${boundVia}`
  return null
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
    } catch {
      // Not our error to raise: hand it to bare-fetch, which has a message for it.
      return direct(input, init)
    }
    try {
      assertUnbound(`${url.protocol.replace(':', '')} requests`)
    } catch (err) {
      return Promise.reject(err)
    }
    const agent = agentFor(url)
    if (!agent) return direct(input, init)
    // bare-fetch reports every failure as `NETWORK_ERROR: Network error` and keeps the
    // reason as its cause. When the reason is the proxy — not running, wrong port, wants a
    // password — that is the whole of what the user needs to read.
    return direct(input, { ...init, agent }).catch((err) => {
      throw proxyErrorIn(err) ?? err
    })
  }

  fetch[wrapped] = true
  globalThis.fetch = fetch
}

// The scheme of something the user typed, or null when it is not a url at all — which the
// parse below reports better than a scheme check could.
function schemeOf(value) {
  try {
    return new URL(String(value).trim()).protocol
  } catch {
    return null
  }
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
