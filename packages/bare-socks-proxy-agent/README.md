# bare-socks-proxy-agent

SOCKS5 proxy agents for [Bare](https://github.com/holepunchto/bare) — for `bare-fetch`,
`bare-ws`, and anything else that takes a `bare-http1` agent.

Written for Tor's SOCKS5 port, and speaks to any other SOCKS5 proxy the same way.

## Usage

```js
import { createAgents } from 'bare-socks-proxy-agent'

const agents = createAgents('socks5://127.0.0.1:9050')

const response = await fetch('https://example.com', { agent: agents.https })
const socket = new Socket('wss://relay.example', { agent: agents.https }) // bare-ws
```

With a username and password (RFC 1929), put them in the url:

```js
createAgents('socks5://me:s3cret@127.0.0.1:1080')
```

### Names are resolved by the proxy

The target hostname goes over the wire as written, so no DNS query for it leaves the
machine — which is the point of a proxy for anyone who does not want their lookups
observed. That is what `socks5h://` means elsewhere; here both schemes do it, and
`socks5://` and `socks5h://` are the same proxy. The spelling is kept only so errors quote
back what was configured.

An IPv4 literal target is sent as an address, since there is nothing to resolve.

### TLS

`agents.https` negotiates TLS with the target inside the tunnel, so the certificate is
checked against the host that was asked for and the proxy carries ciphertext it cannot read.

## API

#### `createAgents(proxy[, opts])`

`{ http, https }` — an agent for `http:` targets and one for `https:` ones. `proxy` is a url
string or the result of `parse()`; `opts` goes to `bare-http1`'s `Agent`. Keep-alive is on by
default: a reused tunnel is a handshake, and with Tor a circuit, that is not built again.

#### `new SocksProxyHTTPAgent(proxy[, opts])` · `new SocksProxyHTTPSAgent(proxy[, opts])`

The two agents on their own, for when only one is wanted.

#### `parse(url)`

`{ protocol, host, port, username, password, secure }` for a `socks5://` or `socks5h://` url.
Host and port only — a path or a query is refused rather than guessed at.

#### `handshake({ socket, reader, proxy, target })`

The SOCKS5 handshake itself, for use with `bare-proxy-agent` directly.

#### `ProxyError` · `proxyErrorIn(err)`

Re-exported from [`bare-proxy-agent`](../bare-proxy-agent). `bare-fetch` reports every
failure as `NETWORK_ERROR: Network error` and keeps the reason as its cause — `proxyErrorIn`
digs out the one that says the proxy is not running, or wants a password, or could not reach
the host.

## Compared to Node's proxy agents

The surface follows [`socks-proxy-agent`](https://www.npmjs.com/package/socks-proxy-agent)
and [`https-proxy-agent`](https://www.npmjs.com/package/https-proxy-agent) wherever it can:
`new Agent(url | URL | parsed, opts)`, `static protocols`, `agent.proxy`, `agent.proxyUrl`,
and `opts` passed through to the underlying `Agent`. What differs is forced by Bare, and is
worth knowing before porting code across:

|                    | Node                                                | here                                                               |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------------ |
| base class         | `agent-base`'s `Agent`, over `http.Agent`           | `bare-http1`'s `Agent`                                             |
| hook               | `connect(req, opts)` returning a socket or an agent | `createConnection(opts)` returning a socket                        |
| target protocol    | `opts.secureEndpoint`, added by `agent-base`        | not passed to the agent                                            |
| one agent for both | yes — the class reads `secureEndpoint`              | no — an agent per target protocol, hence the pair                  |
| handshake timeout  | `opts.timeout`                                      | `opts.handshakeTimeout` (`timeout` is bare-http1's socket timeout) |

Nothing in the Node stack can be reused as it stands: Bare has no `net`, `tls` or `http`
builtins, and `agent-base` is written against Node's `http.Agent` internals. The pair of
agents is the one real ergonomic difference — bare-http1 hands an agent no way to tell an
`https:` target from an `http:` one, so which one a request needs is the caller's to pick.
`createAgents()` returns both for exactly that reason.

`socks-proxy-agent` also speaks SOCKS4 and SOCKS4a, and treats `socks5://` as _resolve the
name here, ourselves_ and `socks5h://` as _let the proxy resolve it_. This package speaks
SOCKS5 only, and resolves nothing under either scheme — see above. Code moved across gets
more privacy than it asked for, never less, but a program relying on local resolution (a
proxy that only accepts literal addresses, say) has to do that lookup itself.

## Licence

Apache-2.0
