// Reading a proxy url, shared by every protocol that has one.
//
// Host and port only: a path or a query means whoever configured this has pasted something
// that is not a proxy address, and guessing which half they meant is how traffic ends up
// somewhere nobody chose.
export function parseProxyUrl(value, ports) {
  let url
  try {
    url = new URL(String(value).trim())
  } catch {
    throw new Error(`not a proxy url: ${value}`)
  }
  if (!(url.protocol in ports)) {
    const schemes = Object.keys(ports)
      .map((scheme) => `${scheme}//`)
      .join(', ')
    throw new Error(`unsupported proxy scheme ${url.protocol} — use ${schemes}`)
  }
  if (!url.hostname) throw new Error(`the proxy url names no host: ${value}`)
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error(`a proxy url is a host and a port only: ${value}`)
  }

  return {
    protocol: url.protocol,
    // WHATWG keeps an IPv6 host in its brackets; every socket api wants it without them.
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port ? Number(url.port) : ports[url.protocol],
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    // Whether the first hop is itself TLS, which is the base's business rather than any one
    // handshake's. Set by whoever parsed the url — an https:// proxy is one.
    secure: false
  }
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
