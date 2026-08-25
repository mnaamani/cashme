import { openSync, closeSync } from 'bare-fs'
import { tryLock, waitForLock, unlock } from 'fs-native-extensions'

// One instance of cashme at a time per storage directory.
//
// The wallet is held in memory and written back whole (see coco-store.mjs), so two
// instances racing each other lose whichever set of proofs was written first — which for
// ecash means losing money, not merely losing an edit. An exclusive lock held for the
// lifetime of the command (bluetooth waits included) turns that race into an error
// message.
//
// The lock is advisory (see fs-native-extensions): it stops another cashme, not another
// program, and not `rm`.

export class StoreLock {
  constructor(file) {
    this.file = file
    this.fd = null
  }

  // `wait: true` blocks until the other instance exits, rather than failing immediately.
  acquire({ wait = false } = {}) {
    if (this.fd !== null) return this

    // 'a' rather than 'w': creating the lock file must never truncate anything, and we
    // never write to it — the lock lives on the fd, not in the contents.
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

  // Closing the fd releases the lock; do both so a long lived process can let go early.
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
