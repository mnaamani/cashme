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
