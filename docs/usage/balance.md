# balance

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
