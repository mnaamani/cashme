# nutzap

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
