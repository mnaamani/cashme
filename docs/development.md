# Development

Built on pear-runtime, [hello-pear-bare](https://github.com/holepunchto/hello-pear-bare/tree/variant/daemon) daemon variant.

## Install Dependencies

```sh
npm install
```

```sh
npm start
```

By default this repo starts with `--no-updates` in development to avoid local dev binaries being swapped while you iterate.

Enable updates for local flow testing:

```sh
npm start -- --updates
```

Set how long the daemon waits for an update:

```sh
npm start -- --updates --update-window 60000
```

Development runs are unbundled, so they exercise the daemon lifecycle without replacing the local Bare executable. Updates are applied by standalone builds.

Errors print their message only. For the stack behind one:

```sh
CASHME_DEBUG=1 cashme withdraw --invoice lnbc...
```

## Debug logging

Internal logging goes through [`bare-debug-log`](https://github.com/holepunchto/bare-debug-log)
and is off unless `BARE_DEBUG` names a section. It writes to stderr, which is where
everything a run says about itself goes — stdout carries only what a command produces, so
`deposit` and `give --print` can be piped straight into something else.

Sections are `cashme:app` (startup, storage), `cashme:ble` (bluetooth swarm, connections,
token transfer), `cashme:lan` (multicast beacons, the TCP link, and the same transfer) and
`cashme:dht` (hyperdht connect, teardown, and the same transfer):

```sh
BARE_DEBUG=cashme:* cashme get
BARE_DEBUG=cashme:ble cashme give -k <pubkey> -a 10
BARE_DEBUG=cashme:lan cashme give --lan -k <pubkey> -a 10
BARE_DEBUG=cashme:dht cashme give --dht -k <pubkey> -a 10
```

With `cashme:app` enabled (`BARE_DEBUG=cashme:*` covers it) error stacks print too, so
there is no need to set `CASHME_DEBUG` as well.

## Architecture

### Updates

Updates are managed by the `App` class in `app.js`. The foreground CLI starts itself in a detached updater mode with `bare-daemon`. The updater owns `Corestore`, `Hyperswarm` and `PearRuntime`, while `updater.lock` ensures only one updater runs per storage directory.

It uses the configured `upgrade` link in `package.json`, waits 30 seconds by default and writes output to `<storage>/updates.log`. Once a download starts, the daemon remains alive until the update is applied or an error occurs.

Per-run disable updates:

```sh
npm start -- --no-updates
```

## Packages

The proxy support lives in six packages of its own under `packages/`, because none of it is
about ecash and Bare had no proxy agent of any kind. They are workspaces of this repo for
now, and are meant to be extracted into their own repositories once they have settled.

The wallet imports the top two and nothing below them:

- `packages/bare-any-proxy-agent` - one entry point for every scheme: hand it a proxy url of
  any of them and get back the agents to use it with (Node's `proxy-agent`)
- `packages/bare-proxy-from-env` - which proxy the environment is asking for: `http_proxy`,
  `https_proxy`, `ALL_PROXY`, `no_proxy`, read the way curl reads them, with no sockets or
  agents involved (Node's `proxy-from-env`)

Under those:

- `packages/bare-proxy-agent` - the half every proxy protocol shares: a socket opened by
  handshake rather than by connecting, the bare-http1 agents built on it, and the reading
  and error types a handshake is written against
- `packages/bare-socks-proxy-agent` - SOCKS5 (RFC 1928, and RFC 1929 for credentials), with
  the target name resolved by the proxy
- `packages/bare-http-proxy-agent` - an http proxy asked to forward, with the whole url in
  the request line, for `http:` targets
- `packages/bare-https-proxy-agent` - HTTP CONNECT, over a plain or a TLS first hop

The last two are the same split Node makes between `http-proxy-agent` and
`https-proxy-agent`, and `bare-any-proxy-agent` picks between them the same way: an `http:`
target is forwarded, an `https:` one is tunnelled.

What is left in `lib/net.mjs` is the wallet's own policy rather than the convention: that
`--proxy` and `CASHME_PROXY` outrank the environment and are exempt from `no_proxy`, the
global `fetch` wrapper, the per-request timeout, and `--dht-interface`.

Nothing in the Node ecosystem could be used instead: `socks-proxy-agent` and friends are
built on `agent-base` and Node's `net`/`tls`/`http`, none of which Bare has, and bare-http1's
agent is a different contract from Node's. Each package has its own tests
(`npm run test:packages`, or `npm test` inside one).

## Scripts

- `npm start` - run the Bare Process in dev mode (`bare bin.mjs --no-updates`)
- `npm test` - run the unit suite (fast, no network)
- `npm run test:packages` - run the test suite of each package under `packages/`
- `npm run test:integration` - run the integration suite: the wallet against a real mint,
  and the nostr code against a relay the tests control. Needs the network.
  `CASHME_TEST_OFFLINE=1` skips the parts that spend, leaving the local ones;
  `CASHME_TEST_MINT=<url>` points them at another mint.
- `npm run test:all` - all three suites
- `npm run lint` - run prettier check and lunte
- `npm run format` - format repository with prettier
- `npm run make` - auto-detect host OS/arch and run matching build target
- `npm run make:darwin-arm64` - build standalone to `out/darwin-arm64`
- `npm run make:darwin-x64` - build standalone to `out/darwin-x64`
- `npm run make:linux-arm64` - build standalone to `out/linux-arm64`
- `npm run make:linux-x64` - build standalone to `out/linux-x64`
- `npm run make:win32-arm64` - build standalone to `out/win32-arm64`
- `npm run make:win32-x64` - build standalone to `out/win32-x64`

## Project Structure

- `bin.mjs` - entrypoint: argv, storage directory, dispatch
- `lib/cli/` - one module per command, plus the flag grammar (`commands.mjs`), the wallet's
  lifetime and Ctrl-C handling (`session.mjs`), the hyperdht key a run presents
  (`address.mjs`), which wire a run uses (`transport.mjs`) and the printing (`ui.mjs`)
- `lib/manager.mjs` - opens the coco wallet and drives the deposit/send/receive/restore flows
- `lib/coco-store.mjs` - coco `Repositories` adapter for Bare: persistence, rollback, locking
- `lib/token-wire.mjs` - the frames a token travels in, shared by all three transports
- `lib/ble.mjs` - bluetooth transport for handing a token to a neighbour
- `lib/lan.mjs` - local-network transport: multicast discovery, then a TCP link
- `lib/dht.mjs` - hyperdht transport for handing a token to a peer anywhere
- `lib/clipboard.mjs` - the platform's clipboard program, for `give --copy`
- `lib/notes.mjs` - the one stderr write path, and the flush a run exits through
- `lib/nostr.mjs` - the keys, signed events and relay pool `nutzap` and `zap` need
- `lib/websocket.mjs` - the browser-shaped WebSocket nostr-tools drives, over bare-ws
- `lib/lnurl.mjs` - lnurl-pay: lightning address to endpoint to invoice, for `zap`
- `lib/seed.mjs` - the NUT-13 seed deterministic secrets derive from
- `lib/mint-url.mjs` - canonical mint urls, and the validation coco's normalizer leaves out
- `lib/lock.mjs` - advisory lock, one instance per storage directory
- `lib/updater.mjs` - OTA updates: spawning the daemon, and being it
- `lib/net.mjs` - the network policy a run is under: `--proxy`, `--dht-interface`, and what
  each of them refuses to half-apply
- `lib/constants.mjs`, `lib/polyfills.mjs` - defaults, and the browser globals Bare lacks
- `app.js` - daemon launcher and updater resource
- `scripts/make.js` - platform/arch build target selector
- `test/index.js` - brittle-bare test entrypoint, requiring the suites below
- `test/coco-contract.test.mjs` - coco's own storage adapter contract suites, run against `lib/coco-store.mjs`
- `test/coco-store.test.mjs` - serialization, rollback and locking in `lib/coco-store.mjs`
- `test/melt-fee.test.mjs` - the input-fee floor `cashme withdraw` refuses below
- `test/mint-url.test.mjs` - mint url normalization and validation
- `test/nostr.test.mjs` - npub decoding and NIP-01 event ids and signatures
- `test/lnurl.test.mjs` - lnurl address/bech32 handling and the bolt11 amount check
- `test/net.test.mjs` - the network policy, and a request driven through a proxy of the
  test's own
- `test/integration/index.js` - integration entrypoint, requiring the suites below
- `test/integration/helpers.mjs` - throwaway wallets, running the real CLI, and a stub relay
- `test/integration/relay.test.mjs` - what the wallet does with a relay that lies
- `test/integration/lnurl.test.mjs` - what it does with an lnurl host that answers badly
- `test/integration/mint.test.mjs` - mint, send, claim and reclaim against a real mint
- `test/integration/nutzap.test.mjs` - a whole nutzap, checked where it lands
