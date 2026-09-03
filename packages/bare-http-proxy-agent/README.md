# bare-http-proxy-agent

A forwarding http proxy agent for [Bare](https://github.com/holepunchto/bare) — for
`bare-fetch`, `bare-ws`, and anything else that takes a `bare-http1` agent.

Named for what Node's `http-proxy-agent` does: send the request to the proxy with the whole
url in the request line (`GET http://mint.example/v1/info HTTP/1.1`, what RFC 9112 §3.2.2
calls absolute-form) and let the proxy make it onwards.

`http:` targets only. The proxy makes the request, so there is no end-to-end connection for
TLS to run over — for `https:` use [`bare-https-proxy-agent`](../bare-https-proxy-agent),
whose CONNECT tunnel leaves TLS to the target intact.

## Usage

```js
import { HttpProxyAgent } from 'bare-http-proxy-agent'

const agent = new HttpProxyAgent('http://proxy.lan:3128')

const response = await fetch('http://example.com', { agent })
```

With credentials, which are sent as `Proxy-Authorization: Basic`:

```js
new HttpProxyAgent('http://me:s3cret@proxy.lan:3128')
```

An `https://` proxy url means the first hop is itself TLS, so the request — and any
credentials on it — is encrypted to the proxy rather than sent in the clear:

```js
new HttpProxyAgent('https://proxy.example:443')
```

### What the proxy sees

All of it. A forwarded request is made by the proxy, so it reads the url, the headers and
the body, and the response comes back the same way. That is the trade against a tunnel: a
proxy that will not `CONNECT` to port 80 will forward this, and in exchange it sees what it
is forwarding. Nothing is added here beyond what the method needs — no user agent, no
cookies — but nothing that was already in the request is hidden either.

## An https: target is refused

Every agent for `http:` targets — this one, and the SOCKS and CONNECT ones — writes the
request to whatever it opened with nothing negotiated on top. So a target on port 443 means
an `https:` url has reached the agent built for `http:`, and carrying it would send in the
clear what was asked for in confidence. That is refused with a `ProxyError` before anything
is written.

It is not a hypothetical. `bare-fetch` follows redirects itself and keeps, for every hop, the
agent it was handed — but an agent under bare-http1 _is_ the scheme, since it is the thing
that decides whether TLS runs. So an `http:` url that redirects to an `https:` one arrives at
the wrong agent. A caller that follows redirects itself should re-pick the agent per hop; one
that cannot should treat a response whose final url changed scheme as a failure, because the
guard only covers the default port.

## API

#### `new HttpProxyAgent(proxy[, opts])`

An agent for `http:` targets. `proxy` is a url string, a `URL`, or the result of `parse()`;
`opts` goes to `bare-http1`'s `Agent`, with `opts.headers` taken as below. Keep-alive is on
by default, so the connection to the proxy is reused rather than rebuilt per request.

#### `agent.proxyHeaders`

Headers to send to the proxy with each request, as an object or as a function called per
request. `opts.headers` sets it.

#### `parse(url)`

`{ protocol, host, port, username, password, secure }` for an `http://` or `https://` proxy
url, `secure` saying whether the proxy itself is reached over TLS. Host and port only — a
path or a query is refused rather than guessed at, and so is a missing port. There is no
default worth having: `http-proxy-agent` reads a port-less proxy url as port 80, curl reads
it as 1080, and 8080 is where proxies actually tend to listen. A guess that lands on the
wrong service is handed the `Proxy-Authorization` header before anything notices, and the
port is one word that only the person configuring it knows.

#### `ProxyError` · `proxyErrorIn(err)`

Re-exported from [`bare-proxy-agent`](../bare-proxy-agent). Note that a forwarding proxy
reports its own failures as ordinary http responses — a 407 asking for credentials, a 502
saying it could not reach the target — so they arrive as responses, not as a `ProxyError`.
What is left for `ProxyError` is failing to reach the proxy at all.

## Compared to Node's `http-proxy-agent`

The surface follows [`http-proxy-agent`](https://www.npmjs.com/package/http-proxy-agent)
wherever it can: `new HttpProxyAgent(url | URL | parsed, opts)`, `static protocols`,
`agent.proxy`, `agent.proxyHeaders` (function form included), `opts` passed through to the
underlying `Agent`, and the same headers on the wire — `Proxy-Authorization` from the url's
credentials, `Proxy-Connection` unless the caller already set one. What differs is forced by
Bare:

|                   | Node                                                | here                                                                     |
| ----------------- | --------------------------------------------------- | ------------------------------------------------------------------------ |
| base class        | `agent-base`'s `Agent`, over `http.Agent`           | `bare-http1`'s `Agent`                                                   |
| socket hook       | `connect(req, opts)` returning a socket or an agent | `createConnection(opts)` returning a socket                              |
| rewrite point     | `addRequest`, assigning `req.path`                  | `addRequest`, deferred to the request's `_header()`                      |
| `agent.proxy`     | a `URL`                                             | the parsed `{ protocol, host, port, … }`; `agent.proxyUrl` is the string |
| handshake timeout | `opts.timeout`                                      | n/a — there is no handshake to time out                                  |

The rewrite point is the only one with teeth. Node assigns `req.path` and calls
`req.setHeader` from `addRequest`; under bare-http1 `addRequest` is called from the
`ClientRequest` constructor _before_ it assigns `_path` and `_headers`, so anything written
there is overwritten a line later. The agent instead shadows the request's `_header()` — the
one place the request line is actually made, called once when the headers are flushed — and
applies the same edit with the same values there. Callers see no difference; anyone reading
`req.path` between construction and the first write would.

Nothing in the Node stack can be reused as it stands: Bare has no `net`, `tls` or `http`
builtins, and `agent-base` is written against Node's `http.Agent` internals.

`onProxyAuth` and `negotiate` (NTLM/Kerberos negotiation) have no equivalent here.

## Licence

Apache-2.0
