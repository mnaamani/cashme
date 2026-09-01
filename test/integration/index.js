// The integration suite: the wallet against a real mint, the handover against the real
// hyperdht and across the local network, and the nostr code against a relay that can be made to misbehave. Slower than
// `npm test` and, for the mint and dht halves, needs the network — run it with
// `npm run test:integration`.
//
// Set CASHME_TEST_OFFLINE=1 to skip everything that needs the network; the relay and lnurl
// tests are local and always run. CASHME_TEST_MINT points the spending tests elsewhere.
require('./relay.test.mjs')
require('./lnurl.test.mjs')
require('./mint.test.mjs')
require('./dht.test.mjs')
require('./lan.test.mjs')
require('./nutzap.test.mjs')
