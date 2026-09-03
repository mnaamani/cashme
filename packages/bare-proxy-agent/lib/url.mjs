// Reading a proxy url, shared by every protocol that has one. `schemes` is the list this
// protocol answers to, spelled with the colon: ['socks5:', 'socks5h:'].
//
// A host and a port, both written down. A path or a query means whoever configured this has
// pasted something that is not a proxy address, and guessing which half they meant is how
// traffic ends up somewhere nobody chose.
//
// A missing port is refused for the same reason rather than defaulted, which is the one
// place this departs from every proxy agent in the Node ecosystem. There is no default worth
// having: http-proxy-agent reads a port-less proxy url as port 80, curl reads it as 1080, and
// 8080 is where proxies actually tend to listen — three answers, so any of them is a guess.
// A guess that lands on the wrong service still hands it the Proxy-Authorization header, or
// the SOCKS5 handshake with the username and password in it, before anything notices. The
// port is one word and only the person configuring it knows which.
export function parseProxyUrl(value, schemes) {
  const raw = String(value).trim()
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`not a proxy url: ${value}`)
  }
  if (!schemes.includes(url.protocol)) {
    const named = schemes.map((scheme) => `${scheme}//`).join(', ')
    throw new Error(`unsupported proxy scheme ${url.protocol} — use ${named}`)
  }
  if (!url.hostname) throw new Error(`the proxy url names no host: ${value}`)
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error(`a proxy url is a host and a port only: ${value}`)
  }
  const port = writtenPort(raw, url)
  if (port === null) {
    throw new Error(`the proxy url names no port: ${value} — write the one you mean`)
  }

  return {
    protocol: url.protocol,
    // WHATWG keeps an IPv6 host in its brackets; every socket api wants it without them.
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    // Whether the first hop is itself TLS, which is the base's business rather than any one
    // handshake's. Set by whoever parsed the url — an https:// proxy is one.
    secure: false
  }
}

// The port the url was written with, or null when it was left out.
//
// Not simply `url.port`: WHATWG erases a port that is its scheme's own default, so
// `https://proxy.lan:443` parses with an empty port and is indistinguishable there from
// `https://proxy.lan`. Only the string says which of the two was written down, so the
// authority is read again from it.
function writtenPort(raw, url) {
  if (url.port) return Number(url.port)
  const at = raw.indexOf('://')
  if (at === -1) return null
  const authority = raw.slice(at + 3).split(/[/?#]/, 1)[0]
  // Anything before an @ is the credentials, and an IPv6 host keeps its brackets — which is
  // what stops the colons inside one from reading as a port.
  const host = authority.slice(authority.lastIndexOf('@') + 1)
  const written = /:(\d+)$/.exec(host)
  return written ? Number(written[1]) : null
}

// How a proxy is named in an error: the address it was configured with, never its password.
export function proxyName(proxy) {
  return `${proxy.protocol}//${authority(proxy)}`
}

// `host:port`, with an IPv6 host in the brackets a url and an http header both want.
export function authority({ host, port }) {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`
}

// Whether a proxy url carries credentials to authenticate with.
export function hasCredentials(proxy) {
  return proxy.username !== '' || proxy.password !== ''
}
