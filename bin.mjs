import { command, flag, summary } from 'paparam'
import { persistent } from 'bare-storage'
import os from 'bare-os'
import { isWindows } from 'which-runtime'
import path from 'bare-path'
import FileLog from 'bare-file-logger'
import Console from 'bare-console'
import pkg from './package.json'
import App from './app.js'

const appName = pkg.productName || pkg.name
const executable = path.basename(Bare.argv[0])
const isDev = path.basename(executable, path.extname(executable)) === 'bare'
const name = isWindows ? appName + '.exe' : appName

const cmd = command(
  appName,
  summary(pkg.description),
  flag('--version|-v', 'Print the current version'),
  flag('--storage <dir>', 'custom storage directory'),
  flag('--updater', 'run updater daemon').hide(),
  flag('--update-window <ms>', 'updater wait in milliseconds'),
  flag('--no-updates', 'disable OTA updates for this run')
)

cmd.parse(Bare.argv.slice(isDev ? 2 : 1))

if (cmd.flags.updater) {
  await update(cmd)
  Bare.exit()
}

updates(cmd)

if (cmd.flags.help) Bare.exit()
if (cmd.flags.version) {
  console.log(`${appName} v${pkg.version}`)
  Bare.exit()
}

console.log('\nCLI ready.\n')

function updates(cmd) {
  if (cmd.flags.updates === false) return

  try {
    App.spawnUpdater(storage(cmd), os.execPath(), isDev ? Bare.argv[1] : null, updateWindow(cmd))
  } catch (err) {
    console.error(err.message)
    Bare.exit(1)
  }
}

async function update(cmd) {
  const dir = storage(cmd)
  const app = new App({
    dir,
    app: isDev ? null : os.execPath(),
    updates: true,
    version: pkg.version,
    upgrade: pkg.upgrade,
    name
  })
  const output = new FileLog(path.join(dir, 'updates.log'), { maxSize: 1024 * 1024 })
  const log = new Console(output)

  app.on('updating', () => log.log('[updater] downloading update'))
  app.on('updating-delta', (delta) => log.log('[updater]', delta))
  app.on('update-applied', () => log.log('[updater] update applied'))
  app.on('error', (err) => log.error(err))

  let code = 0
  try {
    await app.updater(updateWindow(cmd))
  } catch (err) {
    log.error(err)
    code = 1
  }
  try {
    await app.exit(code)
  } finally {
    output.close()
  }
}

function storage(cmd) {
  if (cmd.flags.storage) return cmd.flags.storage
  if (isDev) return path.join(os.tmpdir(), 'pear', appName)
  return path.join(persistent(), appName)
}

function updateWindow(cmd) {
  if (cmd.flags.updateWindow === undefined) return undefined

  const wait = Number(cmd.flags.updateWindow)
  if (Number.isSafeInteger(wait) === false || wait < 0) {
    throw new Error('--update-window must be a non-negative integer')
  }
  return wait
}
