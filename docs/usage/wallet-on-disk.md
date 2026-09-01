# The wallet on disk

Everything lives in two files in the storage directory:

- `wallet.json` — proofs, mints, quotes, operations, history, the NUT-13 seed and its
  per-keyset counters. Plaintext, mode `0600`. **Not encrypted**: `cashme` is for small
  amounts, and the way out of a wallet is to spend it or melt it, not to unlock a backup
  somewhere else. Lose this file and the ecash in it is gone.
- `wallet.lock` — empty, and only there to be locked. One `cashme` may hold a wallet at a
  time; a second one is refused rather than allowed to overwrite the first one's proofs.

The whole file is rewritten after every change, which a wallet this size can afford. Each
write goes to `wallet.json.tmp`, is flushed to the disk, and is then renamed over the real
file — so a crash leaves either the old wallet or the new one, never half of one, and never
a rename pointing at bytes that never landed. A stray `wallet.json.tmp` is the remains of a
crash and is ignored. The directory is created `0700`.

The wallet itself is [coco](https://github.com/cashubtc/coco) (`@cashu/coco-core`), stored
through a Bare adapter in `lib/coco-store.mjs` — coco's published adapters are SQLite,
IndexedDB and expo-sqlite, none of which run under Bare.
