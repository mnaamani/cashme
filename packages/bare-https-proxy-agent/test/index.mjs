// HTTP CONNECT spoken to a proxy of the test's own: read one request head, answer it, pipe.
import 'bare-fetch/global'
import test from 'brittle'
import tcp from 'bare-tcp'
import http from 'bare-http1'
import {
  HttpsProxyHTTPAgent,
  HttpsProxyHTTPSAgent,
  createAgents,
  parse,
  proxyErrorIn
} from '../index.mjs'

test('an http proxy url is read, and an https one says the first hop is TLS', (t) => {
  t.alike(parse('http://127.0.0.1:3128'), {
    protocol: 'http:',
    host: '127.0.0.1',
    port: 3128,
    username: '',
    password: '',
    secure: false
  })
  t.is(parse('https://proxy.example:443').secure, true, 'the proxy itself is reached over TLS')
  t.is(parse('https://proxy.example:443').port, 443, 'a default port written down is kept')
  t.is(parse('http://proxy.example:80').port, 80)
  t.exception.all(
    () => parse('http://proxy.example'),
    /names no port/,
    'a port is written down, never guessed at — 80, 443, 1080 and 8080 all have a claim'
  )
  t.exception.all(() => parse('socks5://127.0.0.1:1080'), /unsupported proxy scheme/)
})

test('an agent says what it speaks and what it was configured with', (t) => {
  t.alike(HttpsProxyHTTPAgent.protocols, ['http', 'https'])
  t.alike(HttpsProxyHTTPSAgent.protocols, ['http', 'https'])

  const agent = new HttpsProxyHTTPAgent(new URL('http://me:s3cret@proxy.lan:3128'))
  t.teardown(() => agent.destroy())
  t.is(agent.proxyUrl, 'http://proxy.lan:3128', 'the address, never the password')
  t.alike(agent.proxyHeaders, {}, 'and no headers of its own unless asked for')
})

test('headers given to the agent are sent with the CONNECT, per tunnel', async (t) => {
  const origin = await server(t)
  const proxy = await connectProxy(t)
  let calls = 0
  const agents = createAgents(`http://127.0.0.1:${proxy.port}`, {
    headers: () => ({ 'User-Agent': `probe/${++calls}` })
  })
  t.teardown(() => {
    agents.http.destroy()
    agents.https.destroy()
  })

  await fetch(`http://127.0.0.1:${origin.port}/hello`, { agent: agents.http })

  t.alike(proxy.headers, [{ 'user-agent': 'probe/1' }], 'the function was called for the tunnel')
})

test('a request through a CONNECT proxy arrives, and arrives from the proxy', async (t) => {
  const origin = await server(t)
  const proxy = await connectProxy(t)

  const response = await fetch(`http://127.0.0.1:${origin.port}/hello`, {
    agent: agentsFor(t, proxy.port).http
  })

  t.is(await response.text(), 'hello from the origin')
  t.alike(proxy.asked, [`127.0.0.1:${origin.port}`], 'asked for by name and port, not resolved')
  t.is(origin.seen[0].from, '127.0.0.1', 'and the origin saw the proxy, not us')
})

test('credentials go in a Proxy-Authorization header when the url carries them', async (t) => {
  const origin = await server(t)
  const proxy = await connectProxy(t)

  await fetch(`http://127.0.0.1:${origin.port}/hello`, {
    agent: agentsFor(t, proxy.port, 'me:s3cret@').http
  })

  t.alike(proxy.credentials, ['me:s3cret'])
})

test('a proxy asking for credentials is reported as such', async (t) => {
  const proxy = await connectProxy(t, { status: '407 Proxy Authentication Required' })
  const err = await failure(t, proxy.port)
  t.is(err.code, 'PROXY_ERROR')
  t.ok(/wants authentication/.test(err.message), err.message)
})

test('a proxy that will not open the tunnel says what it answered', async (t) => {
  const proxy = await connectProxy(t, { status: '403 Forbidden' })
  const err = await failure(t, proxy.port)
  t.ok(/refused a tunnel to mint.example:80: HTTP 403/.test(err.message), err.message)
})

test('a port that is listening but answers no http is reported as one', async (t) => {
  const port = await listener(t, (socket) => socket.write('SSH-2.0-OpenSSH_9.8\r\n\r\n'))
  const err = await failure(t, port)
  t.ok(/answered a CONNECT with something that is not HTTP/.test(err.message), err.message)
})

// The CONNECT head is built by hand rather than by bare-http1, so nothing upstream has
// checked it for the characters that end a line early. A value carrying CR or LF could add a
// second CONNECT, to somewhere else entirely.
test('a header value that would end the line early is refused', async (t) => {
  const proxy = await connectProxy(t)
  const agents = createAgents(`http://127.0.0.1:${proxy.port}`, {
    headers: { 'X-Probe': 'one\r\nCONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443' }
  })
  t.teardown(() => {
    agents.http.destroy()
    agents.https.destroy()
  })

  const err = await fetch('http://mint.example/', { agent: agents.http }).then(
    () => null,
    (err) => proxyErrorIn(err) ?? err
  )

  t.is(err?.code, 'PROXY_ERROR')
  t.ok(/cannot carry a newline/.test(err.message), err.message)
  t.alike(proxy.asked, [], 'and no CONNECT was sent at all')
})

// The tunnel would be built to the right place and then spoken through in the clear, since
// this agent negotiates no TLS. Port 443 means an https: target reached the wrong agent,
// which is what a redirect through bare-fetch does.
test('a plain http tunnel to port 443 is refused, not downgraded', async (t) => {
  const proxy = await connectProxy(t)

  const err = await fetch('https://secret.example/vault', {
    agent: agentsFor(t, proxy.port).http
  }).then(
    () => null,
    (err) => proxyErrorIn(err) ?? err
  )

  t.is(err?.code, 'PROXY_ERROR')
  t.ok(/port 443/.test(err.message), err.message)
  t.alike(proxy.asked, [], 'and no tunnel was asked for')
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
  const agents = createAgents(`http://${credentials}127.0.0.1:${port}`)
  t.teardown(() => {
    agents.http.destroy()
    agents.https.destroy()
  })
  return agents
}

function connectProxy(t, { status = '200 Connection Established' } = {}) {
  const asked = []
  const credentials = []
  const seenHeaders = []

  const port = listener(t, (socket) => {
    let head = ''
    let upstream = null

    socket.on('data', (data) => {
      if (upstream) return upstream.write(data)

      head += data.toString()
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) return

      const rest = Buffer.from(head.slice(end + 4))
      const lines = head.slice(0, end).split('\r\n')
      const [method, authority] = lines[0].split(' ')
      t.is(method, 'CONNECT')
      asked.push(authority)

      // Everything the client added beyond what the method needs.
      const extra = {}
      for (const line of lines.slice(1)) {
        const [name, ...rest] = line.split(': ')
        const key = name.toLowerCase()
        if (key !== 'host' && key !== 'proxy-authorization') extra[key] = rest.join(': ')
      }
      if (Object.keys(extra).length > 0) seenHeaders.push(extra)

      const authorization = lines.find((line) => /^Proxy-Authorization:/i.test(line))
      if (authorization) {
        credentials.push(Buffer.from(authorization.split(' ')[2], 'base64').toString())
      }

      socket.write(`HTTP/1.1 ${status}\r\n\r\n`)
      if (!status.startsWith('200')) return socket.end()

      upstream = tcp.createConnection({ port: Number(authority.split(':')[1]), host: '127.0.0.1' })
      upstream.on('data', (chunk) => socket.write(chunk))
      upstream.on('error', () => socket.destroy())
      upstream.on('close', () => socket.destroy())
      socket.on('close', () => upstream.destroy())
      if (rest.byteLength > 0) upstream.write(rest)
    })
  })

  return port.then((port) => ({ port, asked, credentials, headers: seenHeaders }))
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
