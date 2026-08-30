// Which hyperdht key a run presents, and saying so.
//
// Both `give --dht` and `get --dht` face the same choice — one belonging to this run
// alone, or this wallet's own address — and it is the same choice on either side of the
// link, since the key a sender connects with lands on the receiver as
// conn.remotePublicKey. A run-only key is the default on both, because it leaves nothing
// reusable behind and nothing to look up afterwards; --stable is the deliberate opposite.
// Bluetooth has no such choice: its keys are always for one run (see lib/ble.mjs).
import { dhtAddress, ephemeralAddress } from '../dht.mjs'
import { seedFromHex } from '../seed.mjs'
import { note } from '../notes.mjs'

// `listening` distinguishes the two sides: a receiver's key is read out and its
// permanence is the user's to weigh, while a sender's is never seen and only becomes this
// wallet's own when asked for.
export function dhtIdentity(wallet, flags, { listening = false } = {}) {
  if (!flags.stable) {
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

// --stable says nothing on bluetooth, where every key is already for one run and there is
// no wallet address to present. Said out loud rather than ignored, so the flag is not read
// as having done something.
export function warnStable(flags) {
  if (flags.stable && !flags.dht) {
    note('--stable is redundant without --dht: the bluetooth key is new every run')
  }
}
