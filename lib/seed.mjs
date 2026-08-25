import crypto from 'bare-crypto'

// NUT-13: deterministic secrets.
//
// Every blinded secret we send to a mint is derived from this seed plus a per-keyset
// counter, so the mint can be asked to re-sign the same secrets later. That is what makes
// `cashme restore` able to repair a wallet that fell behind the mint — a deposit whose
// proofs were signed but never written to disk, say, or a handoff that died mid-flight.
//
// This is deliberately NOT a BIP39 phrase the user is asked to write down: the seed lives
// in the wallet file and nowhere else. Lose the file and the ecash is gone — for a wallet
// meant to hold small amounts, the way out is to spend it or melt it back to lightning,
// not to restore it on another machine.

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
  // coco's SeedService checks for a Uint8Array; Bare's Buffer is one, but hand it a plain
  // Uint8Array so we do not depend on that staying true.
  return new Uint8Array(seed)
}
