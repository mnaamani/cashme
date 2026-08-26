import './polyfills.mjs'
import { normalizeMintUrl as cocoNormalizeMintUrl } from '@cashu/coco-core'

// The canonical form of a mint url, which is what every mint is keyed by.
//
// coco has its own `normalizeMintUrl`, and unlike the cashu-ts one it replaced it only
// normalizes — case, trailing slashes, default ports, redundant path segments — and
// validates nothing. It will hand back `ftp://…` unchanged, and quietly drops
// credentials, query and fragment rather than refusing them. Mint urls reach us from
// tokens, which are attacker-controlled, so the checks cashu-ts used to make are made
// here instead.
//
// Normalization itself is entirely coco's: it re-normalizes every mint url handed to it
// anyway, and keys its own maps and repos by the result, so any extra tidying here would
// only put us out of step with it. Case folding is coco's too, via `new URL().host`, and
// correct as long as `URL` comes from bare-url >= 2.5.0 rather than Bare's built-in one —
// see polyfills.mjs.
export function normalizeMintUrl(mintUrl) {
  const url = new URL(mintUrl) // throws on anything that is not a url at all
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`invalid mint url scheme: ${url.protocol}`)
  }
  if (url.username || url.password) throw new Error('mint url must not contain credentials')
  if (url.search) throw new Error('mint url must not contain query parameters')
  if (url.hash) throw new Error('mint url must not contain a fragment')

  return cocoNormalizeMintUrl(mintUrl)
}
