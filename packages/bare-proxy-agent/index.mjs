// Tunnelling http and websocket traffic through a proxy under Bare.
//
// This package is the half every proxy protocol shares: a socket that is opened by handshake
// rather than by connecting, the http agents built on it, and the reading and error types a
// handshake is written against. The handshakes themselves live in bare-socks-proxy-agent
// (SOCKS5) and bare-https-proxy-agent (HTTP CONNECT) — start with one of those unless you
// are teaching this one a protocol of your own.
export { ProxyError, proxyErrorIn } from './lib/errors.mjs'
export { parseProxyUrl, proxyName, authority, hasCredentials } from './lib/url.mjs'
export { Reader } from './lib/reader.mjs'
export { ProxySocket } from './lib/socket.mjs'
export { ProxyHTTPAgent, ProxyHTTPSAgent, createAgents } from './lib/agents.mjs'
