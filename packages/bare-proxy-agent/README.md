# bare-proxy-agent

Tunnel http and websocket traffic through a proxy under [Bare](https://github.com/holepunchto/bare).

This is the half every proxy protocol shares: a socket that is opened by handshake rather
than by connecting, the [bare-http1](https://github.com/holepunchto/bare-http1) agents built
on it, and the reading and error types a handshake is written against.

**Start with one of these instead**, unless you are teaching this package a protocol of your
own:

- [`bare-socks-proxy-agent`](../bare-socks-proxy-agent) — SOCKS5
- [`bare-https-proxy-agent`](../bare-https-proxy-agent) — HTTP CONNECT

## Usage

An agent is what `bare-fetch` and `bare-ws` take, so a pair of them is the whole of routing
a program's traffic:

```js
import { createAgents, parseProxyUrl, ProxyError, authority } from 'bare-proxy-agent'

const proxy = parseProxyUrl('demo://127.0.0.1:1080', { 'demo:': 1080 })

// Called once per connection, on a socket to the proxy. Resolve and everything after
// belongs to the target; throw a ProxyError and the request fails with your words.
async function handshake({ socket, reader, proxy, target }) {
  socket.write(`GOTO ${authority(target)}\n`)
  const answer = (await reader.until('\n')).toString().trim()
  if (answer !== 'OPEN') throw new ProxyError(`the proxy answered ${answer}`)
}

const agents = createAgents({ proxy, handshake })

const response = await fetch('https://example.com', { agent: agents.https })
const socket = new Socket('wss://relay.example', { agent: agents.https }) // bare-ws
```

TLS to the target is negotiated inside the tunnel by `agents.https`, so the certificate is
checked against the host that was asked for, not against the proxy. A proxy url that is
itself TLS (`secure: true`) is reached over TLS as well.

## API

#### `createAgents(tunnel[, opts])`

`{ http, https }` — an agent for `http:` targets and one for `https:` ones. `tunnel` is
`{ proxy, handshake, timeout }`; `opts` goes to `bare-http1`'s `Agent` (keep-alive is on by
default). `ProxyHTTPAgent` and
`ProxyHTTPSAgent` are exported for subclassing.

#### `new ProxySocket({ proxy, handshake, timeout }, { host, port })`

The connection itself, a `bare-stream` `Duplex`. Writes made before the handshake finishes
are held and go out after, which is what lets a TLS socket be layered straight on top.
`timeout` (default 30s) is how long the proxy has to answer its own handshake — a port that
is listening but is not a proxy says nothing at all.

#### `handshake({ socket, reader, proxy, target })`

Yours to write. `reader.read(n)` resolves exactly `n` bytes and `reader.until(delimiter)`
everything up to and including it; anything read past the end of the handshake is kept and
handed to the stream, so a target that answers immediately loses nothing.

#### `parseProxyUrl(url, ports)`

`{ protocol, host, port, username, password, secure }`, with `ports` giving the default port
per scheme. Host and port only — a path or a query is refused rather than guessed at. An
IPv6 host comes back without its brackets; `authority({ host, port })` puts them back.

#### `proxyName(proxy)` · `authority(target)` · `hasCredentials(proxy)`

Small shared helpers for writing a handshake's errors and requests.

#### `ProxyError` · `proxyErrorIn(err)`

Everything that goes wrong on the way through a proxy, carrying `code: 'PROXY_ERROR'`.
`bare-fetch` reports every failure as `NETWORK_ERROR: Network error` and keeps the reason as
its cause, and a library above it may wrap that again — `proxyErrorIn` digs the reason back
out, which is what the person whose proxy is not running needs to read.

## Compared to Node's proxy agents

Node's proxy agents share [`agent-base`](https://www.npmjs.com/package/agent-base), which
subclasses `http.Agent` and asks a subclass for `connect(req, opts)`. This package is the
same idea against `bare-http1`, whose agent asks for `createConnection(opts)` instead — and
which, unlike `agent-base`, tells an agent nothing about whether the target is `https:`.
That is the one difference callers feel: an agent per target protocol rather than one for
both, which is why `createAgents()` returns a pair.

`agent-base` itself cannot be reused: Bare has no `net`, `tls` or `http` builtins, and it is
written against Node's `http.Agent` internals.

## Licence

Apache-2.0
