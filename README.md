# CASHME .... if you can

> A cashu wallet in your terminal, send and receive tokens privately over bluetooth.

## EXPERIMENTAL - Use at your own risk !!

## Getting started

Build and run:

```sh
npm install
npm run make
./out/your-platform/cashme
```

or install pre-built binary with `pear`:

```sh
npm -g install pear
pear install pear://tdnucsbcqeqer3yuyxduty4666zxr1f6ihua1j17g3pwr1qrnd9o
```

or with `npx`:

```sh
npx pear-install pear://tdnucsbcqeqer3yuyxduty4666zxr1f6ihua1j17g3pwr1qrnd9o
```

Then run installed binary

`cashme --help`

## Usage

`cashme` is a terminal cashu wallet. ecash tokens are exchanged directly between two
devices over Bluetooth Low Energy (BLE), with no server in between.

Run `cashme <command> --help` for any command, or `cashme --help` for the full list.

### balance

```sh
cashme balance
```

Per mint and in total. Proofs on their way to someone else show as _reserved_: not
spendable, not lost. Every run of `cashme` sweeps them — settling the ones the receiver
claimed, reclaiming the rest at the mint.

### deposit

Mint new ecash by paying a lightning invoice. `cashme` prints the invoice and waits for the
mint to see it paid:

```sh
cashme deposit --sats 100
cashme deposit --sats 100 --mint https://mint.example.com
```

Short flags: `-s`, `-m`.

Without `--mint` this uses `https://testnut.cashu.space`, a **testing mint whose invoices
pay themselves and whose ecash is worthless**. Name a real mint before expecting real money.

### withdraw

Melt ecash back into lightning sats — the counter to `deposit`. Pays a bolt11 invoice
out of the wallet:

```sh
cashme withdraw --invoice lnbc...
cashme withdraw --invoice lnbc... --mint https://mint.example.com --yes
```

Short flags: `-i`, `-m`, `-y`.

The mint quotes the invoice first, and `cashme` shows the cost before anything is spent:

```
Paying from https://mint.example.com
  invoice     3 sat
  fee reserve 1 sat
  total       4 sat of 7 available
The fee reserve is the mint's worst case; whatever is left comes back as change.
Pay this invoice? [y/N]
```

The fee actually paid is reported once the payment settles. `--yes` skips the prompt; the
prompt reads a line from stdin, so `echo y | cashme withdraw ...` works too. Without `--mint`
the payment comes from the mint holding the most.

> **Known limitation on mints that charge input fees.** coco 2.0.0 does not budget for a
> mint's per-input fee when a melt needs a swap first: it reserves exactly what the swap
> sends, and the fee comes out of the same proofs, so the swap is short. Since coco only
> swaps once the selected proofs reach 11/10 of what the melt needs, a payment can only go
> through when its total is more than ten times that fee.
>
> `cashme` checks the mint's `input_fee_ppk` against the quote and refuses such payments
> before reserving anything, naming the smallest total that could work there. Above that
> floor it goes ahead, and if coco still comes up short the operation rolls back with the
> balance unchanged. The default mint, `testnut.cashu.space`, charges `input_fee_ppk: 100`,
> putting its floor at 11 sat; a mint with no input fee has none.

### give

Send ecash to a nearby device, addressed by the public key (or any prefix of it) that the
receiver's `cashme get` prints:

```sh
cashme give --public-key a1b2c3 --sats 21
cashme give --public-key a1b2c3 --sats 21 --mint https://mint.example.com
```

Short flags: `-k`, `-s`, `-m`.

`--sats` is what the receiver ends up with; the mint's swap fee comes out of your balance
on top, and is printed before the handoff. A token can only be spent at the mint that
issued its proofs, so without `--mint` this picks the first mint holding enough on its own
rather than pooling several.

Proofs are reserved before the search for a neighbour starts, so an impossible spend fails
immediately rather than after a wait. Ctrl-C while waiting hands them straight back, as
does giving up on a neighbour that never appears. If the handoff completes but the receiver
never acknowledges it, `cashme` tries to swap the proofs back; should that fail they stay
tracked, and the next run tries again.

### get

Wait for neighbours to send ecash. Prints this device's public key on joining the BLE
swarm — read it out to whoever is sending:

```sh
cashme get
```

It keeps listening until Ctrl-C, so several senders (or the same one twice) need only one
run. Each token names its own mint, which this wallet then trusts and swaps against — so
only run this for a sender you trust.

### nutzap

Send ecash to a nostr user (NIP-61):

```sh
cashme nutzap --pubkey npub1... --sats 21
cashme nutzap --pubkey alice@example.com --sats 21
cashme nutzap -p npub1... -s 21 -c "thanks!" -m https://mint.example.com -y
```

Short flags: `-p`, `-s`, `-m`, `-r`, `-c`, `-e`, `-y`.

A nutzap is not a lightning zap. A NIP-57 zap is a lightning payment with a nostr receipt —
that would be `cashme withdraw` with an address lookup in front of it. A nutzap moves the ecash
itself: the proofs are locked to the recipient's public key (NUT-11 P2PK) and published in
the tags of a kind `9321` event. No invoice, no route, no routing fee. It is `give`, over
relays instead of bluetooth.

What happens on a run:

1. Work out whose key to send to. `--pubkey` takes an `npub1...`, a bare hex key, or a
   `name@domain` nostr address (NIP-05), which is resolved by asking that domain for
   `/.well-known/nostr.json`. An address is the domain's claim over TLS, not a signed one,
   so it is used only to find whose profile to look up — the key the ecash is locked to
   still comes from the recipient's own signed event. Any relays the domain hints at are
   added to the lookup.
2. Read the recipient's kind `10019` event from the relays — the mints they will redeem at,
   the key to lock to, and the relays they read. `--relay` adds relays to query, repeatable.
   Every event a relay sends is checked against its own id and signature, and against the
   kind and author asked for, before any of it is believed: a relay that could forge a
   `10019` could name its own key as the one to lock the ecash to.
3. Pick a mint they trust and this wallet holds enough at. `--mint` overrides, and warns if
   they did not list it.
4. Prepare the send, show the cost, and ask — `--yes` skips the prompt, as with `withdraw`.
5. Execute, then publish the nutzap to their relays, signed by a nostr key generated for
   that one event and thrown away. The zap is anonymous: relays need a signature, the
   recipient does not need to know who we are.

```
Resolving alice@example.com
  alice@example.com is 82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2
Looking up 82341f882b6e… on 4 relays
Spending from https://testnut.cashu.space
  amount   8 sat (+ 1 mint fee)
  locked to 026d2a9992b45f5d0885fb3abb5cb8f6e69b6e6f288dcac3f0180e566fb6ddcbce
  relays   wss://relay.damus.io, wss://nos.lol
Once sent, only the recipient can spend this ecash — it cannot be reclaimed.
Send this nutzap? [y/N]
```

> **One-way.** Once the send executes, the proofs need the recipient's key to spend, so
> nothing can bring them back — unlike `give`, which reclaims when a neighbour never
> acknowledges. Everything that can fail is checked before that point, and if no relay
> accepts the event afterwards `cashme` prints the signed event so it can be published by
> hand.

Receiving nutzaps is not implemented: it needs a stable nostr identity for this wallet —
a key to publish a kind `10019` under and to unlock P2PK proofs with — where sending needs
no identity at all.

### restore

Rebuild proofs a mint issued but this wallet never recorded — a deposit interrupted before
it was written to disk, say:

```sh
cashme restore
cashme restore --mint https://mint.example.com
```

Short flag: `-m`.

A repair, not a backup. It replays the deterministic secrets (NUT-13) derived from the seed
inside this wallet's own file, so it recovers nothing if that file is gone. One mint at a
time, because a seed does not record which mints it was used at. And only for proofs the
wallet has _lost_: coco refuses to re-add a proof it already holds, so restoring into an
intact wallet does nothing and says so.

### Global flags

```sh
cashme --version                      # print the version
cashme --storage ./wallet balance     # use a specific storage directory
cashme --no-updates balance           # skip the OTA updater for this run
cashme --update-window 60000 balance  # how long the updater waits, in ms
```

## The wallet on disk

Everything lives in two files in the storage directory:

- `wallet.json` — proofs, mints, quotes, operations, history, the NUT-13 seed and its
  per-keyset counters. Plaintext, mode `0600`. **Not encrypted**: `cashme` is for small
  amounts, and the way out of a wallet is to spend it or melt it, not to unlock a backup
  somewhere else. Lose this file and the ecash in it is gone.
- `wallet.lock` — empty, and only there to be locked. One `cashme` may hold a wallet at a
  time; a second one is refused rather than allowed to overwrite the first one's proofs.

The wallet itself is [coco](https://github.com/cashubtc/coco) (`@cashu/coco-core`), stored
through a Bare adapter in `lib/coco-store.mjs` — coco's published adapters are SQLite,
IndexedDB and expo-sqlite, none of which run under Bare.

## Development

Built on pear-runtime, [hello-pear-bare](https://github.com/holepunchto/hello-pear-bare/tree/variant/daemon) daemon variant.

### Install Dependencies

```sh
npm install
```

```sh
npm start
```

By default this repo starts with `--no-updates` in development to avoid local dev binaries being swapped while you iterate.

Enable updates for local flow testing:

```sh
npm start -- --updates
```

Set how long the daemon waits for an update:

```sh
npm start -- --updates --update-window 60000
```

Development runs are unbundled, so they exercise the daemon lifecycle without replacing the local Bare executable. Updates are applied by standalone builds.

Errors print their message only. For the stack behind one:

```sh
CASHME_DEBUG=1 cashme withdraw --invoice lnbc...
```

### Debug logging

Internal logging goes through [`bare-debug-log`](https://github.com/holepunchto/bare-debug-log)
and is off unless `BARE_DEBUG` names a section. It writes to stderr, so stdout stays free
for command output. Sections are `cashme:app` (startup, storage) and `cashme:ble`
(bluetooth swarm, connections, token transfer):

```sh
BARE_DEBUG=cashme:* cashme get
BARE_DEBUG=cashme:ble cashme give -k <pubkey> -s 10
```

With `cashme:app` enabled (`BARE_DEBUG=cashme:*` covers it) error stacks print too, so
there is no need to set `CASHME_DEBUG` as well.

## Architecture

### Updates

Updates are managed by the `App` class in `app.js`. The foreground CLI starts itself in a detached updater mode with `bare-daemon`. The updater owns `Corestore`, `Hyperswarm` and `PearRuntime`, while `updater.lock` ensures only one updater runs per storage directory.

It uses the configured `upgrade` link in `package.json`, waits 30 seconds by default and writes output to `<storage>/updates.log`. Once a download starts, the daemon remains alive until the update is applied or an error occurs.

Per-run disable updates:

```sh
npm start -- --no-updates
```

## Scripts

- `npm start` - run the Bare Process in dev mode (`bare bin.mjs --no-updates`)
- `npm test` - run `brittle-bare` tests
- `npm run lint` - run prettier check and lunte
- `npm run format` - format repository with prettier
- `npm run make` - auto-detect host OS/arch and run matching build target
- `npm run make:darwin-arm64` - build standalone to `out/darwin-arm64`
- `npm run make:darwin-x64` - build standalone to `out/darwin-x64`
- `npm run make:linux-arm64` - build standalone to `out/linux-arm64`
- `npm run make:linux-x64` - build standalone to `out/linux-x64`
- `npm run make:win32-arm64` - build standalone to `out/win32-arm64`
- `npm run make:win32-x64` - build standalone to `out/win32-x64`

## Project Structure

- `bin.mjs` - entrypoint: argv, storage directory, dispatch
- `lib/cli/` - one module per command, plus the flag grammar (`commands.mjs`), the wallet's
  lifetime and Ctrl-C handling (`session.mjs`) and the printing (`ui.mjs`)
- `lib/manager.mjs` - opens the coco wallet and drives the deposit/send/receive/restore flows
- `lib/coco-store.mjs` - coco `Repositories` adapter for Bare: persistence, rollback, locking
- `lib/ble.mjs` - bluetooth transport for handing a token to a neighbour
- `lib/nostr.mjs` - the keys, signed events and relay sockets `nutzap` needs
- `lib/seed.mjs` - the NUT-13 seed deterministic secrets derive from
- `lib/mint-url.mjs` - canonical mint urls, and the validation coco's normalizer leaves out
- `lib/lock.mjs` - advisory lock, one instance per storage directory
- `lib/updater.mjs` - OTA updates: spawning the daemon, and being it
- `lib/constants.mjs`, `lib/polyfills.mjs` - defaults, and the browser globals Bare lacks
- `app.js` - daemon launcher and updater resource
- `scripts/make.js` - platform/arch build target selector
- `test/index.js` - brittle-bare test entrypoint, requiring the suites below
- `test/coco-contract.test.mjs` - coco's own storage adapter contract suites, run against `lib/coco-store.mjs`
- `test/coco-store.test.mjs` - serialization, rollback and locking in `lib/coco-store.mjs`
- `test/melt-fee.test.mjs` - the input-fee floor `cashme withdraw` refuses below
- `test/mint-url.test.mjs` - mint url normalization and validation
- `test/nostr.test.mjs` - npub decoding and NIP-01 event ids and signatures
