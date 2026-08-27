// The CLI grammar: what commands exist and what flags they take. No behaviour — each
// command lives in the module of the same name in this directory.
import { command, flag, summary, description } from 'paparam'
import pkg from '../../package.json'
import { DEFAULT_MINT_URL } from '../constants.mjs'
import { appName } from './env.mjs'

// todo: some additional commands: issue-token, import-token
// (same functionality as give/get but instead of sending over bluetooth, dump it to stdout
// or read it from stdin..

export const deposit = command(
  'deposit',
  description('Deposit new ecash into our wallet, with a lightning invoice payment (BOLT11 mint)'),
  flag('--sats|-s <amount>', 'number of sats to deposit'),
  flag('--mint|-m <url>', `mint to deposit at (default ${DEFAULT_MINT_URL})`)
)

export const give = command(
  'give',
  description('Send ecash to a neighbour over bluetooth'),
  flag('--public-key|-k <pubkey>', 'full or partial public key of neighbour'),
  flag('--sats|-s <amount>', 'number of sats the receiver gets (mint fees are paid on top)'),
  flag('--mint|-m <url>', 'mint to spend the ecash from (defaults to the one holding enough)')
)

export const get = command('get', description('Receive ecash from a neighbour over bluetooth'))

export const pay = command(
  'pay',
  description('Pay a lightning invoice with our ecash (BOLT11 melt)'),
  flag('--invoice|-i <bolt11>', 'the lightning invoice to pay'),
  flag('--mint|-m <url>', 'mint to melt the ecash at (defaults to one holding enough)'),
  flag('--yes|-y', 'skip the confirmation prompt')
)

export const balance = command('balance', description('Display our ecash balance'))

export const restore = command(
  'restore',
  description('Recover proofs the mint issued but this wallet never recorded (NUT-13)'),
  flag('--mint|-m <url>', `mint to restore from (default ${DEFAULT_MINT_URL})`)
)

export const root = command(
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
