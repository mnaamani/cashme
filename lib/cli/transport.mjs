// Which wire a run uses. Both `give` and `get` face the same three-way choice and must
// reject the same contradiction, so it is decided here rather than twice.
//
// Bluetooth is the default because it needs nothing but the two people being in the same
// room: no network to be on, no key on a public DHT. --lan is for the room that bluetooth
// cannot cross but one wi-fi does, and --dht for the receiver who is not in the room at
// all. What each costs is in `cashme give --help`.
export const BLE = 'ble'
export const LAN = 'lan'
export const DHT = 'dht'

// What to call it in a sentence.
export const WIRE = {
  [BLE]: 'bluetooth',
  [LAN]: 'the local network',
  [DHT]: 'the hyperdht'
}

// Named together they are a contradiction: one of them has to be what the run does, and
// which was typed last is not knowable here — so say so rather than quietly picking.
export function transportFrom(flags) {
  if (flags.dht && flags.lan) {
    throw new Error('--dht and --lan are two different wires — pass one of them')
  }
  if (flags.dht) return DHT
  if (flags.lan) return LAN
  return BLE
}
