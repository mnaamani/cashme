# withdraw

Melt ecash back into lightning sats — the counter to `deposit`. Pays a bolt11 invoice
out of the wallet:

```sh
cashme withdraw --invoice lnbc...
cashme withdraw --invoice lnbc... --mint https://mint.example.com --yes
cashme withdraw --invoice lnbc... --unit sat
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
> balance unchanged. `testnut.cashu.space` charges `input_fee_ppk: 100`, for instance,
> putting its floor at 11 sat; a mint with no input fee has none.
