import './polyfills.mjs'
import { normalizeMintUrl as cocoNormalizeMintUrl } from '@cashu/coco-core'

// The canonical form of a mint url, which is what every mint is keyed by.
//
// coco's `normalizeMintUrl` only normalizes — case, trailing slashes, default ports,
// redundant path segments — and validates nothing: it hands back `ftp://…` unchanged and
// quietly drops credentials, query and fragment rather than refusing them. Mint urls come
// from tokens, which are attacker-controlled, so the checks cashu-ts used to make are made
// here instead.
//
// The normalizing itself stays coco's: it re-normalizes every url handed to it and keys its
// maps and repos by the result, so tidying here would only put us out of step. Its case
// folding relies on `new URL().host`, correct only with bare-url — see polyfills.mjs.
export function normalizeMintUrl(mintUrl) {
  let url
  try {
    url = new URL(mintUrl)
  } catch {
    // The runtime's own message names the constructor and the string twice; a mint url
    // arrives from a flag or a token, and either way this is what is wrong with it.
    throw new Error(`not a mint url: ${mintUrl}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`invalid mint url scheme: ${url.protocol}`)
  }
  if (url.username || url.password) throw new Error('mint url must not contain credentials')
  if (url.search) throw new Error('mint url must not contain query parameters')
  if (url.hash) throw new Error('mint url must not contain a fragment')

  return cocoNormalizeMintUrl(mintUrl)
}
