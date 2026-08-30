// coco, cashu-ts and @noble expect browser globals that Bare does not provide.
// This must be a separate module: within a single module all `import`s are evaluated
// before any statement in the body, so assigning to globalThis next to the imports is too
// late. Importing this module *above* the @cashu import is evaluated first — @noble reads
// TextEncoder while its own module body runs, so the order is not optional.
import 'bare-crypto/global'
// Bare's built-in URL does not case fold the host; the bare-url package does. coco's
// normalizeMintUrl() rebuilds the mint URL from `url.host` and relies on that folding, and
// the resulting string is the key mints are stored under, so without this the same mint
// reachable as `Mint.example.com` and `mint.example.com` gets two entries.
import 'bare-url/global'
import 'bare-encoding/global'
import 'bare-fetch/global'
import { installProxyFetch } from './net.mjs'

// Global fetch is what coco uses to reach a mint, so it is the one place where --proxy can
// be applied to every request the wallet makes. The wrapper decides per call and does
// nothing until a proxy is configured (lib/net.mjs), so installing it here — before any
// module can take a reference to fetch — costs an unproxied run nothing.
installProxyFetch()

// nostr-tools' relay-url normalizer calls URLSearchParams#sort, which bare-url does not
// implement. Without it every relay url throws `Invalid URL` before a socket is opened.
if (!URLSearchParams.prototype.sort) {
  URLSearchParams.prototype.sort = function () {
    const entries = [...this].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    for (const [name] of entries) this.delete(name)
    for (const [name, value] of entries) this.append(name, value)
  }
}
