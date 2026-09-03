// The table: that every scheme lands on the package that speaks it, and that one nothing
// speaks is refused rather than passed over.
import test from 'brittle'
import { HttpProxyAgent } from 'bare-http-proxy-agent'
import { HttpsProxyHTTPAgent, HttpsProxyHTTPSAgent } from 'bare-https-proxy-agent'
import { SocksProxyHTTPAgent, SocksProxyHTTPSAgent } from 'bare-socks-proxy-agent'
import { createAgents, parse, protocols, proxyName } from '../index.mjs'

test('every scheme there is an agent for', (t) => {
  t.alike(protocols, ['socks5', 'socks5h', 'http', 'https'])
})

test('a socks proxy makes a pair of socks agents', (t) => {
  const agents = destroyed(t, createAgents('socks5://127.0.0.1:1080'))
  t.ok(agents.http instanceof SocksProxyHTTPAgent)
  t.ok(agents.https instanceof SocksProxyHTTPSAgent)
  t.is(agents.http.proxyUrl, 'socks5://127.0.0.1:1080')
})

test('socks5h is the same proxy, spelled the way it was configured', (t) => {
  const agents = destroyed(t, createAgents('socks5h://127.0.0.1:1080'))
  t.ok(agents.https instanceof SocksProxyHTTPSAgent)
  t.is(agents.https.proxyUrl, 'socks5h://127.0.0.1:1080')
})

// The one scheme where the two agents are not the same protocol: an http: target is
// forwarded to the proxy, an https: one is asked for as a tunnel.
test('an http proxy forwards http targets and tunnels https ones', (t) => {
  const agents = destroyed(t, createAgents('http://127.0.0.1:3128'))
  t.ok(agents.http instanceof HttpProxyAgent, 'forwarded')
  t.ok(agents.https instanceof HttpsProxyHTTPSAgent, 'tunnelled')
  t.absent(
    agents.https instanceof HttpsProxyHTTPAgent,
    'and not through the tunnel meant for http:'
  )
})

test('an https proxy is the same, reached over TLS', (t) => {
  const agents = destroyed(t, createAgents('https://proxy.example:8443'))
  t.ok(agents.http instanceof HttpProxyAgent)
  t.ok(agents.https instanceof HttpsProxyHTTPSAgent)
  t.is(agents.http.proxy.secure, true, 'the first hop is TLS')
  t.is(agents.http.proxy.port, 8443)
})

// Every scheme here has a port some client somewhere treats as its default, and no two agree
// — so none of them is guessed. The one word costs less than a Proxy-Authorization header
// handed to whatever was listening on the guess.
test('a proxy url with no port is refused, whatever its scheme', (t) => {
  for (const url of ['http://proxy.lan', 'https://proxy.lan', 'socks5://127.0.0.1']) {
    t.exception.all(() => parse(url), /names no port/, url)
    t.exception.all(() => createAgents(url), /names no port/, url)
  }
})

test('a url is read once, and what it read can be handed back', (t) => {
  const proxy = parse('socks5://me:s3cret@127.0.0.1:1080')
  t.is(proxyName(proxy), 'socks5://127.0.0.1:1080', 'the address, never the password')

  const agents = destroyed(t, createAgents(proxy))
  t.is(agents.http.proxy, proxy, 'the same object, not parsed a second time')
})

test('a URL is taken as readily as a string', (t) => {
  const agents = destroyed(t, createAgents(new URL('http://proxy.lan:3128')))
  t.is(agents.http.proxyUrl, 'http://proxy.lan:3128')
})

test('a scheme nothing here speaks is refused, with the ones it does named', (t) => {
  t.exception.all(() => parse('ftp://127.0.0.1:21'), /unsupported proxy scheme ftp:/)
  t.exception.all(
    () => parse('ftp://127.0.0.1:21'),
    /socks5:\/\/, socks5h:\/\/, http:\/\/, https:\/\//
  )
  t.exception.all(() => createAgents('ftp://127.0.0.1:21'), /unsupported proxy scheme/)
  t.exception.all(() => parse('not a url'), /not a proxy url/)
  t.exception.all(() => parse('http://proxy.lan/path'), /a host and a port only/)
})

test('options reach the agent the scheme called for', (t) => {
  const agents = destroyed(
    t,
    createAgents('http://proxy.lan:3128', { headers: { 'X-Probe': '1' } })
  )
  t.alike(agents.http.proxyHeaders, { 'X-Probe': '1' })
})

function destroyed(t, agents) {
  t.teardown(() => {
    agents.http.destroy()
    agents.https.destroy()
  })
  return agents
}
