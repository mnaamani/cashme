# CASHME .... if you can

> A cashu wallet in your terminal, send and receive tokens privately over bluetooth.

## EXPERIMENTAL - Use at your own risk !!

## Install

With a shell, taking the binary for your platform from the latest
[release](https://github.com/mnaamani/cashme/releases):

```sh
curl -fsSL https://raw.githubusercontent.com/mnaamani/cashme/main/install.sh | sh
```

or with npm, which bootstraps the same binary off the pear network instead:

```sh
npm install -g @cashme/cli
```

or with `pear` itself, or `pear-install` on its own:

```sh
npm install -g pear
pear install pear://tdnucsbcqeqer3yuyxduty4666zxr1f6ihua1j17g3pwr1qrnd9o

npx pear-install pear://tdnucsbcqeqer3yuyxduty4666zxr1f6ihua1j17g3pwr1qrnd9o
```

Every route puts the same standalone binary in `~/.local/bin/cashme`
(`%LOCALAPPDATA%\Programs\cashme\cashme.exe` on windows) and, if that directory is not on
your PATH, adds it to your shell's rc file. Open a new terminal, then:

```sh
cashme --help
```

The wallet keeps itself up to date in the background from its own pear link, so whichever
way it got there, it does not need reinstalling to move to a newer version. `--no-updates`
skips that for a run. To uninstall, delete the binary — the wallet's storage lives
[elsewhere](#the-wallet-on-disk) and outlives it.

### Which route to use

- **`curl | sh`** ([`install.sh`](install.sh)) needs nothing but curl. It downloads the
  release asset for your platform, checks it against the release's `SHA256SUMS`, and
  installs it. `--dir` puts it somewhere else, `--version` pins a release, `--force`
  replaces an existing install; `sh install.sh --help` lists the rest. With no release
  asset for your platform it falls back to the pear network, which needs node.
- **`npm install -g @cashme/cli`** ([`npm/`](npm)) installs a shim that, on its first run,
  fetches the binary and then execs it — the same shape as `npm i -g pear`. Nothing but the
  shim comes from the registry, so the wallet itself is never a package update behind. It
  tries the pear network first and falls back to the same release download `install.sh`
  does, `SHA256SUMS` check included, so neither route depends on the other working;
  `CASHME_METHOD=release` (or `pear`) forces one. That first run is also where it can fail,
  and since `npm install` has already succeeded by then the retry is `cashme` again rather
  than a reinstall. Whatever you typed is carried through, so `cashme balance` on a new
  machine installs the wallet and then reports the balance.
- **`pear install`** is the same bootstrap, done by the pear CLI you may already have.

### Build from source

```sh
npm install
npm run make
./out/your-platform/cashme --help
```

`npm run make` builds for the host it runs on; `npm run make:<host>` cross-builds for any
of `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`.

Tagging `v*` runs [`release.yaml`](.github/workflows/release.yaml), which builds all six
once and packages that one compile for both channels:

- `cashme-<host>.tar.gz` (`.zip` on windows), one per host — what `install.sh` downloads.
- `by-arch.tar.gz`, every host in the layout `pear-install` and the OTA updater read — what
  gets seeded to the pear link.
- `SHA256SUMS` over all of them.

Everything lands on the GitHub release, so the two channels can never disagree within a
release. A `workflow_dispatch` with a tag republishes that tag; with no tag it builds the
artifacts and publishes nothing. The run refuses to start if `package.json`'s version does
not match the tag, because the updater compares exactly that against the running binary and
a mismatch would ship a build that updates nobody.

### Seeding a release

The GitHub release covers `install.sh` on its own. The pear link is a second step, run from
the machine holding its writer key — a stage drive is machine-bound:

```sh
npm run stage              # stage the latest release
npm run stage -- v0.1.0    # or a specific one
npm run stage -- --dry-run # download, check, show the diff, stage nothing
pear seed pear://tdnucsbcqeqer3yuyxduty4666zxr1f6ihua1j17g3pwr1qrnd9o
```

[`scripts/stage.sh`](scripts/stage.sh) downloads `by-arch.tar.gz` from the release, verifies
it against `SHA256SUMS`, unpacks it outside the repo (a deployment directory left inside the
app folder gets swept into the next stage, and the drive is append-only), then dry-runs
`pear stage` and asks before running it for real. It refuses outright if the build's version
does not match the tag, or if the build polls a different link than the one being staged to
— both produce a stage that looks fine and ships nothing usable, and neither can be undone.

Until a release is staged, pear and npm users stay on whatever was seeded last while
`install.sh` users get the new build. Seeding is what brings the two back in step.

## Usage

`cashme` is a terminal cashu wallet. ecash tokens are exchanged directly between two
devices over Bluetooth Low Energy (BLE), the local network or the hyperdht, with no server
in between — or
handed over as text or a QR code, for you to carry across whatever channel you trust.

Run `cashme <command> --help` for any command, or `cashme --help` for the full list.

### balance

```sh
cashme balance
```

Per mint and in total, on stdout; anything explaining those figures goes to stderr.

A send whose token is already out there is in neither figure — coco counts the proofs it
can spend, and those are promised to someone else — so `balance` names the amount in
flight separately and points at `cashme pending`. Every run of `cashme` sweeps what it
safely can on the way: a send that never produced a token hands its proofs straight back,
and one the mint reports spent is settled. What is left is a token still out there, which
only you can say the fate of.

### deposit

Mint new ecash by paying a lightning invoice. `cashme` prints the invoice — to stdout, on
its own line — and waits for the mint to see it paid:

```sh
cashme deposit --amount 100
cashme deposit --amount 100 --mint https://mint.example.com
cashme deposit --amount 5 --unit usd --mint https://mint.example.com
```

Short flags: `-a`, `-m`, `-u`.

`--amount` is counted in `--unit`, which defaults to `sat`. A mint may issue more than one
unit, and each is a separate balance: 100 sat and 5 usd at the same mint are two holdings
that never add up or convert. Which units a mint offers is its own business — ask for one
it does not issue and the mint refuses.

`deposit`, `withdraw` and `give` take `--amount` with a `--unit`, because each of them
moves whichever unit the mint issued. `nutzap` and `zap` take `--sats` instead: nothing
about them is denominated any other way — a nutzap is priced in sats and an lnurl amount is
millisats.

Stopping the wait does not lose the deposit: if the invoice was paid, the next `cashme` to
open the wallet redeems it and says so, before it prints anything else.

Without `--mint` this uses `https://testnut.cashu.space`, a **testing mint whose invoices
pay themselves and whose ecash is worthless**. Name a real mint before expecting real money.

### withdraw

Melt ecash back into lightning sats — the counter to `deposit`. Pays a bolt11 invoice
out of the wallet:

```sh
cashme withdraw --invoice lnbc...
cashme withdraw --invoice lnbc... --mint https://mint.example.com --yes
cashme withdraw --invoice lnbc... --unit usd
```

Short flags: `-i`, `-m`, `-u`, `-y`.

`--unit` is which of the wallet's balances to melt from, defaulting to `sat`. Without
`--mint` the payment comes from the mint holding the most of that unit. The mint is asked
to quote in it, and a mint that answers in some other unit is refused before anything is
reserved.

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
prompt reads a line from stdin, so `echo y | cashme withdraw ...` works too.

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
cashme give --public-key a1b2c3 --amount 21
cashme give --public-key a1b2c3 --amount 21 --mint https://mint.example.com
cashme give --public-key a1b2c3 --amount 5 --unit usd
```

Short flags: `-k`, `-a`, `-u`, `-m`.

`--public-key` addresses the bluetooth link and nothing else — it is the key the receiver's
`cashme get` prints for that swarm, not a key the ecash is locked to. What travels over the
link is a bearer token, spendable by whoever ends up holding it. (Locking a send to a
recipient's key is what `nutzap` does, with their nostr key.)

`--amount` is what the receiver ends up with, counted in `--unit`; the mint's swap fee comes
out of your balance on top, and is printed before the handoff. A token can only be spent at
the mint that issued its proofs, so without `--mint` this picks the first mint holding
enough of that unit on its own rather than pooling several.

Proofs are reserved before the search for a neighbour starts, so an impossible spend fails
immediately rather than after a wait. Ctrl-C while waiting hands them straight back, as
does giving up on a neighbour that never appears. If the handoff completes but the receiver
never acknowledges it, `cashme` tries to swap the proofs back right away; if the mint says
they are already spent, the receiver did get them after all, and the send stays in flight
for `cashme pending` to settle.

#### Over the local network

Bluetooth reaches across a table; `--lan` reaches across a building, without leaving the
network you are both already on. The same handover runs over a plain TCP link between the
two machines, found by asking on the wire itself:

```sh
cashme give --lan --public-key a1b2c3 --amount 21
```

Short flag: `-l`. `--public-key` is again any prefix of the key the receiver's
`cashme get --lan` prints — the sender multicasts "anyone listening?" to the LAN, a
listening wallet answers with its key and a port, and the Noise handshake that follows
proves the key really is theirs. So the beacon cannot lie you into paying somebody else,
and a prefix long enough to be unambiguous in the room is enough to type.

Nothing here leaves the LAN and nothing contacts a server: the discovery datagrams go out
with a TTL of 1, so the first router drops them, and the link that carries the token is
straight to an address that answered on it. It works with the internet down; it does not
work between two people on different networks, which is what `--dht` is for. Guest wi-fi
and VPNs that block multicast between clients will find nobody.

The asking repeats every second, because multicast is dropped rather than retried, and
gives up after 30 seconds. Silence that long means something you can act on — their `get`
has stopped, you are not on the same network, or it does not pass multicast between
clients — so the error names those rather than waiting on. If something answered but not
under that key, it says so instead: the network is fine and the key is from an older run.

#### Over the hyperdht

Bluetooth reaches the room; `--dht` reaches anywhere. With it the same handover runs over
the [hyperdht](https://github.com/holepunchto/hyperdht) instead of the radio — a
holepunched UDP link straight to the receiver, still with no server in between and still
carrying exactly the same frames:

```sh
cashme give --dht --public-key <64-hex-key> --amount 21
```

Short flag: `-d`. `--public-key` is then the receiver's full 64-character key from
`cashme get --dht`, because it is an address rather than something to scan for: the DHT
resolves that exact key to the peer listening on it, so there is no prefix to match. It is
still only an address — the token it carries is bearer ecash, locked to nobody. It belongs
to the run of `cashme get --dht` that printed it, so you need the current one; if they ran
it with `--stable` the key is their wallet's own and does not change, so it is worth saving.

The link names you to them too. By default this wallet connects under a key of that run's
own, recognisable to nobody. `--stable` (`-s`) sends under this wallet's own address — the
same one its `cashme get --dht --stable` announces — so a receiver paid twice can tell both
sends came from here: useful if they ever want to accept only from people they know, and a
lasting identifier handed to everyone you pay otherwise.

```sh
cashme give --dht --stable --public-key <64-hex-key> --amount 21
```

Everything else is as it is over bluetooth: the proofs are reserved first, Ctrl-C hands
them back, and the receiver's acknowledgement is what settles the send. A peer that is not
listening fails within 30 seconds rather than waiting forever.

The wires above are not the only ways to hand a token over. `--print` writes it to stdout instead,
for you to carry over any channel you already trust — a private chat, a shared note —
`--qr` also draws it for a mobile ecash wallet to scan, and `--copy` puts it on the system
clipboard, ready to paste:

```sh
cashme give --amount 21 --print
cashme give --amount 21 --copy
cashme give --amount 21 --qr
```

Short flags: `-p`, `-q`, `-c`. Each of the three implies the others' "hand it over
yourself" part, so no `--public-key` is needed — nobody is being addressed.

The token is printed even when it goes on the clipboard: a clipboard is one copy away from
being overwritten, and the text is the only copy that survives that. Clipboards belong to
the system rather than to us, so this pipes into whichever program owns yours — `pbcopy` on
macOS, `clip` on Windows, `wl-copy`, `xclip` or `xsel` on linux. With none of them
installed — a headless box, say — it says so and the token is still on screen.

A token handed over this way gets no acknowledgement, so the mint is the only witness:
`cashme` polls it until the proofs come back spent, and the amount is out of the
balance meanwhile. Stop waiting whenever you like — the send stays pending, for `cashme pending` to
settle later. Nothing is reclaimed behind your back, because a printed token can still be
claimed by whoever holds it.

Only the token goes to stdout; everything `give` says about the send goes to stderr. So
`cashme give --amount 21 --print > token.txt` leaves the token alone in the file, with the
balances and the fee still on screen. `deposit` prints its invoice the same way.

A QR is one terminal column per module, and a token is base64url — case-sensitive, so no
alphanumeric-mode shortcut of the sort the deposit invoice gets. Only small tokens fit:
`cashme` says how wide the code would have to be when it does not, and the text above it
is just as good.

### get

Wait for neighbours to send ecash. Prints this device's public key on joining the BLE
swarm — read it out to whoever is sending:

```sh
cashme get
```

It keeps listening until Ctrl-C, so several senders (or the same one twice) need only one
run. Each token names its own mint, which this wallet then trusts and swaps against — so
only run this for a sender you trust.

The sender is told the token arrived as soon as it parses, before the mint has been asked
to swap it. So if that swap then fails — an unreachable mint, usually — the token on screen
is the only copy left, and `cashme` prints it rather than dropping it: keep it and claim it
with `--token` once the mint is back.

To be paid from across the building rather than across the table, listen on the local
network instead:

```sh
cashme get --lan
```

The key it prints is new every run, like the bluetooth one, and the sender needs the
current one — any prefix of it. Nothing is announced while this waits: it answers senders
that ask and says nothing otherwise. Anyone on that network can ask, though, so while it is
listening, everyone on the wi-fi can see that a wallet here is waiting to be paid — which
is worth knowing on a network you do not control. The key is that run's alone, so what they
learn is that somebody is listening now, not which wallet it is.

To be paid from anywhere rather than from the room, listen on the hyperdht instead:

```sh
cashme get --dht
```

Like the bluetooth key, the one this prints belongs to the run that printed it and leaves
nothing to look up afterwards. The sender needs it while the command is running, so it
suits a payment being arranged there and then rather than one that might arrive tomorrow.
All 64 characters of it, since the DHT resolves an exact key rather than scanning for a
prefix.

`--stable` instead derives the address from the wallet's own seed, so it is the same on
every run: a sender saves it once, the way they would a phone number, instead of being read
a fresh one per payment:

```sh
cashme get --dht --stable
```

That reusability is what it costs. Listening announces the key on the DHT together with the
address — or the relay nodes — that reach this machine, so anyone you have ever given it to
can afterwards check whether this wallet is online, and roughly from where, for as long as
the wallet exists. It says nothing about the seed behind it, and no ecash is locked to it,
but it is a lasting public identifier for the wallet — worth it for a key you hand out
once, not for a one-off payment from a stranger.

Short flag: `-s`. Which kind of key is in use is printed above it either way. `give --dht`
takes the same flag, for the key it presents to the receiver. On bluetooth and on the local
network it is redundant on both commands and says so: those keys are new every run already.
`--lan` and `--dht` together are refused rather than one quietly winning.

A token from somewhere else — a `give --print`, a QR, a message — is claimed on the spot,
and the command exits rather than listening:

```sh
cashme get --token cashuB...
cashme get < token.txt
pbpaste | cashme get
```

Short flags: `-t`, `-b`, `-l`, `-d`, `-s`. Stdin is read whenever it is not a terminal, or
on `--token -` — which includes a script or a service, where there is no terminal and
nobody typing either. `--bluetooth`, `--lan` or `--dht` says to listen regardless.

### pending

List the sends whose token is out in the world with no answer yet, and settle them:

```sh
cashme pending
cashme pending --reclaim
```

Short flag: `-r`. Bluetooth sends settle themselves on the receiver's acknowledgement; a
token you handed over yourself has none, so its amount sits outside the balance until this
asks the mint what became of it. Proofs the mint reports spent are the receiver's, and the send
is finalized. `--reclaim` swaps the rest back into the balance — worth doing only once you
know the token never arrived, since the receiver could still claim it up to that moment.
A nutzap is locked to its recipient's key and can never be reclaimed, only waited on.

### nutzap

Send ecash to a nostr user (NIP-61):

```sh
cashme nutzap --pubkey npub1... --sats 21
cashme nutzap --pubkey alice@example.com --sats 21
cashme nutzap -p npub1... -s 21 -c "thanks!" -m https://mint.example.com -y
```

Short flags: `-p`, `-s`, `-m`, `-r`, `-c`, `-e`, `-y`.

A nutzap is not a lightning zap. A NIP-57 zap is a lightning payment with a nostr receipt —
that is `cashme zap`, below. A nutzap moves the ecash
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
   recipient does not need to know who we are. `--comment` becomes the event's content,
   and `--event` tags the note being zapped, so clients can show it under that note rather
   than only in the recipient's inbox.

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

### zap

Pay a nostr user over lightning, with a receipt they can show (NIP-57):

```sh
cashme zap --pubkey npub1... --sats 21
cashme zap --pubkey alice@example.com --sats 21
cashme zap -p npub1... -s 21 -c "thanks!" -e <event-id> -y
```

Short flags: `-p`, `-s`, `-m`, `-r`, `-c`, `-e`, `-y`.

The counterpart to `nutzap`, and the opposite trade. A nutzap hands over the ecash itself
and touches no lightning; a zap melts ecash at a mint, which routes real sats to their
node, and their lnurl host publishes a kind `9735` receipt that clients show under the
note. So a zap is visible where a nutzap is not — and the mint learns who was paid.

What happens on a run:

1. Resolve `--pubkey`. An npub or hex key is read as-is; a `name@domain` address is looked
   up over NIP-05 first, since that is the form that can carry a receipt.
2. Read their kind `0` profile off the relays for a lightning address (`lud16`) or an
   lnurl (`lud06`).
3. Fetch that endpoint's terms, and check `--sats` against the limits it advertises.
4. Sign a kind `9734` zap request and hand it to the host, which returns an invoice.
5. Pay that invoice exactly as `withdraw` does — same quote, same confirmation, same
   change and fee reporting. `--mint` picks which mint melts it, `--yes` skips the prompt.

`--relay` adds relays to the profile lookup, repeatable. `--comment` rides along to the
lnurl host and into the zap request, and `--event` tags the note being zapped, which is
what puts the receipt under that note in a client rather than only on the recipient.

The invoice the host returns is checked against the amount we asked for before anything is
spent. Nothing about lnurl is signed, so a host that returns an invoice for some other
amount is refused rather than paid.

**Zaps from this wallet are anonymous.** The zap request is signed with a key generated
for that one zap and thrown away, exactly as a nutzap is, because the wallet holds no nostr
identity. The sats arrive and the receipt is published, but it credits an npub nobody
recognises — it will not appear on your profile.

Two cases fall back to an ordinary lightning payment, with no receipt and nothing on nostr.
Both say so, and the second asks first:

- A `name@domain` that has no NIP-05 record. It is still a valid lightning address, so it
  is paid as one.
- A host that does not take zap requests (no `allowsNostr`). The payment still reaches
  them, so `cashme` explains what is lost and asks before going ahead.

### restore

Rebuild proofs a mint issued but this wallet never recorded — a wallet that fell behind the
mint, through a crash mid-write or a file copied back from an older backup:

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

The whole file is rewritten after every change, which a wallet this size can afford. Each
write goes to `wallet.json.tmp`, is flushed to the disk, and is then renamed over the real
file — so a crash leaves either the old wallet or the new one, never half of one, and never
a rename pointing at bytes that never landed. A stray `wallet.json.tmp` is the remains of a
crash and is ignored. The directory is created `0700`.

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
and is off unless `BARE_DEBUG` names a section. It writes to stderr, which is where
everything a run says about itself goes — stdout carries only what a command produces, so
`deposit` and `give --print` can be piped straight into something else.

Sections are `cashme:app` (startup, storage), `cashme:ble` (bluetooth swarm, connections,
token transfer), `cashme:lan` (multicast beacons, the TCP link, and the same transfer) and
`cashme:dht` (hyperdht connect, teardown, and the same transfer):

```sh
BARE_DEBUG=cashme:* cashme get
BARE_DEBUG=cashme:ble cashme give -k <pubkey> -a 10
BARE_DEBUG=cashme:lan cashme give --lan -k <pubkey> -a 10
BARE_DEBUG=cashme:dht cashme give --dht -k <pubkey> -a 10
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
- `npm test` - run the unit suite (fast, no network)
- `npm run test:integration` - run the integration suite: the wallet against a real mint,
  and the nostr code against a relay the tests control. Needs the network.
  `CASHME_TEST_OFFLINE=1` skips the parts that spend, leaving the local ones;
  `CASHME_TEST_MINT=<url>` points them at another mint.
- `npm run test:all` - both suites
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
  lifetime and Ctrl-C handling (`session.mjs`), the hyperdht key a run presents
  (`address.mjs`), which wire a run uses (`transport.mjs`) and the printing (`ui.mjs`)
- `lib/manager.mjs` - opens the coco wallet and drives the deposit/send/receive/restore flows
- `lib/coco-store.mjs` - coco `Repositories` adapter for Bare: persistence, rollback, locking
- `lib/token-wire.mjs` - the frames a token travels in, shared by all three transports
- `lib/ble.mjs` - bluetooth transport for handing a token to a neighbour
- `lib/lan.mjs` - local-network transport: multicast discovery, then a TCP link
- `lib/dht.mjs` - hyperdht transport for handing a token to a peer anywhere
- `lib/clipboard.mjs` - the platform's clipboard program, for `give --copy`
- `lib/notes.mjs` - the one stderr write path, and the flush a run exits through
- `lib/nostr.mjs` - the keys, signed events and relay pool `nutzap` and `zap` need
- `lib/websocket.mjs` - the browser-shaped WebSocket nostr-tools drives, over bare-ws
- `lib/lnurl.mjs` - lnurl-pay: lightning address to endpoint to invoice, for `zap`
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
- `test/lnurl.test.mjs` - lnurl address/bech32 handling and the bolt11 amount check
- `test/integration/index.js` - integration entrypoint, requiring the suites below
- `test/integration/helpers.mjs` - throwaway wallets, running the real CLI, and a stub relay
- `test/integration/relay.test.mjs` - what the wallet does with a relay that lies
- `test/integration/lnurl.test.mjs` - what it does with an lnurl host that answers badly
- `test/integration/mint.test.mjs` - mint, send, claim and reclaim against a real mint
- `test/integration/nutzap.test.mjs` - a whole nutzap, checked where it lands
