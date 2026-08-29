// Which hyperdht key a run presents, and saying so.
//
// Both `give --dht` and `get --dht` face the same choice — this wallet's own address, or
// one belonging to this run alone — and it is the same choice on either side of the link,
// since the key a sender connects with lands on the receiver as conn.remotePublicKey.
// Bluetooth has no such choice: its keys are always for one run (see lib/ble.mjs).
import { dhtAddress, ephemeralAddress } from '../dht.mjs'
import { seedFromHex } from '../seed.mjs'
import { note } from '../notes.mjs'

// `listening` distinguishes the two sides: a receiver's key is read out and its
// permanence is the user's to weigh, while a sender's is never seen and only stops being
// the default when asked for.
export function dhtIdentity(wallet, flags, { listening = false } = {}) {
  if (flags.ephemeral) {
    note(
      listening
        ? 'this key is for this run only — the sender needs it now'
        : "sending under a one-run key: this send is not tied to this wallet's address"
    )
    return ephemeralAddress()
  }
  if (listening) {
    note("this key is this wallet's address, the same every run — the sender can keep it")
  }
  return dhtAddress(seedFromHex(wallet.repos.seedHex))
}

// --ephemeral says nothing on bluetooth, where every key is already for one run. Said out
// loud rather than ignored, so the flag is not read as having done something.
export function warnEphemeral(flags) {
  if (flags.ephemeral && !flags.dht) {
    note('--ephemeral is redundant without --dht: the bluetooth key is new every run')
  }
}
