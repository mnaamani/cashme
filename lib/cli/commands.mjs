// The CLI grammar: what commands exist and what flags they take. No behaviour — each
// command lives in the module of the same name in this directory.
import { command, flag, summary, description } from 'paparam'
import pkg from '../../package.json'
import { DEFAULT_MINT_URL, KNOWN_MINTS } from '../constants.mjs'
import { appName } from './env.mjs'

// todo: some additional commands: issue-token, import-token
// (same functionality as give/get but instead of sending over bluetooth, dump it to stdout
// or read it from stdin..

// paparam prints a description line by line, so the shortlist can be part of it. Column
// width comes from the longest url rather than a constant, or adding one wraps the list.
const mintColumn = Math.max(...KNOWN_MINTS.map(([url]) => url.length))
const mintShortlist = KNOWN_MINTS.map(([url, who]) => `  ${url.padEnd(mintColumn)}  ${who}`)

export const deposit = command(
  'deposit',
  // The root help lists a command by its summary, falling back to the description — so
  // without this the shortlist below is printed inside `cashme --help`'s command list.
  summary('Deposit new ecash into our wallet, with a lightning invoice payment (BOLT11 mint)'),
  // Its own help prints the summary above this, so this picks up where that leaves off.
  description(
    [
      'Mints to try — all custodial, the operator can take the funds, so keep balances',
      'small. Reviews at bitcoinmints.com, audits at audit.8333.space:',
      ...mintShortlist
    ].join('\n')
  ),
  flag('--amount|-a <amount>', 'how much to deposit, counted in --unit'),
  flag('--mint|-m <url>', `mint to deposit at (default ${DEFAULT_MINT_URL})`),
  flag('--unit|-u <unit>', 'unit the mint should issue (default sat)')
)

export const withdraw = command(
  'withdraw',
  description('Withdraw ecash back to lightning, by paying an invoice (BOLT11 melt)'),
  flag('--invoice|-i <bolt11>', 'the lightning invoice to pay'),
  flag('--mint|-m <url>', 'mint to melt the ecash at (defaults to one holding enough)'),
  flag('--unit|-u <unit>', 'unit to melt from (default sat)'),
  flag('--yes|-y', 'skip the confirmation prompt')
)

export const give = command(
  'give',
  description('Send ecash to a neighbour over bluetooth'),
  flag('--public-key|-k <pubkey>', 'full or partial public key of neighbour'),
  flag('--sats|-s <amount>', 'number of sats the receiver gets (mint fees are paid on top)'),
  flag('--mint|-m <url>', 'mint to spend the ecash from (defaults to the one holding enough)')
)

export const get = command('get', description('Receive ecash from a neighbour over bluetooth'))

export const nutzap = command(
  'nutzap',
  description('Send ecash to a nostr user, locked to their key (NIP-61 nutzap)'),
  flag('--pubkey|-p <npub>', "recipient's npub, hex public key, or name@domain address"),
  flag('--sats|-s <amount>', 'number of sats the recipient gets (mint fees are paid on top)'),
  flag('--mint|-m <url>', 'mint to spend from (defaults to one they trust and we can cover)'),
  flag('--relay|-r <url>', 'relay to use on top of the defaults, repeatable').multiple(),
  flag('--comment|-c <text>', 'comment to attach to the nutzap'),
  flag('--event|-e <id>', 'id of the nostr event being zapped'),
  flag('--yes|-y', 'skip the confirmation prompt')
)

export const zap = command(
  'zap',
  description('Pay a nostr user over lightning, with a receipt (NIP-57 zap)'),
  flag('--pubkey|-p <npub>', "recipient's npub, hex public key, or lightning address"),
  flag('--sats|-s <amount>', 'number of sats to send'),
  flag('--mint|-m <url>', 'mint to melt the ecash at (defaults to the one holding the most)'),
  flag('--relay|-r <url>', 'relay to use on top of the defaults, repeatable').multiple(),
  flag('--comment|-c <text>', 'comment to attach to the zap'),
  flag('--event|-e <id>', 'id of the nostr event being zapped'),
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
  withdraw,
  give,
  get,
  nutzap,
  zap,
  restore
)
