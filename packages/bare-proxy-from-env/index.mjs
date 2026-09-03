// Which proxy the environment is asking for, under Bare. Node's proxy-from-env.
//
// No sockets and no agents: this is the string half of using a proxy — the convention curl
// and most of the unix world follow for saying "route through here", and `no_proxy` for
// carving holes in it. What to do with the url it hands back is
// bare-any-proxy-agent's business, or your own.
//
// The convention, as curl documents it: `http_proxy`, `https_proxy` and `ALL_PROXY` as the
// fallback for a scheme with none of its own, in either case, with the lower case spelling
// winning where both are set — except for `http_proxy`, which is read in lower case only.
// That exception is not tidiness. Under CGI a request header `Proxy: ...` arrives in the
// environment as HTTP_PROXY, so honouring the upper case spelling would let whoever sent
// the request choose the proxy (CVE-2016-5385 and friends). The other variables have no
// such collision. Node's proxy-from-env reads both spellings of every variable, including
// that one; this does not, and that is the one difference worth knowing before porting code
// across.
import process from 'bare-process'

// The variables consulted for each target scheme, in the order they win. ws: and wss: are
// http and https with an upgrade on top, and are read as those — nothing in the convention
// defines a `ws_proxy`, and a program that proxies its http traffic means its websockets too.
const VARIABLES = {
  http: ['http_proxy'],
  https: ['https_proxy', 'HTTPS_PROXY'],
  ws: ['http_proxy'],
  wss: ['https_proxy', 'HTTPS_PROXY']
}

const FALLBACK = ['all_proxy', 'ALL_PROXY']

// The first of `names` that is set to something, as `{ url, source }` — `source` being the
// spelling that actually won, so a value that turns out to be unusable can say which
// variable to go and fix. Null when none of them is set.
//
// The building block the rest of this is made of, and the one to reach for when a program
// wants to say where a setting came from rather than just what it was.
export function fromEnv(...names) {
  for (const name of names) {
    const value = env(name)
    if (value) return { url: normalize(value), source: name }
  }
  return null
}

// The proxy for a target scheme — 'https', 'https:', or a whole URL's protocol — falling
// back to ALL_PROXY, as `{ url, source }` or null. `no_proxy` is not consulted here: it is a
// question about a host, and this one is only about a scheme.
export function proxyForProtocol(protocol) {
  const scheme = String(protocol).replace(/:$/, '').toLowerCase()
  return fromEnv(...(VARIABLES[scheme] ?? []), ...FALLBACK)
}

// Node's proxy-from-env, name and shape included: the proxy url for a target url, or the
// empty string when it should go direct. A string or anything with `protocol` and `hostname`
// — a URL will do.
export function getProxyForUrl(url) {
  let target
  try {
    target = typeof url === 'string' ? new URL(url) : url
  } catch {
    return ''
  }
  if (!target || !target.protocol || !target.hostname) return ''

  const found = proxyForProtocol(target.protocol)
  if (!found) return ''
  if (bypassed(noProxy(), target.hostname)) return ''
  return found.url
}

// `no_proxy` as the environment has it, parsed, or null when it is not set.
export function noProxy() {
  return parseNoProxy(env('no_proxy') ?? env('NO_PROXY'))
}

// no_proxy, as the convention has it: a comma-separated list where `*` alone means every
// host, an entry matches the hostname itself or any domain under it (`local.com` covers
// `www.local.com` but not `www.notlocal.com`), and an entry may be an address or a CIDR
// block instead of a name. A leading `.` or `*.` is the same entry written differently. A
// port on an entry is ignored, since it is the host that is being exempted — which is curl's
// reading; Node's proxy-from-env matches the port too.
export function parseNoProxy(value) {
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
    hosts.push(host.replace(/^\*/, '').replace(/^\./, '').toLowerCase())
  }
  return { all: false, hosts, nets }
}

// Whether a parsed no_proxy exempts this host. A null bypass exempts nothing, so the caller
// need not check whether the variable was set.
export function bypassed(bypass, hostname) {
  if (!bypass) return false
  if (bypass.all) return true

  const host = String(hostname).toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  for (const entry of bypass.hosts) {
    if (host === entry || host.endsWith(`.${entry}`)) return true
  }
  return nets(bypass, host)
}

// The convention writes a value as `[protocol://]host[:port]`, so a bare `host:port` is a
// proxy reached over http — which is what curl assumes for it too. Node's proxy-from-env
// assumes the *target's* scheme instead, so a bare host in `https_proxy` becomes an
// `https://` proxy there and an `http://` one here; a scheme-less proxy is almost always a
// plain http proxy, and guessing otherwise fails in a way that is hard to read. Anything
// already carrying a scheme is left alone, including one no agent can speak, so that
// whoever parses it can name it.
export function normalize(value) {
  const raw = String(value).trim()
  return raw.includes('://') ? raw : `http://${raw}`
}

// A variable that is set to nothing is not set. Exporting an empty `http_proxy` is how the
// convention says "no proxy here" — often to undo one the login shell exported — so an empty
// value must not win against the spelling below it, or against going direct.
function env(name) {
  const value = process.env[name]
  return value && String(value).trim() ? value : undefined
}

function nets(bypass, host) {
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
