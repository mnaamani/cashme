# relays

```sh
cashme relays
cashme relays --add wss://relay.example
cashme relays --remove wss://relay.example
cashme relays --reset
```

The nostr relays this wallet asks, on stdout one per line; anything explaining them goes to
stderr.

Only `zap` and `nutzap` touch nostr, and both start by asking relays a question: where a
user receives lightning (kind `0`), how they want to be nutzapped (kind `10019`), and — for
a nutzap — where to publish the event carrying the ecash. This is the list that gets asked.

```
wss://relay.damus.io
wss://nos.lol
wss://relay.primal.net
wss://relay.nostr.band
```

## Where the list comes from

Until something is changed here it is the list built into this binary. The first `--add` or
`--remove` starts from those and writes the result to `relays.json` in the storage
directory, so removing one relay leaves the rest standing rather than emptying the list.
`cashme relays` says which of the two it is showing.

`--reset` deletes that file, so the list goes back to whatever the binary ships — including
a later version's, rather than a copy of today's frozen in place.

## Adding and removing one

`--add` takes a relay url. `wss://` is filled in if the scheme is left off, `https://` is
read as `wss://`, and a trailing slash, a query or a fragment is dropped — so the same relay
typed two ways does not end up on the list twice. Adding one that is already there is not an
error.

Nothing is reached while adding. Unlike `mints --trust`, which asks the mint for its keysets
before writing it down, a relay is only contacted when a zap or a nutzap asks it something:
a relay that is down today answers tomorrow, and one that never answers costs a lookup
nothing but a wait.

`--remove` takes any spelling of a relay on the list. Removing the last one leaves nothing to
look anybody up on, and `zap` and `nutzap` then stop with that as the reason rather than
failing inside a query that answers nothing — `--reset` is the way back.

## What a relay is not

A relay holds no money. It is asked what a nostr user published about themselves, and a
nutzap is handed to it to store — so the list here is not a trust decision in the way
`mints` is, and nothing on this screen asks twice before changing it. What it does decide is
exposure: every relay on the list is told which keys this wallet is looking up, and a relay
that carries a nutzap sees the event it is in. Nothing an event carries is signed by this
wallet's own identity — it holds none — so what a relay learns is that somebody asked, from
whatever address the request came from. See
[Where the traffic goes](where-the-traffic-goes.md).

A relay could also answer a lookup with a forged event, which is why every event that comes
back is checked against its signature and the key it claims to be from before it is used.

## For one run only

`zap --relay` and `nutzap --relay` add a relay for that run, repeatable, on top of this list
— for one wanted once rather than kept. Relay hints from a NIP-05 address (where that user
is said to post) are added the same way, after this wallet's own list.

## In the UI

The `relays` screen is the same list: `A` adds one by url, `X` removes the selected relay,
`B` goes back to the built-in list after asking, and `R` reads the file again.
