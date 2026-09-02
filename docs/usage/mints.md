# mints

```sh
cashme mints
cashme mints --trust https://mint.example
cashme mints --untrust https://mint.example [--yes]
```

Which mints this wallet trusts, on stdout; anything explaining the list goes to stderr.

A mint holds the bitcoin backing our ecash. Trusting one means holding a claim against
whoever runs it — they can refuse to pay it out — and it means a later send may be funded
from it. Everywhere else that decision is made as a side effect of something: `deposit
--mint` names a mint, and so trusts it; `get` asks about the mint a token arrived from,
because a token names its own issuer and anyone who can reach a listening wallet could
otherwise put their mint into it permanently just by paying you. Both are right in the
moment and neither leaves a way to read back the accumulated answer, or to take one back.

```
https://mint.example         trusted    8000 sat
https://quarantined.example  untrusted  137 sat
https://never-used.example   trusted    —
```

## Trusting one

`--trust` takes a url, and reaches the mint for its info and keysets as part of doing it —
so a url that is not a mint fails here rather than at the first send funded from it. It is
how a mint is added before it has ever been used, and how one that was untrusted is put
back.

## Untrusting one

`--untrust` does not remove the mint or the ecash at it. The proofs stay exactly where they
are and `balance` goes on counting them, because they are still yours. What stops is
spending: coco refuses to fund a send from an untrusted mint, so the amount is stranded
until the mint is trusted again.

That is what makes this the reversible move. A mint you have gone off can be quarantined
without losing what is there, and `--trust` puts it back with nothing lost in between.

Untrusting a mint that holds something asks first, since the money stops being spendable.
`--yes` skips the question, and is required where there is no terminal to ask on — a
script, or a piped run.

## Where else trust is decided

`deposit --mint` and `restore --mint` name a mint, which trusts it; both require the flag,
because that is a decision rather than a default. `get` asks about the mint a token arrived
from, since a token names its own issuer. This command is the list all of those add up to.

## In the UI

The `mints` screen is the same list: `T` on the selected mint trusts or untrusts it, `A`
adds one by url, and untrusting a mint that holds something asks the same question before
it does.

Everywhere the UI asks for a mint — deposit, give, withdraw, nutzap — the field completes
from the mints already trusted. It matches any part of the url rather than just the front,
since `https://` is the part of a mint url nobody remembers: typing `cashu` or `.space` is
enough. `Tab` or `→` takes what is offered, and nothing else does.
