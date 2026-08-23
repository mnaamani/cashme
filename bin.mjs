import './lib/polyfills.mjs'
import { command, flag, summary, description } from 'paparam'
import { persistent } from 'bare-storage'
import process from 'bare-process'
import os from 'bare-os'
import { isWindows } from 'which-runtime'
import path from 'bare-path'
import FileLog from 'bare-file-logger'
import Console from 'bare-console'
import pkg from './package.json'
import App from './app.js'
import { sendToken, receiveToken } from './lib/ble.mjs'
import { loadProofs } from './lib/proofs.mjs'
import { sumProofs } from '@cashu/cashu-ts'

const appName = pkg.productName || pkg.name
const isDev = path.basename(Bare.argv[0], path.extname(Bare.argv[0])) === 'bare'

const deposit = command(
  'deposit',
  description('Deposit new ecash into our wallet, with a lightning invoice payment (BOLT11 mint)')
)
const give = command(
  'give',
  description('Send ecash to a neighbour over bluetooth swarm'),
  flag('--public-key|-k <pubkey>', 'full or partial public key of neighbour')
)
const get = command('get', description('Receive ecash from a neighbour over bluetooth swarm'))
const withdraw = command(
  'withdraw',
  description('Withdraw ecash from our wallet with a lightning invoice payment (BOLT11 melt)')
)
const balance = command('balance', description('Display our ecash balance'))
const cmd = command(
  appName,
  summary(pkg.description),
  flag('--version|-v', 'Print the current version'),
  flag('--storage <dir>', 'custom storage directory'),
  flag('--no-updates', 'disable OTA updates for this run'),
  flag('--update-window <ms>', 'updater wait in milliseconds'),
  flag('--updater', 'run updater daemon').hide(),
  balance,
  deposit,
  give,
  get,
  withdraw
)

cmd.parse(Bare.argv.slice(isDev ? 2 : 1))
if (cmd.flags.help) Bare.exit()
if (cmd.flags.version) {
  console.log(`${appName} v${pkg.version}`)
  Bare.exit()
}

const updates = cmd.flags.updates
const storage = cmd.flags.storage || (isDev ? null : path.join(persistent(), appName))
const dir = storage || path.join(os.tmpdir(), 'pear', appName)
let wait
try {
  wait = updateWindow(cmd.flags.updateWindow)
} catch (err) {
  console.error('[app:error]', err.message)
  Bare.exit(1)
}

if (cmd.flags.updater) {
  await runUpdater(dir, wait)
  Bare.exit()
}

console.log(`Updates: ${updates === false ? 'disabled' : 'enabled'}`)

if (updates !== false) {
  try {
    App.spawnUpdater(dir, os.execPath(), isDev ? Bare.argv[1] : null, wait)
  } catch (err) {
    console.error('[app:error]', err)
    Bare.exit(1)
  }
}

async function runUpdater(dir, wait) {
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

function updateWindow(value) {
  if (value === undefined) return undefined

  const wait = Number(value)
  if (Number.isSafeInteger(wait) === false || wait < 0) {
    throw new Error('--update-window must be a non-negative integer')
  }
  return wait
}

async function handleCommands(cmd) {
  if (cmd.current.name === balance.name) {
    // parse proofs and add up the amounts, display total.
    const proofs = loadProofs(dir)
    console.log('Balance:', sumProofs(proofs).toNumber())
  }

  if (cmd.current.name === give.name) {
    // connect to ble-swarm
    // list available peers, pick one to send to

    // update proof store
    // show new balance
    const tokenString = ''
    await sendToken(give.flags.publicKey, tokenString)
  }

  if (cmd.current.name === get.name) {
    // connect to ble-swarm
    // wait for someone to connect to us and give us a token
    // swapt it and add to our proof store
    // show new balance
    // exit
    const tokenString = await receiveToken()
  }

  if (cmd.current.name === deposit.name) {
    //
    not_implemented(cmd)
  }

  if (cmd.current.name === withdraw.name) {
    not_implemented(cmd)
  }
}

function not_implemented(cmd) {
  throw new Error(`${cmd.current.name} NOT_IMPLEMENTED`)
}

await handleCommands(cmd)
