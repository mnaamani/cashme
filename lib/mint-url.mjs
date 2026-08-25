import './polyfills.mjs'
import { normalizeMintUrl as cocoNormalizeMintUrl } from '@cashu/coco-core'

// The canonical form of a mint url, which is what every mint is keyed by.
//
// coco has its own `normalizeMintUrl`, and unlike the cashu-ts one it replaced it only
// normalizes — trailing slashes, default ports, redundant path segments — and validates
// nothing. It will hand back `ftp://…` unchanged, and quietly drops credentials, query and
// fragment rather than refusing them. Mint urls reach us from tokens, which are
// attacker-controlled, so the checks cashu-ts used to make are made here instead.
//
// Case folding is ours too: coco leans on `new URL().host` for it, and Bare's URL, unlike
// Node's, leaves the host as typed — without this the same mint reachable as
// `Mint.example.com` and `mint.example.com` gets two entries. The path is left alone:
// paths are case sensitive.
export function normalizeMintUrl(mintUrl) {
  const url = new URL(mintUrl) // throws on anything that is not a url at all
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`invalid mint url scheme: ${url.protocol}`)
  }
  if (url.username || url.password) throw new Error('mint url must not contain credentials')
  if (url.search) throw new Error('mint url must not contain query parameters')
  if (url.hash) throw new Error('mint url must not contain a fragment')

  const normalized = new URL(cocoNormalizeMintUrl(mintUrl))
  const origin = `${normalized.protocol.toLowerCase()}//${normalized.host.toLowerCase()}`
  return (origin + normalized.pathname).replace(/\/+$/, '')
}
