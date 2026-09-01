// SOCKS5 spoken to a proxy of the test's own: greet, maybe authenticate, connect, pipe.
// Nothing here reaches the network — the point is that a request made through these agents
// arrives as a request, and arrives from the proxy.
import 'bare-fetch/global'
import test from 'brittle'
import tcp from 'bare-tcp'
import http from 'bare-http1'
import {
  SocksProxyHTTPAgent,
  SocksProxyHTTPSAgent,
  createAgents,
  parse,
  proxyErrorIn
} from '../index.mjs'

test('the two socks schemes are the same proxy, spelled two ways', (t) => {
  t.alike(parse('socks5://127.0.0.1:9050'), {
    protocol: 'socks5:',
    host: '127.0.0.1',
    port: 9050,
    username: '',
    password: '',
    secure: false
  })
  t.is(parse('socks5h://127.0.0.1:9050').protocol, 'socks5h:', 'kept, so errors quote it back')
  t.is(parse('socks5://127.0.0.1').port, 1080, 'the usual socks port when none is given')
  t.exception.all(() => parse('http://127.0.0.1:3128'), /unsupported proxy scheme/)
})

test('an agent says what it speaks and what it was configured with', (t) => {
  // The surface socks-proxy-agent has, so code written against that finds what it expects.
  t.alike(SocksProxyHTTPAgent.protocols, ['socks5', 'socks5h'])
  t.alike(SocksProxyHTTPSAgent.protocols, ['socks5', 'socks5h'])

  const agent = new SocksProxyHTTPAgent('socks5://me:s3cret@127.0.0.1:9050')
  t.teardown(() => agent.destroy())
  t.is(agent.proxyUrl, 'socks5://127.0.0.1:9050', 'the address, never the password')
  t.is(agent.proxy.host, '127.0.0.1')
  t.is(agent.proxy.username, 'me')

  // A URL rather than a string, which is the other half of what Node's constructors take.
  const fromUrl = new SocksProxyHTTPAgent(new URL('socks5h://127.0.0.1:1080'))
  t.teardown(() => fromUrl.destroy())
  t.is(fromUrl.proxyUrl, 'socks5h://127.0.0.1:1080')

  // And a proxy already parsed, so one parse can serve both agents.
  const parsed = parse('socks5://127.0.0.1:9050')
  t.is(new SocksProxyHTTPSAgent(parsed).proxy, parsed)
})

test('a request through a socks5 proxy arrives, and arrives from the proxy', async (t) => {
  const origin = await server(t)
  const proxy = await socks5(t)

  const response = await fetch(`http://127.0.0.1:${origin.port}/hello`, {
    agent: agentsFor(t, proxy.port).http
  })

  t.is(await response.text(), 'hello from the origin')
  t.alike(proxy.asked, [{ host: '127.0.0.1', port: origin.port }], 'the proxy did the connecting')
  t.is(origin.seen[0].from, '127.0.0.1', 'and the origin saw the proxy, not us')
})

test('a hostname goes to the proxy unresolved, so no dns for it leaves here', async (t) => {
  const origin = await server(t)
  const proxy = await socks5(t)

  // `localhost` is a name, and the proxy reports back what it was handed rather than what
  // it resolved — which is the whole point of leaving the lookup to the far end.
  const response = await fetch(`http://localhost:${origin.port}/hello`, {
    agent: agentsFor(t, proxy.port).http
  })

  t.is(await response.text(), 'hello from the origin')
  t.alike(proxy.asked, [{ host: 'localhost', port: origin.port }])
})

test('a proxy that wants credentials gets them', async (t) => {
  const origin = await server(t)
  const proxy = await socks5(t, { credentials: true })

  const response = await fetch(`http://127.0.0.1:${origin.port}/hello`, {
    agent: agentsFor(t, proxy.port, 'me:s3cret@').http
  })

  t.is(await response.text(), 'hello from the origin')
  t.alike(proxy.credentials, [{ username: 'me', password: 's3cret' }])
})

test('a proxy that wants credentials we do not have says which is missing', async (t) => {
  const proxy = await socks5(t, { credentials: true, refuseAuth: true })
  const err = await failure(t, proxy.port)
  t.is(err.code, 'PROXY_ERROR')
  t.ok(
    /wants authentication — put a username and password in the proxy url/.test(err.message),
    err.message
  )
})

test('a proxy that refuses says so in the words of whoever asked', async (t) => {
  const proxy = await socks5(t, { refuse: 5 })
  const err = await failure(t, proxy.port, 'http://mint.example:80/')
  t.ok(/could not reach mint.example:80: the connection was refused/.test(err.message), err.message)
})

test('a port that is listening but does not speak socks5 is reported as one', async (t) => {
  const port = await listener(t, (socket) => socket.write('SSH-2.0-OpenSSH_9.8\r\n'))
  const err = await failure(t, port)
  t.ok(/does not speak SOCKS5/.test(err.message), err.message)
})

// The reason a request failed. bare-fetch answers every failure with `NETWORK_ERROR` and
// keeps the real one as its cause, which is what proxyErrorIn is for.
async function failure(t, port, url = 'http://mint.example/') {
  const err = await fetch(url, { agent: agentsFor(t, port).http }).then(
    () => null,
    (err) => err
  )
  return proxyErrorIn(err) ?? err
}

function agentsFor(t, port, credentials = '') {
  const agents = createAgents(`socks5://${credentials}127.0.0.1:${port}`)
  t.teardown(() => {
    agents.http.destroy()
    agents.https.destroy()
  })
  return agents
}

// Enough of RFC 1928 to serve the client under test: greet, maybe authenticate, then either
// refuse or connect to 127.0.0.1 on the port asked for and pipe.
function socks5(t, { credentials = false, refuseAuth = false, refuse = 0 } = {}) {
  const asked = []
  const seenCredentials = []

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
        const methods = Array.from(buffer.subarray(2, 2 + count))
        buffer = buffer.subarray(2 + count)
        // 0xff is "none of what you offered", which is what a proxy wanting a password
        // answers a client that offered only 0x00.
        if (refuseAuth && !methods.includes(2)) return void socket.write(Buffer.from([5, 0xff]))
        socket.write(Buffer.from([5, credentials ? 2 : 0]))
        stage = credentials ? 'auth' : 'request'
        return step()
      }

      if (stage === 'auth') {
        if (buffer.byteLength < 2) return
        const ulen = buffer[1]
        if (buffer.byteLength < 3 + ulen) return
        const plen = buffer[2 + ulen]
        if (buffer.byteLength < 3 + ulen + plen) return
        seenCredentials.push({
          username: buffer.subarray(2, 2 + ulen).toString(),
          password: buffer.subarray(3 + ulen, 3 + ulen + plen).toString()
        })
        buffer = buffer.subarray(3 + ulen + plen)
        socket.write(Buffer.from([1, 0]))
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

        if (refuse) {
          socket.write(Buffer.from([5, refuse, 0, 1, 0, 0, 0, 0, 0, 0]))
          socket.end()
          return
        }

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

  return port.then((port) => ({ port, asked, credentials: seenCredentials }))
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
