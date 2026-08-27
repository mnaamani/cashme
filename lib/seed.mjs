import crypto from 'bare-crypto'

// NUT-13: deterministic secrets.
//
// Every blinded secret sent to a mint derives from this seed plus a per-keyset counter, so
// the mint can be asked to re-sign the same secrets later — which is what lets
// `cashme restore` repair a wallet that fell behind the mint.
//
// Deliberately NOT a BIP39 phrase to write down: the seed lives in the wallet file and
// nowhere else. Lose the file and the ecash is gone. For small amounts the way out is to
// spend or melt it, not to restore it elsewhere.

// coco's SeedService requires 64 bytes, the length a BIP39 mnemonic derives to.
const SEED_BYTES = 64

export function newSeed() {
  return crypto.randomBytes(SEED_BYTES)
}

export function seedToHex(seed) {
  return Buffer.from(seed).toString('hex')
}

export function seedFromHex(hex) {
  const seed = Buffer.from(hex, 'hex')
  if (seed.length !== SEED_BYTES) {
    throw new Error(`wallet seed must be ${SEED_BYTES} bytes of hex, got ${seed.length}`)
  }
  // coco's SeedService checks for a Uint8Array. Bare's Buffer is one, but hand over a
  // plain Uint8Array rather than depend on that staying true.
  return new Uint8Array(seed)
}
