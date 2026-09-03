# zap

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

`--relay` adds relays to the profile lookup for this run, repeatable, on top of the list in
[`cashme relays`](relays.md). `--comment` rides along to the lnurl host and into the zap
request, and `--event` tags the note being zapped, which is what puts the receipt under that
note in a client rather than only on the recipient.

A note is named as a `note1…`, an `nevent1…`, or the bare 64-character hex id — the three
forms NIP-19 writes an event id, none of them typeable. An `nevent1…` is worth preferring:
it carries the relays the note was seen on, which are added to the lookup, and sometimes the
author, which is checked before any relay is asked anything.

**The note is checked to be theirs before an invoice is asked for.** It is read back from
the relays, verified against its own id and signature, and its author compared with the
person being paid; a note nobody has, or one written by somebody else, stops the run rather
than being paid for. The `e` tag is what attributes the zap, nothing downstream checks it,
and a lightning payment cannot be recalled and re-tagged. Naming a note when there is no
nostr key behind the recipient — a plain lightning address — stops the run too, rather than
paying and silently dropping the attribution.

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
