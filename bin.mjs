// Entry point: parse the command line, decide where the wallet lives, and hand off.
//
// The commands themselves are in lib/cli/ — one module per command, named after it
// (lib/cli/pay.mjs is `cashme pay`). lib/cli/commands.mjs holds the flag grammar,
// lib/cli/session.mjs the wallet's lifetime and Ctrl-C handling, lib/cli/ui.mjs the
// printing, and lib/updater.mjs everything about OTA updates.
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

// paparam runs handlers itself, but a throwing one goes through its bail(), which prints a
// stack trace. We want the message and nothing else, so dispatch by hand instead.
const handlers = new Map([
  [balance.name, runBalance],
  [deposit.name, runDeposit],
  [give.name, runGive],
  [get.name, runGet],
  [pay.name, runPay],
  [restore.name, runRestore]
])

root.parse(Bare.argv.slice(isDev ? 2 : 1))
// paparam prints the help itself, for a subcommand as well as for the root, but it does
// not stop us running the command afterwards — `cashme get --help` would print its help
// and then sit waiting on bluetooth.
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
  // A locked wallet or an unreachable mint are things the user can act on. Print what
  // happened, not where in cashme it happened.
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

// A one-shot CLI is finished when its command is finished. Everything has been awaited and
// the wallet writes its state synchronously, so whatever still holds the loop open here is
// a handle nobody is waiting on — a `give` that delivered leaves bluetooth's native
// managers behind, and on their own they keep bare running for good. The updater is a
// detached daemon and outlives us either way. So say the run is over instead of hoping the
// loop drains on its own.
Bare.exit(Bare.exitCode || 0)
