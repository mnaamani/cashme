// The whole wallet lives in these two files under the storage directory. wallet.json holds
// coco's repositories — proofs, quotes, operations, history, NUT-13 counters — in plaintext,
// mode 0600. The lock file is empty and exists only to be flock'd, one instance at a time.
export const WALLET_FILE = 'wallet.json'
export const WALLET_LOCK_FILE = 'wallet.lock'

// The nostr relays this wallet asks and publishes to, when it has chosen its own rather
// than the defaults below. Beside the wallet rather than inside it: it is not money, and it
// is read on paths that deliberately have not taken the wallet lock yet (see lib/relays.mjs).
export const RELAYS_FILE = 'relays.json'

// The relays this binary ships with: where `cashme nutzap` and `cashme zap` look when the
// wallet has not chosen its own. A nutzap goes to the relays the recipient asked for (their
// kind 10019 event); these are only where we go looking for that event in the first place.
//
// `cashme relays` is how a wallet keeps a different list — after which these are only what
// `--reset` goes back to.
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band'
]
