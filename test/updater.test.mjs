// What decides whether the OTA updater runs. There are two switches and they cover different
// spans — a flag for the run, a variable for the shell — and the reason the second exists is
// that a locally built binary installed over the released one is indistinguishable from a
// release to everything downstream of here. If this resolves wrong, the updater replaces the
// build under test and the symptom is a change that stops taking effect for no visible reason.
import '../lib/polyfills.mjs'
import test from 'brittle'
import process from 'bare-process'
import { updatesDisabled, updateWindow } from '../lib/updater.mjs'

// Restored by assignment rather than by `delete`, because bare-process wraps the environment
// in a proxy whose deleteProperty trap refuses — the same reason test/net.test.mjs clears its
// variables to ''. Which is sound here for the same reason it is there: empty is not set.
function withEnv(value, fn) {
  const before = process.env.CASHME_NO_UPDATES
  process.env.CASHME_NO_UPDATES = value
  try {
    return fn()
  } finally {
    process.env.CASHME_NO_UPDATES = before ?? ''
  }
}

test('updates run when nothing says otherwise', (t) => {
  withEnv('', () => {
    t.is(updatesDisabled(undefined), null)
    t.is(updatesDisabled(true), null)
  })
})

test('--no-updates stops this run', (t) => {
  withEnv('', () => {
    t.is(updatesDisabled(false), '--no-updates')
  })
})

test('CASHME_NO_UPDATES stops every run', (t) => {
  withEnv('1', () => {
    t.is(updatesDisabled(undefined), 'CASHME_NO_UPDATES')
  })
})

// Presence is the whole test, as it is for CASHME_PROXY — so there is no value that turns
// updates back on, and reaching for the obvious one does not quietly do the opposite.
test('CASHME_NO_UPDATES is read for presence, not truth', (t) => {
  for (const value of ['1', '0', 'false', 'no', 'yes']) {
    withEnv(value, () => {
      t.is(updatesDisabled(undefined), 'CASHME_NO_UPDATES', `${value} disables updates`)
    })
  }
})

// A variable set to nothing is not set. A shell that exports it empty has not asked for
// anything, and must not end up holding the wallet at the version it has.
test('an empty CASHME_NO_UPDATES is not set', (t) => {
  for (const value of ['', '   ']) {
    withEnv(value, () => {
      t.is(updatesDisabled(undefined), null, JSON.stringify(value) + ' leaves updates on')
    })
  }
})

// The flag was typed for this run; the variable was exported some time ago.
test('--no-updates outranks the environment', (t) => {
  withEnv('1', () => {
    t.is(updatesDisabled(false), '--no-updates')
  })
})

// Nothing turns updates back on. Worth pinning down, because the natural guess at the
// command line is that a flag exists to override the variable, and none does.
test('nothing re-enables updates once the environment disables them', (t) => {
  withEnv('1', () => {
    t.is(updatesDisabled(true), 'CASHME_NO_UPDATES')
  })
})

test('--update-window takes non-negative integers only', (t) => {
  t.is(updateWindow(undefined), undefined)
  t.is(updateWindow('60000'), 60000)
  t.is(updateWindow('0'), 0)
  t.exception(() => updateWindow('-1'))
  t.exception(() => updateWindow('later'))
  t.exception(() => updateWindow('1.5'))
})
