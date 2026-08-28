// LNURL-pay, the half of a zap that is not nostr: turn a lightning address into an
// endpoint, ask it for an invoice, and check what comes back.
//
// Nothing here is signed. An LNURL server's answer is the host's word over TLS, exactly
// like the NIP-05 lookup in lib/nostr.mjs — which is why the invoice it returns is checked
// against what we asked for rather than paid on trust.
import './polyfills.mjs'
import { bech32 } from '@scure/base'

// lnurls are bech32 with no length limit; @scure/base caps at 90 characters unless told
// otherwise. Same reason as decodeNpub.
const BECH32_LIMIT = 5000

// A lightning address looks like an email and resolves like NIP-05, to a different
// well-known path. Deliberately the same shape as nostr.mjs's NIP05, since a user's
// lud16 is usually the very address they gave us.
const ADDRESS = /^([a-z0-9\-_.]+)@([a-z0-9\-.]+\.[a-z]{2,})$/i

export function isLightningAddress(value) {
  return ADDRESS.test(String(value).trim())
}

// LUD-16: `name@domain` is served from /.well-known/lnurlp/name.
export function addressToUrl(address) {
  const match = ADDRESS.exec(String(address).trim())
  if (!match) throw new Error(`not a lightning address: "${address}" — expected name@domain`)
  const [, name, domain] = match
  return `https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`
}

// LUD-06: an `lnurl1...` string is a bech32-wrapped https url.
export function decodeLnurl(lnurl) {
  const { prefix, words } = bech32.decode(String(lnurl).trim().toLowerCase(), BECH32_LIMIT)
  if (prefix !== 'lnurl') throw new Error(`expected an lnurl, got a ${prefix}1... string`)
  const url = Buffer.from(bech32.fromWords(words)).toString('utf8')
  if (!url.startsWith('https://')) throw new Error(`that lnurl points somewhere insecure: ${url}`)
  return url
}

// The bech32 form of an endpoint. NIP-57 asks for it as the `lnurl` parameter on the
// callback, and some servers require it even when they were reached by address.
export function encodeLnurl(url) {
  const words = bech32.toWords(Buffer.from(url, 'utf8'))
  return bech32.encode('lnurl', words, BECH32_LIMIT)
}

// Whatever the profile gave us — a lud16 address or a lud06 lnurl — as an https endpoint.
export function payEndpoint(value) {
  const text = String(value).trim()
  if (text.toLowerCase().startsWith('lnurl1')) return decodeLnurl(text)
  return addressToUrl(text)
}

// LUD-06 step one: what this endpoint will accept. `allowsNostr` and `nostrPubkey` are the
// NIP-57 part — without them the host can be paid, but it will not issue a zap receipt.
export async function fetchPayParams(url) {
  const body = await getJson(url, 'lnurl endpoint')

  if (body.status === 'ERROR') throw new Error(body.reason || 'the lnurl endpoint refused')
  if (body.tag !== 'payRequest') {
    throw new Error(`${url} is not an lnurl-pay endpoint (tag: ${body.tag ?? 'none'})`)
  }
  if (typeof body.callback !== 'string' || !body.callback.startsWith('https://')) {
    throw new Error(`${url} gave a callback that is not an https url`)
  }

  const min = Number(body.minSendable)
  const max = Number(body.maxSendable)
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) {
    throw new Error(`${url} gave no usable send limits`)
  }

  return {
    url,
    callback: body.callback,
    minSendable: min,
    maxSendable: max,
    commentAllowed: Number(body.commentAllowed) || 0,
    // Both are required before we may call it a zap: the flag says it takes a zap request,
    // the key is who will sign the receipt.
    allowsNostr: body.allowsNostr === true && typeof body.nostrPubkey === 'string',
    nostrPubkey: typeof body.nostrPubkey === 'string' ? body.nostrPubkey : null
  }
}

// LUD-06 step two: the invoice. `zapRequest` is the signed kind 9734 when this is a zap;
// `comment` is the LUD-12 fallback for a host that cannot take one.
export async function requestInvoice(params, { msats, zapRequest, comment } = {}) {
  const url = new URL(params.callback)
  url.searchParams.set('amount', String(msats))
  url.searchParams.set('lnurl', encodeLnurl(params.url))
  if (zapRequest) url.searchParams.set('nostr', JSON.stringify(zapRequest))
  else if (comment && params.commentAllowed >= comment.length) {
    url.searchParams.set('comment', comment)
  }

  const body = await getJson(url.href, 'lnurl callback')
  if (body.status === 'ERROR') throw new Error(body.reason || 'the lnurl callback refused')
  if (typeof body.pr !== 'string' || !body.pr) {
    throw new Error('the lnurl callback returned no invoice')
  }

  // The host chooses the invoice, so what it chose is checked. A mismatch here is the one
  // way this flow could quietly pay an amount nobody asked for.
  const invoiced = bolt11Msats(body.pr)
  if (invoiced === null) throw new Error('the lnurl callback returned an invoice with no amount')
  if (invoiced !== msats) {
    throw new Error(
      `we asked for ${msats} msat and the invoice is for ${invoiced} msat — not paying it`
    )
  }

  return body.pr
}

// The amount out of a bolt11's human-readable part, in millisats, or null when the invoice
// names none. The hrp is `ln` + a network prefix + an optional amount and multiplier, and
// that much can be read without decoding the invoice body.
const MULTIPLIER_MSATS = { m: 100000000, u: 100000, n: 100, p: 0.1 }

export function bolt11Msats(invoice) {
  const match = /^ln(?:bc|tb|bcrt|tbs)(\d+)([munp])?/i.exec(String(invoice).trim())
  if (!match) return null
  const digits = Number(match[1])
  const multiplier = match[2]?.toLowerCase()
  // No multiplier means whole bitcoin.
  const msats = multiplier ? digits * MULTIPLIER_MSATS[multiplier] : digits * 100000000000
  // A pico-denominated invoice may name a tenth of a millisat, which no one can pay.
  return Number.isInteger(msats) ? msats : null
}

async function getJson(url, what) {
  let response
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } })
  } catch (err) {
    throw new Error(`could not reach the ${what}: ${err.message}`)
  }
  if (!response.ok) throw new Error(`the ${what} answered HTTP ${response.status}`)
  try {
    return await response.json()
  } catch {
    throw new Error(`the ${what} answered with something that is not json`)
  }
}
