// Mint used when the user does not name one. testnut is a testing mint whose lightning
// invoices settle themselves — its ecash is worthless.
export const DEFAULT_MINT_URL = 'https://testnut.cashu.space'

// The whole wallet lives in these two files under the storage directory. wallet.json holds
// coco's repositories — proofs, quotes, operations, history, NUT-13 counters — in plaintext,
// mode 0600. The lock file is empty and exists only to be flock'd, one instance at a time.
export const WALLET_FILE = 'wallet.json'
export const WALLET_LOCK_FILE = 'wallet.lock'
