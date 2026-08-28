// Must come first: @noble needs TextEncoder at module scope.
import '../lib/polyfills.mjs'
import test from 'brittle'
import {
  isLightningAddress,
  addressToUrl,
  decodeLnurl,
  encodeLnurl,
  payEndpoint,
  bolt11Msats
} from '../lib/lnurl.mjs'

test('a lightning address resolves to its lud16 well-known path', (t) => {
  t.is(addressToUrl('alice@example.com'), 'https://example.com/.well-known/lnurlp/alice')
  t.is(addressToUrl('  Alice@Example.com  '), 'https://Example.com/.well-known/lnurlp/Alice')
  // NIP-05's `_@domain` shorthand is a name like any other here.
  t.is(addressToUrl('_@example.com'), 'https://example.com/.well-known/lnurlp/_')
  t.ok(isLightningAddress('alice@example.com'))
  t.absent(isLightningAddress('npub1xxx'))
  t.exception.all(() => addressToUrl('not an address'), /lightning address/)
})

test('an lnurl round-trips through bech32', (t) => {
  const url = 'https://example.com/.well-known/lnurlp/alice'
  const lnurl = encodeLnurl(url)
  t.ok(lnurl.startsWith('lnurl1'))
  t.is(decodeLnurl(lnurl), url)
  t.is(decodeLnurl(lnurl.toUpperCase()), url, 'bech32 is case-insensitive')
  // payEndpoint takes either form a profile might carry.
  t.is(payEndpoint(lnurl), url)
  t.is(payEndpoint('alice@example.com'), url)
})

test('an lnurl that is not https, or not an lnurl, is refused', (t) => {
  const insecure = encodeLnurl('http://example.com/pay')
  t.exception.all(() => decodeLnurl(insecure), /insecure/)
  t.exception.all(
    () => decodeLnurl('npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m'),
    /got a npub/
  )
})

// The amount check is what stands between us and an lnurl host returning an invoice for
// more than we asked for, so the parse behind it is worth pinning down.
test('a bolt11 amount is read out of its human-readable part', (t) => {
  t.is(bolt11Msats('lnbc210n1p...'), 21000, '210 nano-btc is 21 sat')
  t.is(bolt11Msats('lnbc1u1p...'), 100000, '1 micro-btc is 100 sat')
  t.is(bolt11Msats('lnbc1m1p...'), 100000000, '1 milli-btc is 100000 sat')
  t.is(bolt11Msats('lnbc1p1p...'), null, 'a tenth of a millisat is not payable')
  t.is(bolt11Msats('lnbc10p1p...'), 1, '10 pico-btc is one millisat')
  t.is(bolt11Msats('LNBC210N1P...'), 21000, 'invoices are sometimes uppercased for QR')
  t.is(bolt11Msats('lntb210n1p...'), 21000, 'testnet invoices parse the same way')
  t.is(bolt11Msats('lnbc1p...'), null, 'an invoice with no amount names none')
  t.is(bolt11Msats('not an invoice'), null)
})
