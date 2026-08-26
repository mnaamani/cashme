import './lib/polyfills.mjs'
import { command, flag, summary, description } from 'paparam'
import { persistent } from 'bare-storage'
import process from 'bare-process'
import debuglog from 'bare-debug-log'
import os from 'bare-os'
import { isWindows } from 'which-runtime'
import path from 'bare-path'
import FileLog from 'bare-file-logger'
import Console from 'bare-console'
import pkg from './package.json'
import App from './app.js'
import { findNeighbour, receiveToken } from './lib/ble.mjs'
import { DEFAULT_MINT_URL } from './lib/constants.mjs'
import {
  openWallet,
  useMint,
  mintTokens,
  processToken,
  inspectToken,
  prepareSend,
  executeSend,
  cancelSend,
  quoteMelt,
  inputFeePpk,
  meltFeasibility,
  prepareMelt,
  cancelMelt,
  payInvoice,
  finalizeSend,
  reclaimSend,
  restoreProofs,
  balances,
  totalBalance,
  mintWithBalance,
  richestMint
} from './lib/manager.mjs'

const debug = debuglog('cashme:app')

const appName = pkg.productName || pkg.name
const isDev = path.basename(Bare.argv[0], path.extname(Bare.argv[0])) === 'bare'

// todo: some additional commands: issue-token, import-token
// (same functionality as give/get but instead of sending over bluetooth, dump it to stdout
// or read it from stdin..

const deposit = command(
  'deposit',
  description('Deposit new ecash into our wallet, with a lightning invoice payment (BOLT11 mint)'),
  flag('--sats|-s <amount>', 'number of sats to deposit'),
  flag('--mint|-m <url>', `mint to deposit at (default ${DEFAULT_MINT_URL})`)
)
const give = command(
  'give',
  description('Send ecash to a neighbour over bluetooth'),
  flag('--public-key|-k <pubkey>', 'full or partial public key of neighbour'),
  flag('--sats|-s <amount>', 'number of sats the receiver gets (mint fees are paid on top)'),
  flag('--mint|-m <url>', 'mint to spend the ecash from (defaults to the one holding enough)')
)
const get = command('get', description('Receive ecash from a neighbour over bluetooth'))
const pay = command(
  'pay',
  description('Pay a lightning invoice with our ecash (BOLT11 melt)'),
  flag('--invoice|-i <bolt11>', 'the lightning invoice to pay'),
  flag('--mint|-m <url>', 'mint to melt the ecash at (defaults to one holding enough)'),
  flag('--yes|-y', 'skip the confirmation prompt')
)
const balance = command('balance', description('Display our ecash balance'))
const restore = command(
  'restore',
  description('Recover proofs the mint issued but this wallet never recorded (NUT-13)'),
  flag('--mint|-m <url>', `mint to restore from (default ${DEFAULT_MINT_URL})`)
)
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
  pay,
  restore
)

cmd.parse(Bare.argv.slice(isDev ? 2 : 1))
// paparam prints the help itself, for a subcommand as well as for the root, but it does
// not stop us running the command afterwards — `cashme get --help` would print its help
// and then sit waiting on bluetooth.
if (cmd.flags.help || cmd.current?.flags?.help) Bare.exit()
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

debug('updates:', updates === false ? 'disabled' : 'enabled')
debug('storage path:', dir)

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

// Every command opens the wallet through here, so only one cashme can hold it at a time
// (see lib/coco-store.mjs) and it is always closed at the end of the run.
let opened = null
async function useWallet(dir) {
  opened = await openWallet(dir)
  // openWallet gives back the proofs held by sends that were prepared and never sent (see
  // sweepPreparedSends). That changes the balance the user is about to see, so say so.
  for (const send of opened.reclaimed) {
    console.error(`reclaimed ${send.amount} ${send.unit} reserved by a send that never went out`)
  }
  return opened
}

// A promise that settles when the user interrupts the run, and a way to stop listening.
//
// `give` reserves proofs before it goes looking for a neighbour over bluetooth, and that
// wait has no timeout — Ctrl-C is the normal way out of it. Until the token exists the
// reservation can still be handed back, so the window is worth catching; after that there
// is nothing to cancel, and `release()` puts the default behaviour back so a second Ctrl-C
// does what Ctrl-C usually does.
//
// SIGINT is the one bare lets us finish: for the others it runs the handler but still
// takes the default action, so the cancel is a race the run can lose. That is what the
// sweep in openWallet is for — this is the tidy exit, not the guarantee.
function interrupted() {
  const signals = ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM']
  const listeners = []
  const promise = new Promise((resolve) => {
    for (const signal of signals) {
      // Resolve rather than reject: nothing may ever await this, and an unhandled
      // rejection would take the run down instead of the signal.
      const listener = () => resolve(new Error(`interrupted (${signal})`))
      process.on(signal, listener)
      listeners.push([signal, listener])
    }
  })
  const release = () => {
    for (const [signal, listener] of listeners) process.off(signal, listener)
  }
  return { promise, release }
}

// A mint at a time, then the total. Amounts stringify to plain numbers, so they print as
// they come.
async function showBalances(wallet, label = 'Balance') {
  const entries = Object.entries(await balances(wallet))
  for (const [mintUrl, balance] of entries) {
    const reserved = Number(balance.reserved) ? ` (${balance.reserved} reserved)` : ''
    console.log(`${mintUrl}: ${balance.spendable} ${balance.unit}${reserved}`)
  }
  const total = await totalBalance(wallet)
  console.log(`${label}: ${total.spendable} ${total.unit}`)
  return entries
}

// Spending is the one thing worth stopping to ask about, so `pay` confirms before it
// commits. Reads a line from stdin, which means `echo y | cashme pay ...` works as well as
// a terminal; with nothing to read, the answer is no.
function confirm(question) {
  const stdin = process.stdin
  return new Promise((resolve) => {
    const answer = (value) => {
      stdin.off('data', ondata)
      stdin.off('end', onend)
      stdin.pause()
      resolve(value)
    }
    const ondata = (chunk) => {
      const line = chunk.toString().trim().toLowerCase()
      if (line === '') return
      answer(line === 'y' || line === 'yes')
    }
    const onend = () => answer(false)

    process.stdout.write(`${question} [y/N] `)
    stdin.on('data', ondata)
    stdin.on('end', onend)
    stdin.resume()
  })
}

// paparam hands flags over as strings; a bad one should stop the command, not reach a mint
// as NaN.
function sats(value) {
  const amount = Number(value)
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`--sats must be a positive whole number of sats, got "${value}"`)
  }
  return amount
}

async function handleCommands(cmd) {
  if (!cmd.current) {
    console.log(cmd.help())
    return
  }

  if (cmd.current.name === balance.name) {
    const wallet = await useWallet(dir)
    const entries = await showBalances(wallet)
    const reserved = entries.filter(([, balance]) => Number(balance.reserved) > 0)
    if (reserved.length) {
      console.log('Reserved proofs are in flight — sent, but not yet confirmed as claimed.')
      console.log('Every cashme run sweeps them: claimed ones are settled, the rest reclaimed.')
    }
  }

  if (cmd.current.name === give.name) {
    const pubKey = give.flags.publicKey
    if (!pubKey) {
      console.log(give.help())
      return
    }

    const amount = sats(give.flags.sats)
    const wallet = await useWallet(dir)
    await showBalances(wallet, 'Current Balance')

    // A token can only be spent at the mint that issued its proofs, so this picks one
    // mint rather than pooling. The mint's fee is charged on top of `amount`, and is only
    // known once the send is prepared, so a mint holding exactly `amount` can still be
    // rejected below — with the mint's own message, which says more than a guess would.
    const mintUrl = give.flags.mint
      ? await useMint(wallet, give.flags.mint)
      : await mintWithBalance(wallet, amount)

    if (!mintUrl) {
      console.log('Insufficient balance at any single mint')
      return
    }
    console.log(`Spending from ${mintUrl}`)

    // Prepare before touching bluetooth: this is where a spend that cannot happen — too
    // little at this mint once the fee is counted — fails, and failing now beats failing
    // after the user has waited for a neighbour to show up.
    const prepared = await prepareSend(wallet, mintUrl, amount)
    const fee = prepared.fee
    console.log(`sending ${amount} sat${Number(fee) ? ` (+ ${fee} sat mint fee)` : ''}`)

    // The bluetooth wait is where a `give` sits with proofs reserved and no token yet, so
    // it is the one place the run has to be able to give up cleanly.
    const interrupt = interrupted()

    let deliver
    try {
      deliver = await findNeighbour(pubKey, { cancelled: interrupt.promise })
    } catch (err) {
      // No neighbour, or the user gave up: hand the reserved proofs back before leaving,
      // or they stay locked out of the balance until something else releases them.
      await cancelSend(wallet, prepared)
      throw err
    } finally {
      interrupt.release()
    }

    // From here the proofs are in flight: the token exists, so the operation has to be
    // settled rather than cancelled.
    const { operation, token } = await executeSend(wallet, prepared)
    await showBalances(wallet, 'Remaining Balance')

    // we can only use deliver once, so send everything in one shot
    const received = await deliver(token)
    if (received) {
      await finalizeSend(wallet, operation)
      return
    }

    // No ACK: the receiver may or may not have claimed the token. Try to swap the proofs
    // back right away; if the mint has already burnt them the receiver got them.
    console.error('no confirmation from receiver, trying to reclaim the proofs...')
    try {
      await reclaimSend(wallet, operation)
      await showBalances(wallet, 'Reclaimed. Balance')
    } catch (err) {
      console.error('could not reclaim:', err.message)
      console.error(
        'the send is still tracked — retry later, the proofs are spent only if the receiver claimed them'
      )
    }
  }

  if (cmd.current.name === get.name) {
    // connect to ble-swarm
    // wait for someone to connect to us and give us a token
    // swap it and add to our wallet, under the mint that issued it
    const tokenString = await receiveToken()
    const wallet = await useWallet(dir)
    // TODO: a token names its own mint, which is untrusted input. Confirm with the user
    // (or check a trusted-mint list) before trusting that mint and swapping against it.
    const token = inspectToken(tokenString)
    console.error(`receiving ${token.amount} ${token.unit} from ${token.mintUrl}`)
    await processToken(wallet, tokenString)
    await showBalances(wallet, 'New Balance')
  }

  if (cmd.current.name === deposit.name) {
    if (!deposit.flags.sats) {
      console.log(deposit.help())
      return
    }
    const amount = sats(deposit.flags.sats)
    const wallet = await useWallet(dir)
    const mintUrl = await useMint(wallet, deposit.flags.mint || DEFAULT_MINT_URL)
    console.error(`minting ${amount} sat at ${mintUrl}`)
    await mintTokens(wallet, mintUrl, amount)
    await showBalances(wallet, 'New Balance')
  }

  if (cmd.current.name === restore.name) {
    const wallet = await useWallet(dir)

    // Restore is a repair, not a backup: it asks one mint to re-sign every secret our seed
    // derives, which recovers proofs the mint issued but this wallet never recorded — a
    // deposit interrupted before it was written, say. It is per mint, because a seed says
    // nothing about which mints it was used at.
    const mintUrl = await useMint(wallet, restore.flags.mint || DEFAULT_MINT_URL)

    // coco's proof repository rejects a proof it already holds, and one such collision
    // fails the whole keyset — so restoring into a wallet that still has its proofs
    // recovers nothing and reports a keyset failure. Say that up front instead.
    const held = (await balances(wallet))[mintUrl]
    if (held && Number(held.total) > 0) {
      console.log(`This wallet already holds ${held.total} ${held.unit} at ${mintUrl}.`)
      console.log('Restore can only rebuild proofs this wallet has lost: coco refuses to')
      console.log('re-add ones it already has, and that fails the whole keyset.')
      console.log('Nothing was changed.')
      return
    }

    console.log(`Restoring from ${mintUrl} — this can take a while.`)
    await restoreProofs(wallet, mintUrl)
    await showBalances(wallet)
  }

  if (cmd.current.name === pay.name) {
    const invoice = pay.flags.invoice
    if (!invoice) {
      console.log(pay.help())
      return
    }

    const wallet = await useWallet(dir)

    // A melt happens at one mint, and the mint is what quotes the fee — so the mint has to
    // be chosen before the cost is known. Without --mint, take the one with the most in it
    // and let the quote below decide whether that is enough.
    const mintUrl = pay.flags.mint
      ? await useMint(wallet, pay.flags.mint)
      : await richestMint(wallet)
    if (!mintUrl) {
      console.log('This wallet holds no ecash to pay with.')
      return
    }

    // Quote first: it costs nothing and touches no proofs, and it is the mint — not the
    // invoice — that says what the payment will actually total.
    const quote = await quoteMelt(wallet, mintUrl, invoice)
    const total = Number(quote.amount) + Number(quote.fee_reserve)
    const held = (await balances(wallet))[mintUrl]
    const feePpk = await inputFeePpk(wallet, mintUrl, quote.unit)

    console.log(`Paying from ${mintUrl}`)
    console.log(`  invoice     ${quote.amount} ${quote.unit}`)
    console.log(`  fee reserve ${quote.fee_reserve} ${quote.unit}`)
    console.log(`  total       ${total} ${quote.unit} of ${held?.spendable ?? 0} available`)
    if (feePpk) console.log(`  mint fee    ${feePpk} ppk per proof spent`)
    console.log("The fee reserve is the mint's worst case; whatever is left comes back as change.")

    if (Number(held?.spendable ?? 0) < total) {
      console.log(`Not enough at ${mintUrl} to cover the invoice and its fee reserve.`)
      return
    }

    // Some melts cannot work at this mint whatever we hold, because coco does not budget
    // for the per-input fee when it swaps before melting. Stop here rather than reserving
    // proofs for a payment that is arithmetically certain to be refused.
    const feasible = meltFeasibility(total, feePpk)
    if (!feasible.possible) {
      console.log(`\nThis mint takes ${feasible.fee} ${quote.unit} per proof spent, and coco does`)
      console.log('not budget for that when it swaps before melting — so a payment totalling')
      console.log(
        `less than ${feasible.floor} ${quote.unit} here always comes up short by the fee.`
      )
      console.log('Nothing was spent. Use a mint with no input fee, or a larger invoice.')
      return
    }

    if (!pay.flags.yes && !(await confirm('Pay this invoice?'))) {
      console.log('Cancelled. Nothing was spent.')
      return
    }

    // Reserve the inputs, then pay. Between these two the proofs are ours again if
    // anything goes wrong; after it, only the mint can say how the payment ended.
    const prepared = await prepareMelt(wallet, quote)
    let result
    try {
      result = await payInvoice(wallet, prepared)
    } catch (err) {
      await cancelMelt(wallet, prepared, 'cashme pay failed').catch(() => {})
      throw err
    }

    console.log('Paid.')
    if (result.changeAmount !== undefined) {
      console.log(`Change returned: ${result.changeAmount} ${quote.unit}`)
    }
    if (result.effectiveFee !== undefined) {
      console.log(`Fee actually paid: ${result.effectiveFee} ${quote.unit}`)
    }
    await showBalances(wallet, 'New Balance')
  }
}

try {
  await handleCommands(cmd)
} catch (err) {
  // A locked wallet or an unreachable mint are things the user can act on. Print what
  // happened, not where in cashme it happened.
  console.error('[app:error]', err.message)
  if (process.env.CASHME_DEBUG || debug.enabled) console.error(err.stack)
  Bare.exitCode = 1
} finally {
  try {
    await opened?.close()
  } catch (err) {
    // Never let a failure to close bury the error that actually stopped the command.
    console.error('[app:error] could not close the wallet cleanly:', err.message)
    Bare.exitCode = 1
  }
}
