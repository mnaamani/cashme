// The policy a run is under: which agent a request gets, what each flag refuses to
// half-apply, and that a proxy failure reaches the user in words they can act on.
//
// The proxy protocols themselves are tested where they live — packages/bare-socks-proxy-agent
// and packages/bare-https-proxy-agent. What is tested here is the wiring: that configuring a
// proxy actually moves this wallet's traffic, global fetch and all.
import '../lib/polyfills.mjs'
import test from 'brittle'
import tcp from 'bare-tcp'
import http from 'bare-http1'
import {
  configureNetwork,
  clearNetwork,
  agentFor,
  assertUnbound,
  assertUnproxied,
  dhtOptions,
  networkPolicy,
  proxyFailure,
  updaterBlocked
} from '../lib/net.mjs'

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

  await t.exception(fetch('https://mint.example/v1/info'), /closed the connection/)
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

test('--proxy picks the agent, and stops the hyperdht rather than leak past it', (t) => {
  t.teardown(clearNetwork)
  configureNetwork({ proxy: 'socks5://127.0.0.1:9050' })

  t.ok(agentFor('https://mint.example'), 'https requests get an agent')
  t.ok(agentFor('wss://relay.example'), 'so do relays')
  t.is(agentFor('https://mint.example'), agentFor('wss://relay.example'), 'the same one')
  t.unlike(agentFor('http://mint.example'), agentFor('https://mint.example'))
  t.is(networkPolicy().proxyName, 'socks5://127.0.0.1:9050')

  t.exception.all(() => assertUnproxied('a send over the hyperdht'), /holepunches over UDP/)
  t.is(updaterBlocked(), '--proxy', 'and the updater stays down')
  t.alike(dhtOptions(), {}, 'a proxy binds nothing')
})

test('--interface binds the hyperdht and refuses everything it cannot bind', (t) => {
  t.teardown(clearNetwork)
  configureNetwork({ iface: '127.0.0.1' })

  t.alike(dhtOptions(), { host: '127.0.0.1' })
  t.exception.all(() => assertUnbound('https requests'), /no way to bind an outgoing/)
  t.is(updaterBlocked(), '--interface 127.0.0.1')
  t.execution(() => assertUnproxied('a send over the hyperdht'), 'the hyperdht is what it is for')
})

test('an interface this host does not have is a mistake in the command line', (t) => {
  t.teardown(clearNetwork)
  t.exception.all(() => configureNetwork({ iface: 'nope0' }), /no interface or local address/)
})

test('nothing is proxied or bound unless it was asked for', (t) => {
  t.teardown(clearNetwork)
  t.is(agentFor('https://mint.example'), null)
  t.is(updaterBlocked(), null)
  t.alike(dhtOptions(), {})
  t.execution(() => assertUnbound('https requests'))
  t.execution(() => assertUnproxied('a send over the hyperdht'))
})

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
