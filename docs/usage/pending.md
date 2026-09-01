# pending

List the sends whose token is out in the world with no answer yet, and settle them:

```sh
cashme pending
cashme pending --reclaim
```

Short flag: `-r`. Bluetooth sends settle themselves on the receiver's acknowledgement; a
token you handed over yourself has none, so its amount sits outside the balance until this
asks the mint what became of it. Proofs the mint reports spent are the receiver's, and the send
is finalized. `--reclaim` swaps the rest back into the balance — worth doing only once you
know the token never arrived, since the receiver could still claim it up to that moment.
A nutzap is locked to its recipient's key and can never be reclaimed, only waited on.
