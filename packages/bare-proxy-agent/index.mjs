// Tunnelling http and websocket traffic through a proxy under Bare.
//
// This package is the half every proxy protocol shares: a socket that is opened by handshake
// rather than by connecting, the http agents built on it, and the reading and error types a
// handshake is written against. The protocols themselves live in bare-socks-proxy-agent
// (SOCKS5), bare-https-proxy-agent (HTTP CONNECT) and bare-http-proxy-agent (an http proxy
// asked to forward, which is the one that has no handshake to speak) — start with one of
// those unless you are teaching this one a protocol of your own.
export { ProxyError, proxyErrorIn } from './lib/errors.mjs'
export { parseProxyUrl, proxyName, authority, hasCredentials } from './lib/url.mjs'
export { Reader } from './lib/reader.mjs'
export { ProxySocket } from './lib/socket.mjs'
export { ProxyHTTPAgent, ProxyHTTPSAgent, createAgents } from './lib/agents.mjs'
