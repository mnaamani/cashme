// The integration suite: the wallet against a real mint, and the nostr code against a relay
// that can be made to misbehave. Slower than `npm test` and, for the mint half, needs the
// network — run it with `npm run test:integration`.
//
// Set CASHME_TEST_OFFLINE=1 to skip everything that needs the mint; the relay and lnurl
// tests are local and always run. CASHME_TEST_MINT points the spending tests elsewhere.
require('./relay.test.mjs')
require('./lnurl.test.mjs')
require('./mint.test.mjs')
require('./nutzap.test.mjs')
