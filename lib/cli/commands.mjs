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
  summary('Send ecash to a peer over bluetooth, the local network or the hyperdht'),
  description(
    [
      'With --public-key the token goes straight to a neighbour over bluetooth. That key',
      'is the one their `cashme get` prints to address the radio link with — it locks',
      'nothing, and the token it carries is bearer ecash, spendable by whoever holds it.',
      '',
      'With --lan the same handover goes over the network you are both on instead — no',
      'radio range, no internet, nothing leaving the wi-fi. --public-key is again any',
      'prefix of the key their `cashme get --lan` prints, new on every run.',
      '',
      'With --dht the same handover goes over the hyperdht instead, so the receiver can be',
      'anywhere rather than in the room. --public-key is then their full 64-character key',
      'from `cashme get --dht`, which belongs to that run alone — so ask for the current',
      "one, unless they ran it with --stable and gave you their wallet's own address.",
      '',
      'The link names us to them as well: by default under a one-run key, recognisable to',
      "nobody. --stable sends under this wallet's own hyperdht address instead, the same one",
      '`cashme get --dht --stable` announces, so someone paid twice can tell it was us both',
      'times.',
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
  flag('--public-key|-k <pubkey>', "receiver's key: any prefix, in full over --dht"),
  flag('--lan|-l', 'reach the receiver over the local network instead of bluetooth'),
  flag('--dht|-d', 'reach the receiver over the hyperdht instead of bluetooth'),
  flag('--stable|-s', "send under this wallet's own address rather than a key for this run"),
  flag('--amount|-a <amount>', 'how much the receiver gets, counted in --unit'),
  flag('--unit|-u <unit>', 'unit to spend (default sat)'),
  flag('--mint|-m <url>', 'mint to spend the ecash from (defaults to the one holding enough)'),
  flag('--print|-p', 'print the token instead of sending it to a peer'),
  flag('--qr|-q', 'also show the token as a QR code to scan (implies --print)'),
  flag('--copy|-c', 'also put the token on the clipboard (implies --print)')
)

export const ui = command(
  'ui',
  summary('Open the whole wallet in one full-screen terminal UI (what bare `cashme` does)'),
  description(
    [
      'Balances, sends still in flight, and the deposit, give, receive and withdraw flows,',
      'on one screen that updates as they happen — rather than one command per step.',
      '',
      'This is what `cashme` on its own runs, so the name is only needed to be explicit.',
      'Without a terminal on both ends — piped, or from a script — bare `cashme` prints',
      'this help instead, since there would be nothing to paint on.',
      '',
      'It needs a terminal on both stdin and stdout: it paints over stdout, so there is no',
      'payload to pipe and it refuses to run without one. The commands stay the way to get',
      'a token or an invoice out of this wallet and into something else.',
      '',
      'It holds the wallet open for as long as it is up, and the wallet takes one lock — so',
      'no other cashme runs while this one does.'
    ].join('\n')
  )
)

export const get = command(
  'get',
  summary('Receive ecash over bluetooth, the local network or the hyperdht, or from a token'),
  description(
    [
      'Without --token this listens until you stop it — on bluetooth, with --lan on the',
      'network you are both on, or with --dht on the hyperdht, where the sender can be',
      'anywhere. All three keys are new every run, so the sender needs the current one.',
      "--stable listens on this wallet's own hyperdht address instead, the same every run so",
      'a sender can keep it — which also makes it something anyone holding it can watch for.',
      '',
      '--lan answers senders that ask for it and announces nothing otherwise, but anyone on',
      'the network can ask — so while it is listening, everyone on that wi-fi can see that a',
      'wallet here is waiting to be paid. A token pasted or piped in is claimed on the spot:',
      '',
      '  cashme get --token cashuB...',
      '  cashme get < token.txt',
      '  pbpaste | cashme get',
      '',
      'Stdin is read whenever it is not a terminal, which is also true of a script or a',
      'service — pass --bluetooth, --lan or --dht there to listen regardless.',
      '',
      'A token names the mint that issued it, and taking that ecash means trusting whoever',
      'runs it with the bitcoin behind it. So a mint this wallet has not used before is put',
      'to you before anything is received. With no terminal to ask — a piped token, or a',
      'service — such a token is refused instead, and --mint is how to accept one anyway.'
    ].join('\n')
  ),
  flag('--token|-t <token>', 'ecash token to claim; - reads it from stdin'),
  flag('--mint|-m <url>', 'accept tokens from this mint without asking, repeatable').multiple(),
  flag('--bluetooth|-b', 'listen on bluetooth even when stdin is not a terminal'),
  flag('--lan|-l', 'listen on the local network instead of bluetooth'),
  flag('--dht|-d', 'listen on the hyperdht instead of bluetooth'),
  flag('--stable|-s', "listen on this wallet's own address rather than a key for this run")
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

export const licenses = command(
  'licenses',
  summary('Print the licenses of everything this binary was built from'),
  // Worth saying where else they are, because the answer differs by how cashme was
  // installed: a release archive has the file beside the binary, a pear install has only
  // the binary, and this command is the copy that is always there.
  description(
    [
      'cashme is Apache-2.0 and is built from packages under Apache-2.0, MIT, ISC and the',
      'Unlicense, all of which are compiled into this binary — so their notices travel',
      'with it, and this is where they are.',
      '',
      'Without --full this lists what went in. With it, the license texts themselves and',
      'the NOTICE files reproduced under section 4(d) of the Apache License, which is the',
      'same document the release archives ship as THIRD-PARTY-NOTICES.md.'
    ].join('\n')
  ),
  flag('--full|-f', 'print the license texts, not just what is in here')
)

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
  description(
    [
      "Where a run's traffic leaves from is the two flags below; without them it goes",
      'straight out of this machine.',
      '',
      '  --proxy socks5://127.0.0.1:9050   every mint request, lightning address and',
      '                                    NIP-05 lookup and relay connection is made by',
      '                                    the proxy rather than by us, and the names go',
      '                                    to it unresolved, so no DNS for a mint leaves',
      '                                    here either. socks5://, socks5h://, http:// and',
      '                                    https://, with a username and password in the',
      '                                    url where one is wanted. CASHME_PROXY sets the',
      '                                    same thing for every run, and failing both,',
      "                                    curl's own https_proxy, http_proxy, ALL_PROXY",
      '                                    and no_proxy are read as curl reads them.',
      '',
      '  --dht-interface en0               send the hyperdht out from one local address,',
      '                                    named by interface or by the address itself.',
      '',
      "  --stable                          present this wallet's own address on every run",
      '                                    and every wire, rather than a key belonging to',
      '                                    one. `give` and `get` take it on their own too.',
      '',
      'Each covers one part of a run and says which. A proxy carries http, https and the',
      'relay websockets; the hyperdht holepunches over UDP and --lan finds its peer by',
      'multicast, so neither goes through it — `give --dht` behind a proxy swaps at the mint',
      'through the proxy and hands the token over directly. --dht-interface is the other way',
      'round: it pins the hyperdht and reaches nothing else, since Bare cannot bind an',
      'outgoing TCP connection to an address. Neither flag refuses a command for the half it',
      'cannot cover — the run says where each half went. Bluetooth and `give --print` touch',
      'no network at all.'
    ].join('\n')
  ),
  flag('--version|-v', 'Print the current version'),
  flag('--storage <dir>', 'custom storage directory'),
  flag('--proxy <url>', 'send every http(s) and relay connection through this proxy'),
  flag('--dht-interface <name|ip>', 'bind the hyperdht to this interface or local address'),
  flag('--stable|-s', "present this wallet's own hyperdht address rather than a one-run key"),
  flag('--no-updates', 'disable OTA updates for this run'),
  flag('--update-window <ms>', 'updater wait in milliseconds'),
  flag('--updater', 'run updater daemon').hide(),
  ui,
  balance,
  deposit,
  withdraw,
  give,
  get,
  nutzap,
  zap,
  pending,
  restore,
  licenses
)
