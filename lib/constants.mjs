// Mint used when the user does not name one. testnut is a testing mint whose lightning
// invoices settle themselves — its ecash is worthless.
export const DEFAULT_MINT_URL = 'https://testnut.cashu.space'

// A shortlist for `--mint`, shown in `deposit --help`. Every mint is custodial: the
// operator holds the bitcoin backing our ecash and can walk off with it, so this is a
// starting point for finding one, not an endorsement of any. Reviews live at
// bitcoinmints.com and proof-of-liabilities audits at audit.8333.space.
export const KNOWN_MINTS = [
  ['https://mint.minibits.cash/Bitcoin', 'Minibits wallet mint'],
  ['https://mint.coinos.io', 'Coinos lightning wallet'],
  ['https://mint.lnvoltz.com', 'Voltz'],
  ['https://mint.macadamia.cash', 'macadamia wallet mint'],
  ['https://mint.cubabitcoin.org', 'Cuba Bitcoin community']
]

// The whole wallet lives in these two files under the storage directory. wallet.json holds
// coco's repositories — proofs, quotes, operations, history, NUT-13 counters — in plaintext,
// mode 0600. The lock file is empty and exists only to be flock'd, one instance at a time.
export const WALLET_FILE = 'wallet.json'
export const WALLET_LOCK_FILE = 'wallet.lock'

// Relays `cashme nutzap` reads and writes when the user names none. A nutzap goes to the
// relays the recipient asked for (their kind 10019 event); these are only where we go
// looking for that event in the first place.
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band'
]
