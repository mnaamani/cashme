// OTA updates. Two halves of the same thing: `spawnUpdater` is what a normal run does —
// fire off a detached daemon and get on with the command — and `runUpdater` is what that
// daemon then runs, logging to a file because nobody is watching its stdout.
import process from 'bare-process'
import os from 'bare-os'
import path from 'bare-path'
import { isWindows } from 'which-runtime'
import FileLog from 'bare-file-logger'
import Console from 'bare-console'
import pkg from '../package.json'
import App from '../app.js'
import { appName, isDev } from './cli/env.mjs'

export function spawnUpdater(dir, wait) {
  App.spawnUpdater(dir, os.execPath(), isDev ? Bare.argv[1] : null, wait)
}

export async function runUpdater(dir, wait) {
  const app = new App({
    dir,
    app: isDev ? null : os.execPath(),
    updates: true,
    version: pkg.version,
    upgrade: pkg.upgrade,
    name: isWindows ? appName + '.exe' : appName
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

// paparam hands flags over as strings; a bad --update-window should stop the run rather
// than reach the updater as NaN.
export function updateWindow(value) {
  if (value === undefined) return undefined

  const wait = Number(value)
  if (Number.isSafeInteger(wait) === false || wait < 0) {
    throw new Error('--update-window must be a non-negative integer')
  }
  return wait
}
