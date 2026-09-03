# Usage

`cashme` is a terminal cashu wallet. ecash tokens are exchanged directly between two
devices over Bluetooth Low Energy (BLE), the local network or the hyperdht, with no server
in between — or
handed over as text or a QR code, for you to carry across whatever channel you trust.

Run `cashme` on its own and it opens the whole wallet on one screen — that is the `ui`
command, and it is what happens with no command given. The commands below are the other
way in, and the way to get a token or an invoice out of this wallet and into something
else.

Run `cashme <command> --help` for any command, or `cashme --help` for the full list.

## Commands

- [ui](../../README.md) — the whole wallet on one screen, and what bare `cashme` runs
- [balance](balance.md) — what this wallet can spend, per mint and in total
- [mints](mints.md) — which mints this wallet trusts, and trusting or untrusting one
- [relays](relays.md) — the nostr relays `zap` and `nutzap` ask, and adding or removing one
- [deposit](deposit.md) — mint new ecash by paying a lightning invoice
- [withdraw](withdraw.md) — melt ecash back into lightning sats
- [give](give.md) — hand a token to a nearby device, or print it as text or a QR code
- [get](get.md) — wait for a neighbour to send ecash, or take a token you were handed
- [pending](pending.md) — the sends still out in the world, and how they settle
- [nutzap](nutzap.md) — send ecash to a nostr user (NIP-61)
- [zap](zap.md) — pay a nostr user over lightning, with a receipt (NIP-57)
- [restore](restore.md) — rebuild proofs a mint issued but this wallet never recorded
- [licenses](licenses.md) — the licenses of everything compiled into the binary

## The rest

- [Global flags](global-flags.md) — the flags every command takes
- [Where the traffic goes](where-the-traffic-goes.md) — what a mint, a relay or a proxy
  sees, and what `--proxy` and `--dht-interface` each cover
- [The wallet on disk](wallet-on-disk.md) — the files in the storage directory
