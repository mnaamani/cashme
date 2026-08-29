// The CLI grammar: what commands exist and what flags they take. No behaviour — each
// command lives in the module of the same name in this directory.
import { command, flag, summary, description, bail } from 'paparam'
import pkg from '../../package.json'
import { DEFAULT_MINT_URL, KNOWN_MINTS } from '../constants.mjs'
import { appName } from './env.mjs'

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
  summary('Send ecash to a peer over bluetooth or the hyperdht, or hand the token over'),
  description(
    [
      'With --public-key the token goes straight to a neighbour over bluetooth. That key',
      'is the one their `cashme get` prints to address the radio link with — it locks',
      'nothing, and the token it carries is bearer ecash, spendable by whoever holds it.',
      '',
      'With --dht the same handover goes over the hyperdht instead, so the receiver can be',
      'anywhere rather than in the room. --public-key is then their full 64-character key',
      "from `cashme get --dht`, which is normally their wallet's address and stays the",
      'same — unless they ran it with --ephemeral, in which case ask for the current one.',
      '',
      "The link names us to them as well: they see this wallet's own hyperdht address, the",
      'same one `cashme get --dht` announces, so someone paid twice can tell it was us both',
      'times. --ephemeral sends under a one-run key instead, recognisable to nobody.',
      '',
      'With --print the token goes to stdout instead, for you to carry over any channel',
      'you trust — a private chat, or --qr for the receiver to scan with a mobile wallet.',
      '--copy puts it on the clipboard as well, ready to paste.',
      '',
      'A handed-over token gets no acknowledgement, so the amount is out of the balance',
      'while we ask the mint whether it was claimed. Stop waiting whenever you like and',
      '`cashme pending` picks the send up later.'
    ].join('\n')
  ),
  flag('--public-key|-k <pubkey>', "receiver's key: any prefix over bluetooth, in full over --dht"),
  flag('--dht|-d', 'reach the receiver over the hyperdht instead of bluetooth'),
  flag('--ephemeral|-e', "send under a one-run hyperdht key rather than this wallet's"),
  flag('--amount|-a <amount>', 'how much the receiver gets, counted in --unit'),
  flag('--unit|-u <unit>', 'unit to spend (default sat)'),
  flag('--mint|-m <url>', 'mint to spend the ecash from (defaults to the one holding enough)'),
  flag('--print|-p', 'print the token instead of sending it to a peer'),
  flag('--qr|-q', 'also show the token as a QR code to scan (implies --print)'),
  flag('--copy|-c', 'also put the token on the clipboard (implies --print)')
)

export const get = command(
  'get',
  summary('Receive ecash over bluetooth or the hyperdht, or from a token you paste in'),
  description(
    [
      'Without --token this listens until you stop it — on bluetooth, or with --dht on the',
      'hyperdht, where the sender can be anywhere. The bluetooth key is new every run; the',
      "hyperdht one is this wallet's address, the same every run, so a sender can keep it.",
      'That also makes it something anyone holding it can watch for — --ephemeral gives a',
      'run its own address instead. A token pasted or piped in is claimed on the spot:',
      '',
      '  cashme get --token cashuB...',
      '  cashme get < token.txt',
      '  pbpaste | cashme get',
      '',
      'Stdin is read whenever it is not a terminal, which is also true of a script or a',
      'service — pass --bluetooth or --dht there to listen regardless.'
    ].join('\n')
  ),
  flag('--token|-t <token>', 'ecash token to claim; - reads it from stdin'),
  flag('--bluetooth|-b', 'listen on bluetooth even when stdin is not a terminal'),
  flag('--dht|-d', 'listen on the hyperdht instead of bluetooth'),
  flag('--ephemeral|-e', "use a one-run hyperdht address rather than this wallet's")
)

export const pending = command(
  'pending',
  summary('List sends whose token was never acknowledged, and settle them'),
  description(
    [
      'A send handed over out of band stays outside the balance until we know what became',
      'of it. Each one here is checked with the mint: proofs the receiver has spent settle',
      'the send, and --reclaim swaps the rest back into the balance.'
    ].join('\n')
  ),
  flag('--reclaim|-r', 'take back the amount of any send still unclaimed')
)

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

// paparam reports a malformed command line by throwing a `Bail` out of parse() — with a
// reason like 'UNKNOWN_FLAG: nope' and a stack behind it — before any handler of ours runs.
// This turns each reason into the sentence a user can act on, and throws that instead;
// bin.mjs catches it and prints the message alone, as it does for every other error.
//
// Registered on the root only: paparam walks up to the nearest handler, so a bail inside
// `cashme give` lands here too, with `bailed.command` naming where it happened.
function explain({ reason, flag: named, arg, command: where }) {
  const name = named && `${named.long ? '--' : '-'}${named.name}`
  // `where` is the command the bail happened in, which is the root itself for a bail
  // before any command was named.
  const scope = where?.name && where.name !== appName ? `${appName} ${where.name}` : appName
  const help = `${scope} --help`

  switch (reason) {
    case 'UNKNOWN_FLAG':
      return `there is no ${name} flag here — \`${help}\` lists the ones there are`
    // The one reason covering both halves of a flag taking the wrong thing: a value given
    // to a flag that is on or off, and a value missing from one that names something.
    case 'INVALID_FLAG':
      return named?.value
        ? `${name} takes no value — see \`${help}\``
        : `${name} needs a value — see \`${help}\``
    case 'UNKNOWN_ARG':
      return `\`${appName}\` has no ${arg?.value ? `\`${arg.value}\` ` : ''}command — \`${help}\` lists them`
    case 'MISSING_ARG':
      return `missing ${arg?.value ?? 'argument'} — see \`${help}\``
    default:
      return `${reason.toLowerCase().replace(/_/g, ' ')} — see \`${help}\``
  }
}

export const root = command(
  appName,
  bail((problem) => {
    throw new Error(explain(problem))
  }),
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
  pending,
  nutzap,
  zap,
  restore
)
