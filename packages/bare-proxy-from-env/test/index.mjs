// The convention, read the way curl reads it.
import test from 'brittle'
import process from 'bare-process'
import {
  bypassed,
  fromEnv,
  getProxyForUrl,
  noProxy,
  normalize,
  parseNoProxy,
  proxyForProtocol
} from '../index.mjs'

test('a scheme is read from its own variable, in either case', (t) => {
  t.teardown(withEnv({ https_proxy: 'http://secure.lan:3128' }))
  t.alike(proxyForProtocol('https:'), { url: 'http://secure.lan:3128', source: 'https_proxy' })
  t.is(proxyForProtocol('http:'), null, 'and not from another scheme’s')
})

test('the lower case spelling wins where both are set', (t) => {
  t.teardown(withEnv({ https_proxy: 'http://lower.lan:1', HTTPS_PROXY: 'http://upper.lan:2' }))
  t.is(proxyForProtocol('https:').url, 'http://lower.lan:1')
})

// Under CGI a request header `Proxy: ...` arrives as HTTP_PROXY, so honouring the upper case
// spelling would let whoever sent the request choose the proxy.
test('http_proxy is read in lower case only', (t) => {
  t.teardown(withEnv({ HTTP_PROXY: 'http://attacker.example:3128' }))
  t.is(proxyForProtocol('http:'), null)
  t.is(getProxyForUrl('http://mint.example'), '')
})

test('ALL_PROXY covers a scheme with no proxy of its own', (t) => {
  t.teardown(withEnv({ all_proxy: 'socks5://127.0.0.1:1080', https_proxy: 'http://secure.lan:1' }))
  t.is(proxyForProtocol('http:').url, 'socks5://127.0.0.1:1080')
  t.is(proxyForProtocol('http:').source, 'all_proxy')
  t.is(proxyForProtocol('https:').url, 'http://secure.lan:1', 'a scheme’s own still wins')
})

test('a variable set to nothing is not set', (t) => {
  t.teardown(withEnv({ https_proxy: '', HTTPS_PROXY: 'http://upper.lan:2' }))
  t.is(proxyForProtocol('https:').url, 'http://upper.lan:2', 'the empty one does not win the ??')
  t.is(fromEnv('https_proxy'), null)
})

test('websockets are read as the scheme they are an upgrade of', (t) => {
  t.teardown(withEnv({ https_proxy: 'http://secure.lan:1', http_proxy: 'http://plain.lan:2' }))
  t.is(proxyForProtocol('wss:').url, 'http://secure.lan:1')
  t.is(proxyForProtocol('ws:').url, 'http://plain.lan:2')
})

test('a scheme-less value is a proxy reached over http', (t) => {
  t.is(normalize('127.0.0.1:3128'), 'http://127.0.0.1:3128')
  t.is(normalize(' socks5://127.0.0.1:1080 '), 'socks5://127.0.0.1:1080', 'trimmed, not touched')
  t.is(normalize('ftp://127.0.0.1:21'), 'ftp://127.0.0.1:21', 'even one nothing can speak')
})

test('no_proxy carves holes by name, by domain, by address and by block', (t) => {
  const bypass = parseNoProxy('local.com, .dotted.com, *.starred.com, 10.0.0.0/8, 127.0.0.1:8080')

  t.ok(bypassed(bypass, 'local.com'))
  t.ok(bypassed(bypass, 'www.local.com'), 'and anything under it')
  t.absent(bypassed(bypass, 'www.notlocal.com'), 'but not a name that merely ends the same way')
  t.ok(bypassed(bypass, 'www.dotted.com'), 'a leading dot is the same entry')
  t.ok(bypassed(bypass, 'www.starred.com'), 'and so is a leading *.')
  t.ok(bypassed(bypass, '10.1.2.3'), 'inside the block')
  t.absent(bypassed(bypass, '11.1.2.3'), 'outside it')
  t.ok(bypassed(bypass, '127.0.0.1'), 'the port on an entry is ignored')
  t.absent(bypassed(bypass, 'mint.example'))
})

test('no_proxy of * sends everything direct, and an unset one nothing', (t) => {
  t.ok(bypassed(parseNoProxy('*'), 'mint.example'))
  t.is(parseNoProxy(''), null)
  t.is(parseNoProxy('  ,  '), null)
  t.absent(bypassed(null, 'mint.example'), 'a null bypass exempts nothing')
})

test('getProxyForUrl answers with a url, or with the empty string', (t) => {
  t.teardown(withEnv({ https_proxy: 'http://secure.lan:3128', no_proxy: 'local.com' }))

  t.is(getProxyForUrl('https://mint.example/v1/info'), 'http://secure.lan:3128')
  t.is(getProxyForUrl(new URL('https://mint.example')), 'http://secure.lan:3128', 'a URL too')
  t.is(getProxyForUrl('https://www.local.com'), '', 'no_proxy is consulted here')
  t.is(getProxyForUrl('http://mint.example'), '', 'no proxy for this scheme')
  t.is(getProxyForUrl('not a url'), '', 'and nothing that is not a url')
})

test('no_proxy is read from the environment in either case', (t) => {
  t.teardown(withEnv({ NO_PROXY: 'mint.example' }))
  t.ok(bypassed(noProxy(), 'mint.example'))
})

// The variables are process-wide, so each test puts back what it found.
//
// Cleared to '' rather than deleted, which is what "not set" means to this package anyway:
// Bare's process.env does not take a delete. Cleared first and set second, because on
// Windows the environment is case-insensitive — `https_proxy` and `HTTPS_PROXY` are one
// variable there, and clearing after setting would wipe the value the test just asked for.
const VARS = [
  'http_proxy',
  'HTTP_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
  'no_proxy',
  'NO_PROXY'
]

function withEnv(vars) {
  const before = new Map()
  for (const name of VARS) {
    before.set(name, process.env[name])
    process.env[name] = ''
  }
  for (const [name, value] of Object.entries(vars)) {
    if (!before.has(name)) before.set(name, process.env[name])
    process.env[name] = value
  }

  return () => {
    for (const [name, value] of before) process.env[name] = value ?? ''
  }
}
