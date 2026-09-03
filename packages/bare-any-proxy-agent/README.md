# bare-any-proxy-agent

One entry point for every proxy scheme [Bare](https://github.com/holepunchto/bare) speaks —
`socks5:`, `socks5h:`, `http:`, `https:`. Hand it a proxy url of any of them and get back the
agents to use it with. Node's [`proxy-agent`](https://www.npmjs.com/package/proxy-agent).

This is what a program wants when the proxy url comes from a user or from the environment
rather than from its own source: the scheme is then a fact about the url, not a choice, and
the difference between `socks5://` and `http://` stops being the program's business.

Nothing is implemented here — this is the table. The protocols live in
[`bare-socks-proxy-agent`](../bare-socks-proxy-agent),
[`bare-http-proxy-agent`](../bare-http-proxy-agent) and
[`bare-https-proxy-agent`](../bare-https-proxy-agent), and the shared half in
[`bare-proxy-agent`](../bare-proxy-agent).

## Usage

```js
import { createAgents } from 'bare-any-proxy-agent'

const agents = createAgents('socks5://127.0.0.1:1080') // or http://, https://, socks5h://

const response = await fetch('https://example.com', { agent: agents.https })
const socket = new Socket('wss://relay.example', { agent: agents.https }) // bare-ws
```

Together with [`bare-proxy-from-env`](../bare-proxy-from-env), which is the pairing Node's
`proxy-agent` has built in:

```js
import { getProxyForUrl } from 'bare-proxy-from-env'
import { createAgents } from 'bare-any-proxy-agent'

const url = getProxyForUrl('https://example.com')
const agents = url ? createAgents(url) : null
```

## API

#### `createAgents(proxy[, opts])`

`{ http, https }` — an agent for `http:` targets and one for `https:` ones, both going
through `proxy`. `proxy` is a url string, a `URL`, or something `parse()` returned; `opts`
goes to the agent the scheme calls for.

Which of the two a request needs is the caller's to pick, and it is the target's scheme that
decides: `http:` and `ws:` take `agents.http`, `https:` and `wss:` take `agents.https`.

#### `parse(proxy)`

The proxy url, read by the package that speaks its scheme. Throws with the schemes named for
one that nothing here speaks — a proxy url that cannot be honoured is better refused than
quietly ignored, since going direct is exactly what whoever set it was trying to prevent. A
url with no port is refused for its own reason: every scheme here has a port some client
treats as its default and no two agree, so none of them is guessed.

#### `protocols`

`['socks5', 'socks5h', 'http', 'https']`.

#### `ProxyError` · `proxyErrorIn(err)` · `proxyName(proxy)`

Re-exported from [`bare-proxy-agent`](../bare-proxy-agent), so a program that dispatches
through this package needs nothing else to report what went wrong or to name the proxy it
went wrong at.

## How an http proxy is used

Two ways, decided by where the request is going, which is the same split Node makes between
`http-proxy-agent` and `https-proxy-agent`:

- **`http:` target** — forwarded, with the whole url in the request line, for the proxy to
  make onwards. The form every http proxy must accept: a proxy that allows `CONNECT` to port
  443 only, a common Squid default, takes this and would refuse a tunnel to port 80.
- **`https:` target** — a `CONNECT` tunnel, with TLS negotiated end to end inside it. There
  is nothing to forward: the proxy carries ciphertext and never reads it.

A `socks5:` proxy has no such split; both agents make the same kind of connection.

## Compared to Node's `proxy-agent`

|             | Node                                                                  | here                                             |
| ----------- | --------------------------------------------------------------------- | ------------------------------------------------ |
| shape       | `new ProxyAgent(opts)`, one agent for every scheme and both endpoints | `createAgents(proxy, opts)` returning a pair     |
| proxy url   | `opts.getProxyForUrl`, called per request                             | passed in, one proxy per pair                    |
| caching     | agents cached per proxy url on the instance                           | none — the pair _is_ the cache                   |
| `protocols` | `ProxyAgent.protocols`                                                | a module export; there is no class to hang it on |
| PAC         | `pac+http:`, `pac+file:` … via `pac-proxy-agent`                      | not supported                                    |

The shape is the difference everything else follows from. Node's `ProxyAgent` is one object
that decides per request, because `agent-base` tells an agent both the target url and whether
the endpoint is secure; bare-http1 tells an agent neither — it asks for a connection and gets
one. So the scheme is resolved once, up front, and the two things an agent cannot work out
for itself become two agents. A program that needs a different proxy per destination calls
`createAgents` per proxy and keeps the pairs, which is what Node's cache amounts to.

PAC would be the real addition: `pac-proxy-agent` is what makes Node's `ProxyAgent` able to
answer "which proxy for this url" with a script rather than a variable. It needs a sandbox to
run the script in and a resolver for its helper functions — `bare-vm` and `bare-dns` — and
nothing here is shaped to rule it out later.

## Licence

Apache-2.0
