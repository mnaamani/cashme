// SOCKS5 (RFC 1928) for Bare, as http agents bare-fetch and bare-ws can be handed.
//
// Names are never resolved here: the target goes over the wire as written and the proxy
// resolves it, so no DNS query for it leaves the machine. That is what socks5h:// means
// elsewhere, and it is what both schemes do here — `socks5://` and `socks5h://` are the
// same proxy to this package, and the spelling is kept only so errors quote back what was configured.
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

// Where a SOCKS5 proxy listens when the url names no port.
export const PORTS = { 'socks5:': 1080, 'socks5h:': 1080 }

// Reply codes worth naming (RFC 1928 §6). The rest are reported by number.
const REPLIES = {
  1: 'the proxy failed',
  2: 'the proxy is not allowed to',
  3: 'the network is unreachable from the proxy',
  4: 'the host is unreachable from the proxy',
  5: 'the connection was refused',
  6: 'the connection timed out',
  7: 'the proxy does not support this kind of connection',
  8: 'the proxy does not support this kind of address'
}

export function parse(url) {
  return parseProxyUrl(url, PORTS)
}

// The handshake, with username and password authentication (RFC 1929) when the proxy url
// carries credentials. Three round trips at most: what we can authenticate with, the
// credentials themselves, and the connect request.
export async function handshake({ socket, reader, proxy, target }) {
  const name = proxyName(proxy)
  const credentials = hasCredentials(proxy)

  // 0x00 is no authentication, 0x02 is username and password. Offered only when we have
  // some: a proxy that accepts both would otherwise be told we can authenticate and then
  // have nothing to send it.
  socket.write(credentials ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]))

  const [version, method] = await reader.read(2)
  if (version !== 5) throw new ProxyError(`${name} does not speak SOCKS5`)
  if (method === 0xff) {
    throw new ProxyError(
      credentials
        ? `${name} accepts neither of the ways we can authenticate`
        : `${name} wants authentication — put a username and password in the proxy url`
    )
  }
  if (method === 2) {
    const username = Buffer.from(proxy.username)
    const password = Buffer.from(proxy.password)
    if (username.byteLength > 255 || password.byteLength > 255) {
      throw new ProxyError('a proxy username and password are 255 bytes each at most')
    }
    socket.write(
      Buffer.concat([
        Buffer.from([1, username.byteLength]),
        username,
        Buffer.from([password.byteLength]),
        password
      ])
    )
    const [, status] = await reader.read(2)
    if (status !== 0) throw new ProxyError(`${name} refused the username and password`)
  } else if (method !== 0) {
    throw new ProxyError(`${name} asked for an authentication method we do not speak (${method})`)
  }

  socket.write(
    Buffer.concat([Buffer.from([5, 1, 0]), address(target.host), portBytes(target.port)])
  )

  const reply = await reader.read(4)
  if (reply[0] !== 5) throw new ProxyError(`${name} does not speak SOCKS5`)
  if (reply[1] !== 0) {
    const why = REPLIES[reply[1]] ?? `the proxy answered ${reply[1]}`
    throw new ProxyError(`${name} could not reach ${authority(target)}: ${why}`)
  }
  // The address the proxy bound on our behalf, which we have no use for but must read past
  // to leave the stream at the first byte the target sent.
  const type = reply[3]
  const length = type === 1 ? 4 : type === 4 ? 16 : type === 3 ? (await reader.read(1))[0] : null
  if (length === null) throw new ProxyError(`${name} answered with an address type we cannot read`)
  await reader.read(length + 2)
}

// An address as SOCKS5 writes it. A dotted-quad goes as an IPv4 address, everything else as
// a name for the proxy to resolve — which keeps our DNS off the network, and is the right
// form for the hostnames a client actually asks for. An IPv6 literal is rare enough as a
// target that it is handed over as a name too, and left to the proxy to make sense of.
function address(host) {
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (quad) {
    const octets = quad.slice(1).map(Number)
    if (octets.every((octet) => octet <= 255)) return Buffer.from([1, ...octets])
  }
  const name = Buffer.from(host)
  if (name.byteLength > 255) throw new ProxyError(`hostname too long for a proxy: ${host}`)
  return Buffer.concat([Buffer.from([3, name.byteLength]), name])
}

function portBytes(port) {
  return Buffer.from([(port >> 8) & 0xff, port & 0xff])
}

function tunnel(proxy) {
  return {
    proxy: typeof proxy === 'object' && proxy !== null && !isURL(proxy) ? proxy : parse(proxy),
    handshake
  }
}

function isURL(value) {
  return typeof value.href === 'string' && typeof value.protocol === 'string'
}

// The schemes these agents speak, as socks-proxy-agent lists them. Not socks4, socks4a or
// bare `socks:` — this package speaks SOCKS5 and nothing else, and a url it cannot honour is
// better refused than quietly downgraded.
const PROTOCOLS = ['socks5', 'socks5h']

// For http:// targets.
export class SocksProxyHTTPAgent extends ProxyHTTPAgent {
  static protocols = PROTOCOLS

  constructor(proxy, opts) {
    super(tunnel(proxy), opts)
  }
}

// For https:// targets: the same tunnel, with TLS to the target negotiated inside it.
export class SocksProxyHTTPSAgent extends ProxyHTTPSAgent {
  static protocols = PROTOCOLS

  constructor(proxy, opts) {
    super(tunnel(proxy), opts)
  }
}

// Both at once, which is what a program routing all of its traffic wants.
export function createAgents(proxy, opts) {
  return {
    http: new SocksProxyHTTPAgent(proxy, opts),
    https: new SocksProxyHTTPSAgent(proxy, opts)
  }
}

export { ProxyError, proxyErrorIn, Reader }
