// Everything that goes wrong on the way through a proxy, marked as such.
//
// A proxy failure reaches the caller through whatever made the request: bare-fetch answers
// one with `NETWORK_ERROR: Network error` and keeps the reason as its cause, and a library
// above that may wrap it again. The code is what lets the reason be found again and shown
// to whoever has to act on it — usually the person whose proxy is not running.
export class ProxyError extends Error {
  constructor(message) {
    super(message)
    this.code = 'PROXY_ERROR'
  }

  get name() {
    return 'ProxyError'
  }
}

// The proxy error behind a failure, however deeply it has been wrapped, or null.
export function proxyErrorIn(err) {
  for (let cause = err; cause instanceof Error; cause = cause.cause) {
    if (cause.code === 'PROXY_ERROR') return cause
  }
  return null
}
