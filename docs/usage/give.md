# give

Send ecash to a nearby device, addressed by the public key (or any prefix of it) that the
receiver's `cashme get` prints:

```sh
cashme give --public-key a1b2c3 --amount 21
cashme give --public-key a1b2c3 --amount 21 --mint https://mint.example.com
cashme give --public-key a1b2c3 --amount 21 --unit sat
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

## Over the local network

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

## Over the hyperdht

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
