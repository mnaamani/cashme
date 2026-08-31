// Where this wallet's traffic is allowed to leave from, and how it gets out.
//
// Two things can be asked for, and both are off unless asked for:
//
//   --proxy      every http(s) request and every relay websocket goes through a proxy
//                instead of straight out of this machine (bare-socks-proxy-agent and
//                bare-https-proxy-agent, in packages/, do the carrying)
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
import { proxyErrorIn, proxyName } from 'bare-proxy-agent'
import * as socks from 'bare-socks-proxy-agent'
import * as connect from 'bare-https-proxy-agent'

const debug = debuglog('cashme:net')

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
export function configureNetwork({ proxy: url, iface } = {}) {
  const named = url ?? env('CASHME_PROXY')
  if (named) {
    const entry = open(named, url ? '--proxy' : 'CASHME_PROXY')
    http = https = entry
    explicit = true
    debug('proxying http(s) and websockets through', entry.name, `(${entry.source})`)
  } else {
    // The convention, as curl documents it: the lower case spelling wins where both are
    // set, except that `http_proxy` is read in lower case only. That exception is not
    // tidiness — under CGI a request header `Proxy: ...` arrives as HTTP_PROXY in the
    // environment, so honouring the upper case spelling would let whoever sent the request
    // choose the proxy. The others have no such collision.
    const secure = env('https_proxy') ?? env('HTTPS_PROXY')
    const plain = env('http_proxy')
    const both = env('all_proxy') ?? env('ALL_PROXY')

    const fallback = both ? open(both, spelling('all_proxy', 'ALL_PROXY')) : null
    https = secure ? open(secure, spelling('https_proxy', 'HTTPS_PROXY')) : fallback
    http = plain ? open(plain, 'http_proxy') : fallback
    bypass = parseBypass(env('no_proxy') ?? env('NO_PROXY'))
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
  if (!explicit && bypassed(target.hostname)) {
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
    } catch {
      // Not our error to raise: hand it to bare-fetch, which has a message for it.
      return direct(input, init)
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

// A proxy url and the agents to reach it with. `source` is what to call the place it came
// from, so a bad value says which one to go and fix.
function open(value, source) {
  const url = normalize(value)
  const scheme = schemeOf(url)
  if (!scheme) {
    throw new Error(`${source} is not a proxy url: ${value} — try socks5://127.0.0.1:9050`)
  }
  const speaks = SCHEMES[scheme]
  if (!speaks) {
    throw new Error(
      `unsupported proxy scheme ${scheme} in ${source} — use socks5://, socks5h://, http:// ` +
        'or https://'
    )
  }
  const proxy = speaks.parse(url)
  return { proxy, agents: speaks.createAgents(proxy), name: proxyName(proxy), source }
}

// Which spelling of a variable is actually set, for the message when it turns out to hold
// something unusable.
function spelling(lower, upper) {
  return env(lower) ? lower : upper
}

// A variable that is set to nothing is not set. Exporting an empty `http_proxy` is how the
// convention says "no proxy here" — often to undo one the login shell exported — so an empty
// value must not win the `??` against the spelling below it, or against going direct.
function env(name) {
  const value = process.env[name]
  return value && String(value).trim() ? value : undefined
}

// The convention writes the value as `[protocol://]host[:port]`, so a bare `host:port` is a
// proxy reached over http — which is what curl assumes for it too. Anything already carrying
// a scheme is left alone, including one we cannot speak, so `open` can name it.
function normalize(value) {
  const raw = String(value).trim()
  return raw.includes('://') ? raw : `http://${raw}`
}

// The scheme of something the user typed, or null when it is not a url at all — which the
// parse above reports better than a scheme check could.
function schemeOf(value) {
  try {
    return new URL(String(value).trim()).protocol
  } catch {
    return null
  }
}

// no_proxy, as the convention has it: a comma-separated list where `*` alone means every
// host, an entry matches the hostname itself or any domain under it (`local.com` covers
// `www.local.com` but not `www.notlocal.com`), and an entry may be an address or a CIDR
// block instead of a name. A port on an entry is ignored, since it is the host that is
// being exempted.
function parseBypass(value) {
  if (!value) return null
  const listed = String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (listed.length === 0) return null
  if (listed.includes('*')) return { all: true, hosts: [], nets: [] }

  const hosts = []
  const nets = []
  for (const entry of listed) {
    if (entry.includes('/')) {
      const net = parseCidr(entry)
      if (net) {
        nets.push(net)
        continue
      }
    }
    // A single colon is a port to drop. Several means an IPv6 address, which the convention
    // says to write without brackets, and which has no port on it to drop.
    const ports = entry.split(':').length - 1
    const host = ports === 1 ? entry.slice(0, entry.lastIndexOf(':')) : entry
    hosts.push(host.replace(/^\./, '').toLowerCase())
  }
  return { all: false, hosts, nets }
}

// Whether no_proxy exempts this host. Only ever consulted for a proxy that came from the
// environment: one named by --proxy or CASHME_PROXY covers everything, with no exceptions.
function bypassed(hostname) {
  if (!bypass) return false
  if (bypass.all) return true

  const host = String(hostname).toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  for (const entry of bypass.hosts) {
    if (host === entry || host.endsWith(`.${entry}`)) return true
  }

  if (nets(host)) return true
  return false
}

function nets(host) {
  if (bypass.nets.length === 0) return false
  const address = parseIPv4(host)
  if (address === null) return false
  return bypass.nets.some((net) => (address & net.mask) >>> 0 === (net.base & net.mask) >>> 0)
}

// A dotted-quad as a number, or null when it is a name rather than an address.
function parseIPv4(value) {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  let address = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const byte = Number(part)
    if (byte > 255) return null
    address = address * 256 + byte
  }
  return address
}

function parseCidr(entry) {
  const slash = entry.lastIndexOf('/')
  const base = parseIPv4(entry.slice(0, slash))
  const width = Number(entry.slice(slash + 1))
  if (base === null) return null
  if (!Number.isInteger(width) || width < 0 || width > 32) return null
  const mask = width === 0 ? 0 : (0xffffffff << (32 - width)) >>> 0
  return { base, mask }
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
