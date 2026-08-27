// Entry point: parse argv, decide where the wallet lives, dispatch.
//
// One module per command in lib/cli/, named after it (lib/cli/pay.mjs is `cashme pay`).
import './lib/polyfills.mjs'
import { persistent } from 'bare-storage'
import process from 'bare-process'
import debuglog from 'bare-debug-log'
import os from 'bare-os'
import path from 'bare-path'
import pkg from './package.json'
import { appName, isDev } from './lib/cli/env.mjs'
import { root, balance, deposit, give, get, pay, restore } from './lib/cli/commands.mjs'
import { closeWallet } from './lib/cli/session.mjs'
import { spawnUpdater, runUpdater, updateWindow } from './lib/updater.mjs'
import { run as runBalance } from './lib/cli/balance.mjs'
import { run as runDeposit } from './lib/cli/deposit.mjs'
import { run as runGive } from './lib/cli/give.mjs'
import { run as runGet } from './lib/cli/get.mjs'
import { run as runPay } from './lib/cli/pay.mjs'
import { run as runRestore } from './lib/cli/restore.mjs'

const debug = debuglog('cashme:app')

// paparam would run these itself, but a throwing handler goes through its bail(), which
// prints a stack trace. We want the message only, so dispatch by hand.
const handlers = new Map([
  [balance.name, runBalance],
  [deposit.name, runDeposit],
  [give.name, runGive],
  [get.name, runGet],
  [pay.name, runPay],
  [restore.name, runRestore]
])

root.parse(Bare.argv.slice(isDev ? 2 : 1))
// paparam prints help but does not stop us running the command — without this,
// `cashme get --help` would print its help and then sit waiting on bluetooth.
if (root.flags.help || root.current?.flags?.help) Bare.exit()
if (root.flags.version) {
  console.log(`${appName} v${pkg.version}`)
  Bare.exit()
}

const updates = root.flags.updates
const storage = root.flags.storage || (isDev ? null : path.join(persistent(), appName))
const dir = storage || path.join(os.tmpdir(), 'pear', appName)
let wait
try {
  wait = updateWindow(root.flags.updateWindow)
} catch (err) {
  console.error('[app:error]', err.message)
  Bare.exit(1)
}

if (root.flags.updater) {
  await runUpdater(dir, wait)
  Bare.exit()
}

debug('updates:', updates === false ? 'disabled' : 'enabled')
debug('storage path:', dir)

if (updates !== false) {
  try {
    spawnUpdater(dir, wait)
  } catch (err) {
    console.error('[app:error]', err)
    Bare.exit(1)
  }
}

try {
  const command = root.current
  if (!command) {
    console.log(root.help())
  } else {
    await handlers.get(command.name)({ dir, flags: command.flags, command })
  }
} catch (err) {
  // A locked wallet or an unreachable mint is something the user can act on: print what
  // happened, not where.
  console.error('[app:error]', err.message)
  if (process.env.CASHME_DEBUG || debug.enabled) console.error(err.stack)
  Bare.exitCode = 1
} finally {
  try {
    await closeWallet()
  } catch (err) {
    // Never let a failure to close bury the error that actually stopped the command.
    console.error('[app:error] could not close the wallet cleanly:', err.message)
    Bare.exitCode = 1
  }
}

// Everything is awaited and the wallet writes synchronously, so anything still holding the
// loop open is a handle nobody waits on — bluetooth's native managers, which ble-swarm
// cannot always free (see lib/ble.mjs) and which keep bare alive for good. The updater is
// detached and outlives us either way. So exit rather than hope the loop drains.
Bare.exit(Bare.exitCode || 0)
