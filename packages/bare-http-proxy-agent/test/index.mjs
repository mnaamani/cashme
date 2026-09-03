// A forwarding http proxy of the test's own: read the request head, check it came in
// absolute-form, then make the request onwards and pipe the answer back.
import 'bare-fetch/global'
import test from 'brittle'
import tcp from 'bare-tcp'
import http from 'bare-http1'
import { HttpProxyAgent, parse, proxyErrorIn } from '../index.mjs'

test('an http proxy url is read, and an https one says the first hop is TLS', (t) => {
  t.alike(parse('http://127.0.0.1:3128'), {
    protocol: 'http:',
    host: '127.0.0.1',
    port: 3128,
    username: '',
    password: '',
    secure: false
  })
  t.is(parse('https://proxy.example').secure, true, 'the proxy itself is reached over TLS')
  t.is(parse('http://proxy.example').port, 8080)
  t.is(parse('https://proxy.example').port, 443)
  t.exception.all(() => parse('socks5://127.0.0.1:9050'), /unsupported proxy scheme/)
})

test('an agent says what it speaks and what it was configured with', (t) => {
  t.alike(HttpProxyAgent.protocols, ['http', 'https'])

  const agent = new HttpProxyAgent(new URL('http://me:s3cret@proxy.lan:3128'))
  t.teardown(() => agent.destroy())
  t.is(agent.proxyUrl, 'http://proxy.lan:3128', 'the address, never the password')
  t.alike(agent.proxyHeaders, {}, 'and no headers of its own unless asked for')
})

test('a request is forwarded to the proxy in absolute-form, and arrives', async (t) => {
  const origin = await server(t)
  const proxy = await forwardProxy(t)

  const response = await fetch(`http://127.0.0.1:${origin.port}/hello`, {
    agent: agentFor(t, proxy.port)
  })

  t.is(await response.text(), 'hello from the origin')
  t.is(
    proxy.lines[0],
    `GET http://127.0.0.1:${origin.port}/hello HTTP/1.1`,
    'the whole url in the request line, which is what a proxy forwards on'
  )
  t.is(proxy.headers[0]['proxy-connection'], 'Keep-Alive', 'keep-alive is on by default')
  t.is(origin.seen[0].url, '/hello', 'and the origin was asked for the path, as ever')
})

test('credentials go in a Proxy-Authorization header when the url carries them', async (t) => {
  const origin = await server(t)
  const proxy = await forwardProxy(t)

  await fetch(`http://127.0.0.1:${origin.port}/hello`, {
    agent: agentFor(t, proxy.port, 'me:s3cret@')
  })

  t.alike(proxy.credentials, ['me:s3cret'])
})

test('headers given to the agent are sent with the request, per request', async (t) => {
  const origin = await server(t)
  const proxy = await forwardProxy(t)
  let calls = 0
  const agent = new HttpProxyAgent(`http://127.0.0.1:${proxy.port}`, {
    headers: () => ({ 'Proxy-Probe': `probe/${++calls}` })
  })
  t.teardown(() => agent.destroy())

  await fetch(`http://127.0.0.1:${origin.port}/one`, { agent })
  await fetch(`http://127.0.0.1:${origin.port}/two`, { agent })

  t.is(proxy.headers[0]['proxy-probe'], 'probe/1')
  t.is(proxy.headers[1]['proxy-probe'], 'probe/2', 'the function was called again')
})

test('a target on a port of its own keeps it in the forwarded url', async (t) => {
  const origin = await server(t)
  const proxy = await forwardProxy(t)

  await fetch(`http://127.0.0.1:${origin.port}/hello`, { agent: agentFor(t, proxy.port) })

  t.ok(proxy.lines[0].includes(`127.0.0.1:${origin.port}/hello`), proxy.lines[0])
})

test('what the proxy answers is what the caller gets, 407 included', async (t) => {
  // A forwarding proxy reports its own failures as http responses rather than as a
  // handshake that did not happen, so there is nothing here for ProxyError to be.
  const proxy = await listener(t, (socket) => {
    socket.on('data', () => {
      socket.write('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n')
    })
  })

  const response = await fetch('http://mint.example/', { agent: agentFor(t, proxy) })
  t.is(response.status, 407)
})

test('a proxy that is not listening fails the request', async (t) => {
  const port = await unusedPort(t)
  const err = await fetch('http://mint.example/', { agent: agentFor(t, port) }).then(
    () => null,
    (err) => err
  )
  t.ok(err, 'the request failed rather than hanging')
  t.is(proxyErrorIn(err), null, 'and not as a handshake error — there is no handshake')
})

function agentFor(t, port, credentials = '') {
  const agent = new HttpProxyAgent(`http://${credentials}127.0.0.1:${port}`)
  t.teardown(() => agent.destroy())
  return agent
}

// Reads the request head, records what the proxy was told, then makes the request onwards
// with the request line back in origin-form and pipes the two together.
function forwardProxy(t) {
  const lines = []
  const seenHeaders = []
  const credentials = []

  const port = listener(t, (socket) => {
    let head = ''
    let upstream = null

    socket.on('data', (data) => {
      if (upstream) return upstream.write(data)

      head += data.toString()
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) return

      const rest = Buffer.from(head.slice(end + 4))
      const [line, ...rawHeaders] = head.slice(0, end).split('\r\n')
      lines.push(line)

      const headers = {}
      for (const raw of rawHeaders) {
        const [name, ...value] = raw.split(': ')
        headers[name.toLowerCase()] = value.join(': ')
      }
      seenHeaders.push(headers)
      if (headers['proxy-authorization']) {
        const [, encoded] = headers['proxy-authorization'].split(' ')
        credentials.push(Buffer.from(encoded, 'base64').toString())
      }

      const [method, target, version] = line.split(' ')
      t.ok(target.startsWith('http://'), `forwarded in absolute-form: ${target}`)
      const url = new URL(target)

      upstream = tcp.createConnection({
        port: Number(url.port) || 80,
        host: url.hostname
      })
      upstream.write(
        [`${method} ${url.pathname}${url.search} ${version}`, ...rawHeaders, '', ''].join('\r\n')
      )
      upstream.on('data', (chunk) => socket.write(chunk))
      upstream.on('error', () => socket.destroy())
      upstream.on('close', () => socket.destroy())
      socket.on('close', () => upstream.destroy())
      if (rest.byteLength > 0) upstream.write(rest)

      // One request per connection here: the agent keeps the connection alive, and the head
      // above is only parsed once, so anything after goes straight upstream.
      head = ''
    })
  })

  return port.then((port) => ({ port, lines, headers: seenHeaders, credentials }))
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

// A port nothing is listening on: taken and given back, so it is one the OS handed out.
function unusedPort(t) {
  return new Promise((resolve) => {
    const server = tcp.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

// A server does not finish closing while a connection is open, and the agent keeps one open
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
