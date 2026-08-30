// The lnurl half of a zap, driven against a host we control.
//
// Nothing an lnurl host says is signed, so the wallet checks what comes back instead of
// trusting it. These tests are that checking: a host is made to answer badly on purpose,
// which is the one thing a real host will not do on request. `fetch` is replaced for the
// duration rather than a server being started, because what is under test is the reading
// of the answer, not the transport.
import '../../lib/polyfills.mjs'
import test from 'brittle'
import { fetchPayParams, requestInvoice, encodeLnurl } from '../../lib/lnurl.mjs'
import { signEvent, ephemeralKeypair, ZAP_REQUEST_KIND } from '../../lib/nostr.mjs'

const ENDPOINT = 'https://lnurl.test/.well-known/lnurlp/alice'
const CALLBACK = 'https://lnurl.test/callback'

// A 2500 µBTC invoice: 250000000 msat, the vector NIP-57 hosts are checked against.
const INVOICE_250K_SAT =
  'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp'

// Stand in for the host for one test, and put the real fetch back afterwards. `reply` is
// reassigned between steps so one stub can serve the endpoint and then the callback, while
// `seen` keeps every url the wallet asked for across both.
function host(t, reply) {
  const real = globalThis.fetch
  const stub = { seen: [], reply }
  globalThis.fetch = (url) => {
    stub.seen.push(new URL(url))
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(stub.reply(new URL(url)))
    })
  }
  t.teardown(() => {
    globalThis.fetch = real
  })
  return stub
}

const payRequest = (extra = {}) => ({
  tag: 'payRequest',
  callback: CALLBACK,
  minSendable: 1000,
  maxSendable: 100000000,
  commentAllowed: 200,
  ...extra
})

test('an lnurl-pay endpoint is read for what a zap needs', async (t) => {
  host(t, () => payRequest({ allowsNostr: true, nostrPubkey: 'ab'.repeat(32) }))

  const params = await fetchPayParams(ENDPOINT)
  t.is(params.callback, CALLBACK)
  t.is(params.minSendable, 1000)
  t.is(params.maxSendable, 100000000)
  t.ok(params.allowsNostr, 'the host takes a zap request')
  t.is(params.nostrPubkey, 'ab'.repeat(32), 'and says who signs the receipt')
})

test('a host that cannot issue a receipt is not mistaken for one that can', async (t) => {
  // allowsNostr without a key is not enough: the key is who signs the kind 9735, and
  // without it the payment goes through with no receipt at the end of it.
  const stub = host(t, () => payRequest({ allowsNostr: true }))
  t.absent((await fetchPayParams(ENDPOINT)).allowsNostr)

  stub.reply = () => payRequest({ nostrPubkey: 'ab'.repeat(32) })
  t.absent((await fetchPayParams(ENDPOINT)).allowsNostr)
})

test('an endpoint that is not lnurl-pay is refused', async (t) => {
  const stub = host(t, () => ({ tag: 'withdrawRequest', callback: CALLBACK }))
  await t.exception(fetchPayParams(ENDPOINT), /not an lnurl-pay endpoint/)

  stub.reply = () => ({ status: 'ERROR', reason: 'no such user' })
  await t.exception(fetchPayParams(ENDPOINT), /no such user/)

  // An http callback would take the zap off TLS without the user noticing.
  stub.reply = () => payRequest({ callback: 'http://lnurl.test/callback' })
  await t.exception(fetchPayParams(ENDPOINT), /not an https url/)
})

test('the zap request reaches the callback with the amount asked for', async (t) => {
  const stub = host(t, () => payRequest({ allowsNostr: true, nostrPubkey: 'ab'.repeat(32) }))
  const params = await fetchPayParams(ENDPOINT)

  const { secretKey } = ephemeralKeypair()
  const zapRequest = signEvent(
    {
      kind: ZAP_REQUEST_KIND,
      content: 'thanks',
      tags: [
        ['p', 'cd'.repeat(32)],
        ['amount', '250000000'],
        ['lnurl', encodeLnurl(params.url)]
      ]
    },
    secretKey
  )

  stub.reply = () => ({ pr: INVOICE_250K_SAT })
  const invoice = await requestInvoice(params, { msats: 250000000, zapRequest })
  t.is(invoice, INVOICE_250K_SAT)

  const callback = stub.seen[stub.seen.length - 1]
  t.is(callback.searchParams.get('amount'), '250000000')
  t.is(JSON.parse(callback.searchParams.get('nostr')).id, zapRequest.id, 'the signed 9734 goes')
  t.ok(callback.searchParams.get('lnurl'), 'and the lnurl the spec asks for')
})

// The one way this flow could quietly pay an amount nobody asked for. The host picks the
// invoice, so the invoice it picked is checked against what was requested.
test('an invoice for the wrong amount is refused rather than paid', async (t) => {
  const stub = host(t, () => payRequest())
  const params = await fetchPayParams(ENDPOINT)

  stub.reply = () => ({ pr: INVOICE_250K_SAT })
  await t.exception(
    requestInvoice(params, { msats: 5000 }),
    /we asked for 5000 msat and the invoice is for 250000000 msat/
  )
})

test('an invoice naming no amount at all is refused', async (t) => {
  const stub = host(t, () => payRequest())
  const params = await fetchPayParams(ENDPOINT)

  // No amount in the human-readable part means the payer chooses — which is to say the
  // wallet would be deciding what to send from a field nobody checked.
  stub.reply = () => ({ pr: 'lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq' })
  await t.exception(requestInvoice(params, { msats: 5000 }), /no amount/)
})

test('a callback that refuses says why', async (t) => {
  const stub = host(t, () => payRequest())
  const params = await fetchPayParams(ENDPOINT)

  stub.reply = () => ({ status: 'ERROR', reason: 'amount too small' })
  await t.exception(requestInvoice(params, { msats: 5000 }), /amount too small/)

  stub.reply = () => ({})
  await t.exception(requestInvoice(params, { msats: 5000 }), /returned no invoice/)
})
