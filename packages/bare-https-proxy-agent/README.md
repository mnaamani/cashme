# bare-https-proxy-agent

HTTP CONNECT proxy agents for [Bare](https://github.com/holepunchto/bare) — for `bare-fetch`,
`bare-ws`, and anything else that takes a `bare-http1` agent.

Named for what Node's `https-proxy-agent` does: ask an http proxy for a tunnel and speak to
the target through it. Both `http:` and `https:` targets can go through the tunnel, which is
why there is an agent for each. For `http:` targets through a proxy that forwards rather than
tunnels — Node's `http-proxy-agent` — see
[`bare-http-proxy-agent`](../bare-http-proxy-agent).

## Usage

```js
import { createAgents } from 'bare-https-proxy-agent'

const agents = createAgents('http://proxy.lan:3128')

const response = await fetch('https://example.com', { agent: agents.https })
const socket = new Socket('wss://relay.example', { agent: agents.https }) // bare-ws
```

With credentials, which are sent as `Proxy-Authorization: Basic`:

```js
createAgents('http://me:s3cret@proxy.lan:3128')
```

An `https://` proxy url means the first hop is itself TLS, so the CONNECT request — and any
credentials in it — is encrypted to the proxy rather than sent in the clear:

```js
createAgents('https://proxy.example:443')
```

### What the proxy sees

A tunnel has to be asked for by name, so the proxy learns the host and port. It never sees
inside: `agents.https` negotiates TLS with the target through the tunnel, and the
certificate is checked against the host that was asked for. Nothing is sent beyond what the
method needs — no user agent, no cookies.

## API

#### `createAgents(proxy[, opts])`

`{ http, https }` — an agent for `http:` targets and one for `https:` ones, both tunnelling.
`proxy` is a url string or the result of `parse()`; `opts` goes to `bare-http1`'s `Agent`.
Keep-alive is on by default, so a tunnel is reused rather than rebuilt per request.

#### `new HttpsProxyHTTPAgent(proxy[, opts])` · `new HttpsProxyHTTPSAgent(proxy[, opts])`

The two agents on their own, for when only one is wanted.

#### `parse(url)`

`{ protocol, host, port, username, password, secure }` for an `http://` or `https://` proxy
url, `secure` saying whether the proxy itself is reached over TLS. Host and port only — a
path or a query is refused rather than guessed at.

#### `handshake({ socket, reader, proxy, target })`

The CONNECT handshake itself, for use with `bare-proxy-agent` directly.

#### `ProxyError` · `proxyErrorIn(err)`

Re-exported from [`bare-proxy-agent`](../bare-proxy-agent). `bare-fetch` reports every
failure as `NETWORK_ERROR: Network error` and keeps the reason as its cause — `proxyErrorIn`
digs out the one that says the proxy refused the tunnel, or wants a password.

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

Node uses an http proxy two ways, and so do we: `https-proxy-agent` tunnels, while
`http-proxy-agent` sends `http:` requests to the proxy as an absolute URI
(`GET http://host/path`) rather than tunnelling them. The split is the same here —
`bare-http-proxy-agent` is the forwarding half. `agents.http` tunnels, so it behaves like
`https-proxy-agent` pointed at an `http:` target: most proxies take that, but one configured
to allow `CONNECT` only to port 443 — a common Squid default — will refuse a tunnel to port
80 that a forwarded request would have got through.

`opts.headers` and `agent.proxyHeaders` match `https-proxy-agent`, function form included.
`onProxyAuth` and `negotiate` (NTLM/Kerberos negotiation) have no equivalent here.

## Licence

Apache-2.0
