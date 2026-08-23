import { command, flag, summary } from 'paparam'
import { persistent } from 'bare-storage'
import process from 'bare-process'
import os from 'bare-os'
import { isWindows } from 'which-runtime'
import path from 'bare-path'
import FileLog from 'bare-file-logger'
import Console from 'bare-console'
import pkg from './package.json'
import App from './app.js'
import DHT from 'hyperdht'
import HttpBridgeClient from '@dhttp/client'
import 'bare-crypto/global'

// cashu-ts needs global fetch and TextEncoder APIs
import { TextEncoder } from 'text-encoding'
globalThis.TextEncoder = TextEncoder

import bareFetch from 'bare-fetch'
globalThis.fetch = bareFetch
// import wallet only after setting TextEncoder and fetch on globalThis
import { Wallet, MintQuoteState } from '@cashu/cashu-ts'

const appName = pkg.productName || pkg.name
const isDev = path.basename(Bare.argv[0], path.extname(Bare.argv[0])) === 'bare'

const cmd = command(
  appName,
  summary(pkg.description),
  flag('--version|-v', 'Print the current version'),
  flag('--storage <dir>', 'custom storage directory'),
  flag('--no-updates', 'disable OTA updates for this run'),
  flag('--update-window <ms>', 'updater wait in milliseconds'),
  flag('--updater', 'run updater daemon').hide()
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

const testnutBridgeKey = '72c402ee132faddfc8d24141daeed4c91fe5f7ce873d49095f6225330a7b8ba7'
const dht = new DHT()
const dhttpclient = new HttpBridgeClient(dht.connect(testnutBridgeKey))

const { upstream } = await dhttpclient.info()
console.log('Connected to mint bridge:', testnutBridgeKey)
console.log('Upstream:', upstream)

// now swapout global fetch for the client's fetch, not this means any other part of the app
// that uses global fetch will be talking to the mint!
globalThis.fetch = dhttpclient.fetch()

// The real mint url is the upstream the bridge connects to. Passing a different
// url to the Wallet constructor doesn't change the destination
// const mintUrl = 'https://testnut.cashu.space'
const wallet = new Wallet('https://nowhere.invalid', {
  // These custom transport options don't seem to be working..why?
  // requestFetch: dhttpclient.fetch(),
  // customRequest: dhttpclient.fetch(),
  // OpenId Authentication - needs to reach 'normal' internet, can't use the global fetch
  // we have overriden to call the mint.
  oidc: {
    fetch: bareFetch
  },
  unit: 'sat'
})
await wallet.loadMint() // wallet is now ready to use
const mintInfo = wallet.getMintInfo()
console.log('Wallet Ready.\n')
console.log(`${mintInfo.name} - ${mintInfo.description}`)

await mintTokens(10)

dhttpclient.destroy()
await dht.destroy()

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

async function mintTokens(amount) {
  console.log(`minting ${amount} tokens`)
  const mintQuote = await wallet.createMintQuoteBolt11(amount)
  console.log('invoice', mintQuote)
  // when using the testnut mint, the bolt11 invoice should be automatically paid on the mint side
  await sleepSeconds(5)
  const mintQuoteChecked = await wallet.checkMintQuoteBolt11(mintQuote.quote)
  console.log(`invoice state: ${mintQuoteChecked.state}`)
  if (mintQuoteChecked.state === MintQuoteState.PAID) {
    const proofs = await wallet.mintProofsBolt11(amount, mintQuote.quote)
    console.log(JSON.stringify(proofs)) // howto safely store the proofs?
  }
}

function sleepSeconds(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}
