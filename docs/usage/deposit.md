# deposit

Mint new ecash by paying a lightning invoice. `cashme` prints the invoice — to stdout, on
its own line — and waits for the mint to see it paid:

```sh
cashme deposit --amount 100 --mint https://mint.example.com
cashme deposit --amount 100 --unit sat --mint https://mint.example.com
```

Short flags: `-a`, `-m`, `-u`.

`--amount` is counted in `--unit`, which defaults to `sat`. A mint may issue more than one
unit, and each is a separate balance: two units held at the same mint are two holdings
that never add up or convert. Which units a mint offers is its own business — ask for one
it does not issue and the mint refuses.

`deposit`, `withdraw` and `give` take `--amount` with a `--unit`, because each of them
moves whichever unit the mint issued. `nutzap` and `zap` take `--sats` instead: nothing
about them is denominated any other way — a nutzap is priced in sats and an lnurl amount is
millisats.

Stopping the wait does not lose the deposit: if the invoice was paid, the next `cashme` to
open the wallet redeems it and says so, before it prints anything else.

## Naming the mint

`--mint` is required and this wallet has no default. Which mint to deposit at is the
decision to trust it — to hold a claim against whoever runs it, and to let a later send be
funded from it — and that is not a decision a wallet should make quietly on the one run that
puts money in. See [mints](mints.md).

Run it without `--mint` and the error lists the mints this wallet already trusts, since one
of them is usually the answer:

```
--mint is required — this wallet trusts https://mint.example.com
```
