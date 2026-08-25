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

Run `cashme <command> --help` for details on any command, or `cashme --help` for the full
list.

### balance

What this wallet holds, per mint and in total:

```sh
cashme balance
```

Proofs that are on their way to someone else are reported separately as _reserved_. They
are not spendable, and are not lost: every run of `cashme` sweeps them, settling the ones
the receiver claimed and reclaiming the rest at the mint.

### deposit

Mint new ecash by paying a lightning invoice. `cashme` prints the invoice and waits for the
mint to see it paid:

```sh
cashme deposit --sats 100
cashme deposit --sats 100 --mint https://mint.example.com
```

Without `--mint` this uses `https://testnut.cashu.space`, a **testing mint whose invoices
pay themselves and whose ecash is worthless**. Name a real mint before expecting real money.

### give

Send ecash to a nearby device, addressed by the public key (or any prefix of it) that the
receiver's `cashme get` prints when it joins the BLE swarm:

```sh
cashme give --public-key a1b2c3 --sats 21
cashme give --public-key a1b2c3 --sats 21 --mint https://mint.example.com
```

`--sats` is what the receiver ends up with; the mint's swap fee comes out of your balance
on top, and is printed before the handoff. A token can only be spent at the mint that
issued its proofs, so without `--mint` this picks the first mint holding enough on its own
rather than pooling several.

The proofs are reserved before the search for a neighbour begins, so a spend that cannot
happen fails immediately instead of after a wait. If no neighbour is found they are handed
straight back. If the handoff completes but the receiver never acknowledges it, `cashme`
tries to swap them back at the mint; should that fail, they stay tracked and the next run
tries again.

### get

Wait for a nearby neighbour to send ecash. Prints this device's public key on joining the
BLE swarm — read it out to whoever is sending:

```sh
cashme get
```

The received token names its own mint, which this wallet then trusts and swaps against —
so only run this for a sender you trust.

### restore

Rebuild proofs a mint issued but this wallet never recorded — a deposit interrupted before
it was written to disk, say:

```sh
cashme restore
cashme restore --mint https://mint.example.com
```

This is a repair, not a backup. It replays the deterministic secrets (NUT-13) derived from
the seed inside this wallet's own file, so it recovers nothing if that file is gone. It
runs against one mint at a time, because a seed does not record which mints it was used at,
and it only works on a wallet that has _lost_ proofs: coco refuses to re-add a proof it
already holds, so restoring into a wallet that still has its proofs does nothing and says
so.

### pay

Melt ecash back into lightning sats — pay a bolt11 invoice out of the wallet:

```sh
cashme pay --invoice lnbc...
cashme pay --invoice lnbc... --mint https://mint.example.com --yes
```

The mint quotes the invoice first, and `cashme` shows what it will cost before anything is
spent:

```
Paying from https://mint.example.com
  invoice     3 sat
  fee reserve 1 sat
  total       4 sat of 7 available
Pay this invoice? [y/N]
```

The fee reserve is the mint's worst case for routing the payment; whatever it does not use
comes back as change, and the fee actually paid is reported once the payment settles.
`--yes` skips the prompt, which also makes the command usable from a script; the prompt
reads a line from stdin, so `echo y | cashme pay ...` works too. Without `--mint` the
payment comes from the mint holding the most.

> **Known limitation on mints that charge input fees.** coco 2.0.0 does not budget for a
> mint's per-input fee when a melt needs a swap first: it reserves exactly what the swap
> sends, and the fee comes out of the same proofs, so the swap is short. Because coco only
> swaps once the selected proofs reach 11/10 of what the melt needs, a payment can only go
> through when the total is more than ten times that fee — below that, no combination of
> proofs works.
>
> `cashme` checks the mint's `input_fee_ppk` against the quote and refuses those payments
> before reserving anything, telling you the smallest total that could work at that mint.
> Above the floor it goes ahead, and if coco still comes up short the operation rolls back
> with the balance unchanged. The default mint, `testnut.cashu.space`, charges
> `input_fee_ppk: 100`, which puts its floor at 11 sat; a mint with no input fee has none.

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
CASHME_DEBUG=1 cashme pay --invoice lnbc...
```

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

- `bin.mjs` - entrypoint, CLI commands and runtime wiring
- `lib/manager.mjs` - opens the coco wallet and drives the deposit/send/receive/restore flows
- `lib/coco-store.mjs` - coco `Repositories` adapter for Bare: persistence, rollback, locking
- `lib/ble.mjs` - bluetooth transport for handing a token to a neighbour
- `lib/seed.mjs` - the NUT-13 seed deterministic secrets derive from
- `lib/mint-url.mjs` - canonical mint urls, and the validation coco's normalizer leaves out
- `lib/lock.mjs` - advisory lock, one instance per storage directory
- `lib/constants.mjs`, `lib/polyfills.mjs` - defaults, and the browser globals Bare lacks
- `app.js` - daemon launcher and updater resource
- `scripts/make.js` - platform/arch build target selector
- `test/index.js` - brittle-bare test entrypoint
- `test/coco-contract.test.mjs` - coco's own storage adapter contract suites, run against `lib/coco-store.mjs`
