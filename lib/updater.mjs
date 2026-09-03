// OTA updates, both halves: `spawnUpdater` is what a normal run does — fire off a detached
// daemon and get on with the command — and `runUpdater` is what that daemon then runs,
// logging to a file because nobody watches its stdout.
import process from 'bare-process'
import os from 'bare-os'
import path from 'bare-path'
import { isWindows } from 'which-runtime'
import FileLog from 'bare-file-logger'
import Console from 'bare-console'
import pkg from '../package.json'
import App from '../app.js'
import { appName, isDev } from './cli/env.mjs'
import { dhtOptions, interfaceInForce } from './net.mjs'

// The daemon is a process of its own and inherits none of this run's flags, so what it must
// honour is forwarded to it by name. --dht-interface is the whole of that list: the updater
// reaches the hyperdht and nothing else, and the hyperdht is the one thing that flag binds.
export function spawnUpdater(dir, wait) {
  App.spawnUpdater(dir, os.execPath(), isDev ? Bare.argv[1] : null, wait, interfaceInForce())
}

export async function runUpdater(dir, wait) {
  const app = new App({
    dir,
    app: isDev ? null : os.execPath(),
    updates: true,
    version: pkg.version,
    upgrade: pkg.upgrade,
    name: isWindows ? appName + '.exe' : appName,
    // Set when the run that spawned us was given --dht-interface and forwarded it, which
    // bin.mjs has already read into the policy by the time we are called.
    host: dhtOptions().host ?? null
  })
  const output = new FileLog(path.join(dir, 'updates.log'), { maxSize: 1024 * 1024 })
  const log = new Console(output)

  app.on('updating', () => log.log('[updater] getting new update'))
  app.on('updating-delta', (delta) => log.log('[updater]', delta))
  app.on('updated', () => log.log('[updater] update complete... applying'))
  app.on('update-applied', () => log.log('[updater] applied update, restart to run latest version'))
  app.on('error', (err) => log.error('[app:error]', err))

  process.on('SIGHUP', () => app.exit(129))
  process.on('SIGINT', () => app.exit(130))
  process.on('SIGQUIT', () => app.exit(131))
  process.on('SIGTERM', () => app.exit(143))

  let code = 0
  try {
    await app.updater(wait)
  } catch (err) {
    log.error('[app:error]', err)
    code = 1
  }
  code = Bare.exitCode || code
  try {
    await app.exit(code)
  } finally {
    output.close()
  }
}

// Whether the OTA updater runs, and what said so — the flag's source, or null when nothing
// disabled it. Two places can, and they cover different spans:
//
//   --no-updates         this run
//   CASHME_NO_UPDATES    every run of this wallet
//
// The second exists because a binary built from a checkout and installed over the released
// one (scripts/install-local.js) is not `isDev` — nothing about it says "do not update me" —
// so without a setting that outlives the run, the updater eventually replaces the local
// build with the release and the change under test quietly stops being the one running.
//
// The flag wins, since it was typed for this run. Both are one-way: neither turns updates
// back on, so a shell with the variable exported needs it unset rather than overridden.
export function updatesDisabled(flag) {
  if (flag === false) return '--no-updates'
  if (env('CASHME_NO_UPDATES')) return 'CASHME_NO_UPDATES'
  return null
}

// A variable set to nothing is not set — the same rule lib/net.mjs reads CASHME_PROXY by,
// and the one the proxy convention itself uses. Presence is what counts, so CASHME_NO_UPDATES=0
// disables updates as surely as =1 does; there is no value that means "on".
function env(name) {
  const value = process.env[name]
  return value && String(value).trim() ? value : undefined
}

// paparam hands flags over as strings; a bad --update-window must stop the run rather than
// reach the updater as NaN.
export function updateWindow(value) {
  if (value === undefined) return undefined

  const wait = Number(value)
  if (Number.isSafeInteger(wait) === false || wait < 0) {
    throw new Error('--update-window must be a non-negative integer')
  }
  return wait
}
