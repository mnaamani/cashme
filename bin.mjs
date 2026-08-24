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
import { findNeighbour, receiveToken } from './lib/ble.mjs'
import { loadProofs, saveProofs } from './lib/proofs.mjs'
import { sumProofs, Amount } from '@cashu/cashu-ts'
import { openWallet, mintTokens, processToken, generateTokenToSend } from './lib/wallet.mjs'

const appName = pkg.productName || pkg.name
const isDev = path.basename(Bare.argv[0], path.extname(Bare.argv[0])) === 'bare'

// todo: some additional commands: issue-token, import-token
// (same functionality as give/get but instead of sending over bluetooth, dump it to stdout
// or read it from stdin..

const deposit = command(
  'deposit',
  description('Deposit new ecash into our wallet, with a lightning invoice payment (BOLT11 mint)'),
  flag('--sats|-s <amount>', 'number of sats to deposit')
)
const give = command(
  'give',
  description('Send ecash to a neighbour over bluetooth'),
  flag('--public-key|-k <pubkey>', 'full or partial public key of neighbour'),
  flag('--sats|-s <amount>', 'number of sats to give (excluding mint fees)')
)
const get = command('get', description('Receive ecash from a neighbour over bluetooth'))
const pay = command('pay', description('Pay a lightning invoice with our ecash (BOLT11 melt)'))
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
  pay
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
console.log(`Storage path: ${dir}`)

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
  if (!cmd.current) {
    console.log(cmd.help())
    return
  }

  if (cmd.current.name === balance.name) {
    // parse proofs and add up the amounts, display total.
    const myProofs = loadProofs(dir)
    console.log('Balance:', sumProofs(myProofs).toNumber())
  }

  if (cmd.current.name === give.name) {
    const pubKey = give.flags.publicKey
    if (!pubKey) {
      console.log(give.help())
      return
    }

    const amount = Amount.from(give.flags.sats)
    const myProofs = loadProofs(dir)
    const currentBalance = sumProofs(myProofs).toNumber()
    console.log('Current Balance:', currentBalance)

    if (amount.greaterThan(currentBalance)) {
      console.log('Insufficient balance')
      return
    }
    const send = await findNeighbour(pubKey)
    const { wallet } = await openWallet()
    const { token, keep } = await generateTokenToSend(wallet, amount, myProofs)
    saveProofs(dir, keep)
    console.log('Remaining Balance:', sumProofs(keep).toNumber())
    // we can only use send once, so send everything in one shot
    const _received = await send(token)
    // if received == false, we can try to claim them again from the mint (now or later)
  }

  if (cmd.current.name === get.name) {
    // connect to ble-swarm
    // wait for someone to connect to us and give us a token
    // swapt it and add to our proof store
    const tokenString = await receiveToken()
    const myProofs = loadProofs(dir)
    const { wallet } = await openWallet()
    // confirm step first? maybe we don't want to use the mint specified in the token
    const receivedProofs = await processToken(wallet, tokenString)
    const finalProofs = myProofs.concat(receivedProofs)
    saveProofs(dir, finalProofs)
    console.log('New Balance:', sumProofs(finalProofs).toNumber())
  }

  if (cmd.current.name === deposit.name) {
    const sats = deposit.flags.sats
    if (!sats) {
      console.log(deposit.help())
      return
    }
    const amount = Amount.from(sats)
    const myProofs = loadProofs(dir)
    const { wallet } = await openWallet()
    const newProofs = await mintTokens(wallet, amount)
    const finalProofs = myProofs.concat(newProofs)
    saveProofs(dir, finalProofs)
    console.log('New Balance:', sumProofs(finalProofs).toNumber())
  }

  if (cmd.current.name === pay.name) {
    // make sure to add a confirm step
    not_implemented(cmd)
  }
}

function not_implemented(cmd) {
  throw new Error(`${cmd.current.name} NOT_IMPLEMENTED`)
}

await handleCommands(cmd)
