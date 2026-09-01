# get

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
