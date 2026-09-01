# restore

Rebuild proofs a mint issued but this wallet never recorded — a wallet that fell behind the
mint, through a crash mid-write or a file copied back from an older backup:

```sh
cashme restore
cashme restore --mint https://mint.example.com
```

Short flag: `-m`.

A repair, not a backup. It replays the deterministic secrets (NUT-13) derived from the seed
inside this wallet's own file, so it recovers nothing if that file is gone. One mint at a
time, because a seed does not record which mints it was used at. And only for proofs the
wallet has _lost_: coco refuses to re-add a proof it already holds, so restoring into an
intact wallet does nothing and says so.
