// The policy a run is under: which agent a request gets, what each flag refuses to
// half-apply, and that a proxy failure reaches the user in words they can act on.
//
// The proxy protocols themselves are tested where they live — packages/bare-socks-proxy-agent,
// packages/bare-http-proxy-agent and packages/bare-https-proxy-agent. What is tested here is
// the wiring: that configuring a proxy actually moves this wallet's traffic, global fetch and
// all.
import '../lib/polyfills.mjs'
import test from 'brittle'
import tcp from 'bare-tcp'
import http from 'bare-http1'
import { proxyErrorIn } from 'bare-proxy-agent'
import { HttpProxyAgent } from 'bare-http-proxy-agent'
import { HttpsProxyHTTPSAgent } from 'bare-https-proxy-agent'
import process from 'bare-process'
import { isWindows } from 'which-runtime'
import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import { openWallet, useMint } from '../lib/manager.mjs'
import {
  configureNetwork,
  clearNetwork,
  agentFor,
  dhtOptions,
  networkPolicy,
  proxyFailure,
  proxyInForce,
  interfaceInForce
} from '../lib/net.mjs'

let counter = 0

test('with a proxy configured, a plain fetch goes through it', async (t) => {
  t.teardown(clearNetwork)
  const origin = await server(t)
  const proxy = await socks5(t)
  configureNetwork({ proxy: `socks5://127.0.0.1:${proxy.port}` })

  // No agent passed: the wrapper installed by lib/polyfills.mjs is what puts it there, which
  // is the only reason coco's own mint requests are proxied too.
  const response = await fetch(`http://127.0.0.1:${origin.port}/hello`)

  t.is(await response.text(), 'hello from the origin')
  t.alike(proxy.asked, [{ host: '127.0.0.1', port: origin.port }])
  t.is(origin.seen[0].from, '127.0.0.1', 'the origin saw the proxy, not us')
})

test('a proxy that cannot be reached says so, not "Network error"', async (t) => {
  t.teardown(clearNetwork)
  const port = await listener(t, (socket) => socket.destroy())
  configureNetwork({ proxy: `socks5://127.0.0.1:${port}` })

  // What is being checked is that the proxy is named as the reason, rather than buried
  // under bare-fetch's `NETWORK_ERROR: Network error`. Not how it is phrased: a proxy that
  // accepts and then drops us sends a FIN on Linux and macOS, read as a clean close, and a
  // reset on Windows, read as an error — one event the operating system reports two ways,
  // and the reader (packages/bare-proxy-agent/lib/reader.mjs) has different words for each.
  // Pinning either wording here only pins the platform this ran on.
  let failure = null
  try {
    await fetch('https://mint.example/v1/info')
  } catch (err) {
    failure = err
  }
  t.ok(failure, 'the request fails')
  const reason = proxyErrorIn(failure)
  t.is(reason?.code, 'PROXY_ERROR', 'the proxy is the reason, not "Network error"')
  t.ok(reason?.message.includes(`127.0.0.1:${port}`), 'and it says which proxy')
})

// The shape that hangs CI: a host that accepts the connection and then says nothing. Bare's
// fetch waits on that for as long as the host cares to hold it, so without a deadline of our
// own `give` sits there with the proofs reserved and nothing on screen to say why.
test('a host that accepts and then says nothing is given up on', async (t) => {
  t.teardown(clearNetwork)
  // Accepts, reads the request, never writes a byte back.
  const port = await listener(t, () => {})
  configureNetwork({ requestTimeout: 150 })

  const started = Date.now()
  let failure = null
  try {
    await fetch(`http://127.0.0.1:${port}/v1/swap`)
  } catch (err) {
    failure = err
  }

  t.ok(failure, 'the request ends rather than hanging')
  t.is(failure?.code, 'REQUEST_TIMEOUT', 'and says it was us who stopped it')
  t.ok(failure?.message.includes(`127.0.0.1:${port}`), 'naming the host that went quiet')
  t.ok(Date.now() - started < 5000, 'at roughly the deadline, not whenever the host feels like it')
})

test('a request that answers is not stopped, and leaves no timer behind', async (t) => {
  t.teardown(clearNetwork)
  const origin = await server(t)
  configureNetwork({ requestTimeout: 150 })

  // Well inside the deadline. The point is the other half: a cleared timer, so the loop is
  // not held open by a deadline for a request that already came back.
  const response = await fetch(`http://127.0.0.1:${origin.port}/hello`)
  t.is(await response.text(), 'hello from the origin')
})

test('a proxy failure is found again under a library that rewrapped it', (t) => {
  t.teardown(clearNetwork)
  configureNetwork({ proxy: 'socks5://127.0.0.1:9050' })

  // What coco does with an unreachable mint: its own message, ours underneath, and the
  // code lost on the way.
  const underneath = new Error('could not reach the proxy at socks5://127.0.0.1:9050: refused')
  const wrapped = new Error('Failed to fetch mint https://mint.example', { cause: underneath })
  t.is(proxyFailure(wrapped), underneath)
  t.is(proxyFailure(new Error('the wallet is locked')), null, 'and nothing else is mistaken for it')
})

test('every scheme we claim to speak picks an agent, and nothing else is accepted', (t) => {
  t.teardown(clearNetwork)
  for (const url of [
    'socks5://127.0.0.1:9050',
    'socks5h://127.0.0.1:9050',
    'http://127.0.0.1:3128',
    'https://proxy.example:443'
  ]) {
    clearNetwork()
    configureNetwork({ proxy: url })
    t.ok(agentFor('https://mint.example'), url)
  }
  clearNetwork()
  t.exception.all(
    () => configureNetwork({ proxy: 'ftp://127.0.0.1:21' }),
    /unsupported proxy scheme/
  )
  t.exception.all(() => configureNetwork({ proxy: 'not a url' }), /not a proxy url/)
})

// An http proxy does two different jobs, and which one a request gets is decided here rather
// than by the proxy: a target the proxy can read is forwarded to it, and one it cannot is
// asked for as a tunnel. Node splits these over http-proxy-agent and https-proxy-agent, and
// so do we.
test('an http proxy forwards http targets and tunnels https ones', (t) => {
  t.teardown(clearNetwork)
  configureNetwork({ proxy: 'http://127.0.0.1:3128' })

  t.ok(agentFor('http://mint.example') instanceof HttpProxyAgent, 'http: is forwarded')
  t.ok(agentFor('https://mint.example') instanceof HttpsProxyHTTPSAgent, 'https: is tunnelled')
  t.is(agentFor('ws://relay.example'), agentFor('http://mint.example'), 'ws: is http')
  t.is(agentFor('wss://relay.example'), agentFor('https://mint.example'), 'wss: is https')
})

test('--proxy picks the agent, and leaves the wires it was never going to carry alone', (t) => {
  t.teardown(clearNetwork)
  configureNetwork({ proxy: 'socks5://127.0.0.1:9050' })

  t.ok(agentFor('https://mint.example'), 'https requests get an agent')
  t.ok(agentFor('wss://relay.example'), 'so do relays')
  t.is(agentFor('https://mint.example'), agentFor('wss://relay.example'), 'the same one')
  t.unlike(agentFor('http://mint.example'), agentFor('https://mint.example'))
  t.is(networkPolicy().proxyName, 'socks5://127.0.0.1:9050')
  t.alike(proxyInForce(), { name: 'socks5://127.0.0.1:9050', source: '--proxy' })

  // The hyperdht and the local network were never http, so a proxy neither carries them nor
  // stops them: `give --dht` swaps at the mint through the proxy and hands over directly.
  t.alike(dhtOptions(), {}, 'a proxy binds nothing')
})

test('a proxy named for this wallet is exempt from no_proxy', (t) => {
  t.teardown(withEnv({ no_proxy: 'mint.example,*' }))
  t.teardown(clearNetwork)
  configureNetwork({ proxy: 'socks5://127.0.0.1:9050' })

  t.ok(agentFor('https://mint.example'), 'the flag covers everything, no exceptions')
  t.ok(agentFor('https://anything.example'))
})

test('the environment is read the way curl reads it', (t) => {
  t.teardown(
    withEnv({
      https_proxy: 'socks5://127.0.0.1:1080',
      http_proxy: 'http://proxy.lan:3128'
    })
  )
  t.teardown(clearNetwork)
  configureNetwork({})

  t.is(networkPolicy().proxyName, 'socks5://127.0.0.1:1080', 'https_proxy for https')
  t.is(networkPolicy().source, 'https_proxy')
  t.ok(agentFor('https://mint.example'))
  t.ok(agentFor('http://mint.example'))
})

// The one thing Windows cannot be asked: its environment folds case, so HTTP_PROXY and
// http_proxy are a single variable and there is no upper case spelling to ignore. curl
// documents the same hole. What the mitigation is for — a CGI process reading a `Proxy:`
// request header out of its environment — is not a shape this wallet is ever run in, so the
// platform where it cannot be tested is also the one where it does not arise.
test(
  'http_proxy is read in lower case only, so a Proxy: header cannot set it',
  { skip: isWindows },
  (t) => {
    t.teardown(withEnv({ HTTP_PROXY: 'socks5://attacker.example:9050' }))
    t.teardown(clearNetwork)
    configureNetwork({})

    t.is(agentFor('http://mint.example'), null, 'the upper case spelling is ignored')
    t.is(networkPolicy().proxyName, null)
  }
)

// Two spellings of one name is a thing only a case-sensitive environment has.
test('the lower case spelling wins where a name has two', { skip: isWindows }, (t) => {
  t.teardown(withEnv({ https_proxy: 'socks5://127.0.0.1:1080', HTTPS_PROXY: 'socks5://x:9' }))
  t.teardown(clearNetwork)
  configureNetwork({})
  t.is(networkPolicy().proxyName, 'socks5://127.0.0.1:1080')
})

test('ALL_PROXY covers a scheme with no proxy of its own', (t) => {
  t.teardown(withEnv({ ALL_PROXY: 'socks5://127.0.0.1:1080' }))
  t.teardown(clearNetwork)
  configureNetwork({})
  // Which spelling it came from is not knowable on windows, where the two are one variable
  // and `spelling()` reports whichever it looks up first. That it is the fallback rather
  // than a scheme's own proxy is the whole of what this asserts.
  t.is(networkPolicy().source.toLowerCase(), 'all_proxy')
  t.ok(agentFor('https://mint.example'))
  t.ok(agentFor('http://mint.example'))
})

test('a scheme-less value means http, as the convention has it', (t) => {
  t.teardown(withEnv({ all_proxy: '127.0.0.1:3128' }))
  t.teardown(clearNetwork)
  configureNetwork({})
  t.is(networkPolicy().proxyName, 'http://127.0.0.1:3128')
})

test('no_proxy carves holes in a proxy that came from the environment', (t) => {
  t.teardown(
    withEnv({
      ALL_PROXY: 'socks5://127.0.0.1:1080',
      no_proxy: 'local.com, 10.0.0.0/8, 127.0.0.1'
    })
  )
  t.teardown(clearNetwork)
  configureNetwork({})

  t.is(agentFor('https://local.com'), null, 'the name itself')
  t.is(agentFor('https://www.local.com'), null, 'and a domain under it')
  t.is(agentFor('https://local.com:8443'), null, 'whatever port it is on')
  t.ok(agentFor('https://www.notlocal.com'), 'but not one that merely ends the same way')
  t.is(agentFor('https://10.4.3.2'), null, 'an address inside a CIDR block')
  t.ok(agentFor('https://11.4.3.2'), 'and not one outside it')
  t.is(agentFor('http://127.0.0.1:3338'), null, 'a bare address')
  t.ok(agentFor('https://mint.example'), 'everything else still goes through')
})

test('no_proxy of * sends everything direct', (t) => {
  t.teardown(withEnv({ ALL_PROXY: 'socks5://127.0.0.1:1080', NO_PROXY: '*' }))
  t.teardown(clearNetwork)
  configureNetwork({})
  t.is(agentFor('https://mint.example'), null)
})

test('--dht-interface binds the hyperdht and leaves everything else alone', (t) => {
  t.teardown(clearNetwork)
  configureNetwork({ iface: '127.0.0.1' })

  t.alike(dhtOptions(), { host: '127.0.0.1' }, 'the one thing the flag does')
  t.is(interfaceInForce(), '127.0.0.1', 'as it was spelled, for saying what it reached')
  // It pins a socket the hyperdht opens. It is not a policy on anything else, so a request
  // that cannot be bound is made rather than refused — see the note bin.mjs prints instead.
  t.is(agentFor('https://mint.example'), null, 'and nothing about how a mint is reached')
})

test('an interface this host does not have is a mistake in the command line', (t) => {
  t.teardown(clearNetwork)
  t.exception.all(() => configureNetwork({ iface: 'nope0' }), /no interface or local address/)
})

test('nothing is proxied or bound unless it was asked for', (t) => {
  t.teardown(clearNetwork)
  t.is(agentFor('https://mint.example'), null)
  t.alike(dhtOptions(), {})
  t.is(proxyInForce(), null)
  t.is(interfaceInForce(), null)
})

// The load-bearing assumption of the whole feature: coco reaches a mint through global
// fetch, so wrapping that (lib/polyfills.mjs) is what puts every mint request behind
// --proxy — including the ones this wallet never sees, made from inside coco's own rate
// limiter. Nothing here asserts it, which is why coco is driven at a mint for real below
// rather than tested at the wrapper.
//
// The mint is an ordinary http server that answers nothing a mint would, so `addMint`
// fails. That is not what is being checked: what is being checked is that the SOCKS proxy
// was the one asked to reach it. If a future coco built its own http client, or took a
// reference to fetch before lib/polyfills.mjs installed the wrapper, the request would go
// straight out and `asked` would be empty — the wallet quietly unproxied, which is exactly
// the failure this pins.
test('coco reaches a mint through the proxy, not around it', async (t) => {
  t.teardown(clearNetwork)
  const origin = await server(t)
  const proxy = await socks5(t)
  configureNetwork({ proxy: `socks5://127.0.0.1:${proxy.port}` })

  const dir = path.join(os.tmpdir(), `cashme-net-${os.pid()}-${counter++}`)
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))
  const wallet = await openWallet(dir)
  t.teardown(() => wallet.close())

  // It will not be a mint at the other end. All that matters is who did the reaching.
  await t.execution(
    useMint(wallet, `http://127.0.0.1:${origin.port}`).catch(() => {}),
    'the mint request is made'
  )

  t.alike(
    proxy.asked,
    [{ host: '127.0.0.1', port: origin.port }],
    "the proxy was asked for the mint, so coco's requests are behind --proxy"
  )
  t.is(origin.seen[0]?.from, '127.0.0.1', 'and the mint saw the proxy rather than us')
})

// Set the environment for one test and put it back, whatever it held before — these tests
// run in the process that inherited the developer's own shell.
// Every name a proxy could be read from, in both spellings, so nothing leaks in from the
// shell that started the run.
const PROXY_VARS = [
  'http_proxy',
  'HTTP_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
  'no_proxy',
  'NO_PROXY',
  'CASHME_PROXY'
]

function withEnv(values) {
  const before = new Map()

  // Cleared first and set second, rather than the other way about. On Windows the
  // environment is case-insensitive, so `all_proxy` and `ALL_PROXY` are one variable —
  // clearing after setting would wipe the value the test just asked for, and did.
  for (const name of PROXY_VARS) {
    before.set(name, process.env[name])
    process.env[name] = ''
  }
  for (const [name, value] of Object.entries(values)) {
    if (!before.has(name)) before.set(name, process.env[name])
    process.env[name] = value
  }

  // On Windows a name and its other spelling restore the same variable twice, to the value
  // they both read at the start. Harmless, and it keeps this list one shape everywhere.
  return () => {
    for (const [name, value] of before) process.env[name] = value ?? ''
  }
}

// Enough SOCKS5 to answer the wallet: greet, connect to 127.0.0.1 on the port asked for,
// pipe. The protocol has its own tests in packages/bare-socks-proxy-agent.
function socks5(t) {
  const asked = []

  const port = listener(t, (socket) => {
    let stage = 'greeting'
    let buffer = Buffer.alloc(0)
    let upstream = null

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data])
      step()
    })

    function step() {
      if (stage === 'greeting') {
        if (buffer.byteLength < 2) return
        const count = buffer[1]
        if (buffer.byteLength < 2 + count) return
        buffer = buffer.subarray(2 + count)
        socket.write(Buffer.from([5, 0]))
        stage = 'request'
        return step()
      }

      if (stage === 'request') {
        if (buffer.byteLength < 5) return
        const type = buffer[3]
        let host
        let offset
        if (type === 3) {
          const length = buffer[4]
          if (buffer.byteLength < 7 + length) return
          host = buffer.subarray(5, 5 + length).toString()
          offset = 5 + length
        } else {
          if (buffer.byteLength < 10) return
          host = Array.from(buffer.subarray(4, 8)).join('.')
          offset = 8
        }
        const port = (buffer[offset] << 8) | buffer[offset + 1]
        buffer = buffer.subarray(offset + 2)
        asked.push({ host, port })

        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
        upstream = tcp.createConnection({ port, host: '127.0.0.1' })
        upstream.on('data', (data) => socket.write(data))
        upstream.on('error', () => socket.destroy())
        upstream.on('close', () => socket.destroy())
        socket.on('close', () => upstream.destroy())
        stage = 'tunnel'
        return step()
      }

      if (buffer.byteLength > 0) {
        upstream.write(buffer)
        buffer = Buffer.alloc(0)
      }
    }
  })

  return port.then((port) => ({ port, asked }))
}

function server(t) {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push({ from: req.socket.remoteAddress, url: req.url })
    res.end('hello from the origin')
  })
  close(t, server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen }))
  })
}

function listener(t, onconnection) {
  const server = tcp.createServer((socket) => {
    socket.on('error', () => socket.destroy())
    onconnection(socket)
  })
  close(t, server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

// A server does not finish closing while a connection is open, and the agents keep one open
// between requests. So the connections come down with it.
function close(t, server) {
  const open = new Set()
  server.on('connection', (socket) => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
  })
  t.teardown(
    () =>
      new Promise((resolve) => {
        for (const socket of open) socket.destroy()
        server.close(resolve)
      })
  )
}
