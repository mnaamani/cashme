import { openSync, closeSync } from 'bare-fs'
import { tryLock, waitForLock, unlock } from 'fs-native-extensions'

// One instance of cashme at a time per storage directory.
//
// The wallet is held in memory and written back whole (see coco-store.mjs), so two racing
// instances lose whichever proofs were written first — for ecash, that is money, not an
// edit. An exclusive lock held for the whole command (bluetooth waits included) turns that
// race into an error message.
//
// Advisory only (see fs-native-extensions): it stops another cashme, not another program,
// and not `rm`.

export class StoreLock {
  constructor(file) {
    this.file = file
    this.fd = null
  }

  // `wait: true` blocks until the other instance exits, rather than failing immediately.
  acquire({ wait = false } = {}) {
    if (this.fd !== null) return this

    // 'a' rather than 'w': creating the lock file must never truncate. Nothing is ever
    // written — the lock lives on the fd, not in the contents.
    const fd = openSync(this.file, 'a', 0o600)
    try {
      if (wait) {
        waitForLock(fd)
      } else if (!tryLock(fd)) {
        throw new Error(
          `another cashme instance is using this wallet (${this.file}) — close it and try again`
        )
      }
    } catch (err) {
      closeSync(fd)
      throw err
    }
    this.fd = fd
    return this
  }

  // Closing the fd releases the lock; do both, so a long-lived process can let go early.
  release() {
    if (this.fd === null) return this
    try {
      unlock(this.fd)
    } finally {
      closeSync(this.fd)
      this.fd = null
    }
    return this
  }
}
