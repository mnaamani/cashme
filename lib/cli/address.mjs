// Which key a run presents on the wire, and saying so.
//
// Every transport ends in the same Noise handshake, so the key a sender connects with
// lands on the receiver as conn.remotePublicKey whichever wire carried it — and the choice
// is therefore the same one on all three: a key belonging to this run alone, or this
// wallet's own address. A run-only key is the default, because it leaves nothing reusable
// behind and nothing to look up afterwards; --stable is the deliberate opposite, and one
// address a sender can keep and reach this wallet on over any of the three.
//
// What that costs is different per wire, and lib/tui/screens/settings.mjs is where it is
// said. The hyperdht announces the key to the world, so a stable one is a lookup anybody
// can do. Bluetooth advertises it on a fixed public topic, so a stable one is a wallet
// recognisable to anyone scanning the room, session after session. The local network
// answers a multicast query with it, so a stable one turns 'a wallet is listening here'
// into 'this wallet is here'. None of that is true of a key that lasts one run.
import { dhtAddress, ephemeralAddress } from '../dht.mjs'
import { seedFromHex } from '../seed.mjs'
import { note } from '../notes.mjs'

// Which address this run presents by default, set once from the command line the way
// --proxy is (see lib/net.mjs) rather than passed down through every call. A run-only key
// unless asked otherwise, and `cashme ui` can move it while it is up — the mode is a
// property of the session, not of one send.
let stableByDefault = false

export function configureAddress({ stable = false } = {}) {
  stableByDefault = Boolean(stable)
}

// 'stable' or 'ephemeral', which is what a screen shows and what a setting is called.
export function addressMode() {
  return stableByDefault ? 'stable' : 'ephemeral'
}

export function setAddressMode(mode) {
  stableByDefault = mode === 'stable'
  return addressMode()
}

// `listening` distinguishes the two sides: a receiver's key is read out and its
// permanence is the user's to weigh, while a sender's is never seen and only becomes this
// wallet's own when asked for.
//
// A command's own --stable turns it on for that run whatever the global says, so
// `cashme --stable give` and `cashme give --stable` agree. paparam gives an unset boolean
// flag as false rather than undefined, so this is an or and not a ??: the command flag can
// add the wallet's address, never take it away.
//
// The keypair is the same shape on every wire — hyperdht derives ed25519 the way
// hypercore-crypto does, and @hyperswarm/secret-stream takes either — so one identity
// serves the dht node, the bluetooth swarm and the local network's Noise stream alike.
export function wireIdentity(wallet, flags = {}, { listening = false } = {}) {
  if (!(flags.stable || stableByDefault)) {
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
