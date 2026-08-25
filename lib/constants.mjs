// Mint used when the user does not name one. testnut is a testing mint whose lightning
// invoices settle themselves — its ecash is worthless.
export const DEFAULT_MINT_URL = 'https://testnut.cashu.space'

// Everything the wallet owns lives in these two files under the storage directory: the
// proofs, quotes, operations, history and NUT-13 counters coco's repositories hold, in
// plaintext with mode 0600. The lock file is empty and disposable; it exists only to be
// flock'd, so two instances cannot write over each other.
export const WALLET_FILE = 'wallet.json'
export const WALLET_LOCK_FILE = 'wallet.lock'
