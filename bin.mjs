// Entry point: parse argv, decide where the wallet lives, dispatch.
//
// One module per command in lib/cli/, named after it (lib/cli/withdraw.mjs is `cashme withdraw`).
import './lib/polyfills.mjs'
import { persistent } from 'bare-storage'
import process from 'bare-process'
import debuglog from 'bare-debug-log'
import os from 'bare-os'
import path from 'bare-path'
import tty from 'bare-tty'
import pkg from './package.json'
import { appName, isDev } from './lib/cli/env.mjs'
import {
  root,
  balance,
  mints,
  relays,
  deposit,
  give,
  get,
  pending,
  nutzap,
  zap,
  withdraw,
  restore,
  ui,
  licenses
} from './lib/cli/commands.mjs'
import { closeWallet } from './lib/cli/session.mjs'
import { spawnUpdater, runUpdater, updateWindow, updatesDisabled } from './lib/updater.mjs'
import { configureNetwork, proxyFailure, proxyInForce, interfaceInForce } from './lib/net.mjs'
import { configureAddress } from './lib/cli/address.mjs'
import { run as runBalance } from './lib/cli/balance.mjs'
import { run as runMints } from './lib/cli/mints.mjs'
import { run as runRelays } from './lib/cli/relays.mjs'
import { run as runDeposit } from './lib/cli/deposit.mjs'
import { run as runWithdraw } from './lib/cli/withdraw.mjs'
import { run as runGive } from './lib/cli/give.mjs'
import { run as runGet } from './lib/cli/get.mjs'
import { run as runPending } from './lib/cli/pending.mjs'
import { run as runNutzap } from './lib/cli/nutzap.mjs'
import { run as runZap } from './lib/cli/zap.mjs'
import { run as runRestore } from './lib/cli/restore.mjs'
import { run as runTui, usable as uiUsable } from './lib/cli/tui.mjs'
import { run as runLicenses } from './lib/cli/licenses.mjs'
import { note, flush } from './lib/notes.mjs'
import { banner, detectLevel, tint, SIGIL, STRAP } from './lib/art.mjs'

const debug = debuglog('cashme:app')

// Whether this run is going to end in help or a version, asked of argv before paparam
// gets it. paparam prints help from inside parse(), so the only way to put anything above
// that is to have said it already — and the wordmark belongs above the help rather than
// somewhere in the middle of it. Sniffing argv for two spellings is the price; the flags
// mean the same wherever on the line they appear, and no command has its own -h or -v.
const argv = Bare.argv.slice(isDev ? 2 : 1)
const asksToBeIntroduced = ['--help', '-h', '--version', '-v'].some((flag) => argv.includes(flag))

// stdout, because that is where the help it sits above goes: a run piping the help into a
// file gets the wordmark in it, in plain characters, which is the same thing without the
// colour. Colour is the part that depends on there being a terminal to show it on.
function introduce() {
  const level = detectLevel(tty.isTTY(1))
  for (const line of banner({
    columns: process.stdout.columns || 80,
    level,
    version: `v${pkg.version}`
  })) {
    console.log(line)
  }
  console.log('')
}

if (asksToBeIntroduced) introduce()

// paparam would run these itself, but a throwing handler goes through its bail(), which
// prints a stack trace. We want the message only, so dispatch by hand.
const handlers = new Map([
  [balance.name, runBalance],
  [mints.name, runMints],
  [relays.name, runRelays],
  [deposit.name, runDeposit],
  [withdraw.name, runWithdraw],
  [give.name, runGive],
  [get.name, runGet],
  [pending.name, runPending],
  [nutzap.name, runNutzap],
  [zap.name, runZap],
  [restore.name, runRestore],
  [ui.name, runTui],
  [licenses.name, runLicenses]
])

// A malformed command line throws out of parse() (see the bail handler in commands.mjs),
// and it throws here rather than inside a command, so it needs catching on its own.
try {
  root.parse(Bare.argv.slice(isDev ? 2 : 1))
} catch (err) {
  note('[app:error]', err.message)
  await flush()
  Bare.exit(1)
}
// Two paths every run depends on and neither of which it otherwise shows: which binary is
// running — there can be one from a release, one from the pear network and one from a
// checkout on the same machine — and which storage directory this run's money is in, which
// --storage and a dev build both move. Printed before anything else can go wrong, so it is
// there on the runs that end in help, in a version, or in an error.
const storage = root.flags.storage || (isDev ? null : path.join(persistent(), appName))
const dir = storage || path.join(os.tmpdir(), 'pear', appName)
// Nothing chose that directory: it is the temp one a dev build falls back to, and the
// wallet in it is gone with the next reboot. Worth saying out loud here, and worth the UI
// wearing a badge for — money put in it is not money kept.
const ephemeral = !storage
// One line saying which wallet is talking, on the runs that are a command rather than the
// full-screen UI — which opens on the wordmark and has already said it. stderr, with the
// rest of what a run says about itself, so it never lands in a piped token or invoice; and
// only where there is a terminal to see it, so a script's log does not collect it.
const wearing = detectLevel(tty.isTTY(2))
if (wearing && root.current && root.current.name !== ui.name) {
  note(
    `${tint(SIGIL, 0.1, wearing)} ${tint(`v${pkg.version} ${STRAP}`, 0.85, wearing, { dim: true })}`
  )
}
note('[app] binary:', process.execPath)
note('[app] storage:', ephemeral ? `${dir} (temporary — dev build)` : dir)
// And a third, on the runs it applies to: whether this wallet is going to keep itself up to
// date. A flag is on the command line where whoever typed it can see it, so --no-updates
// says nothing here — but an exported variable is invisible, and this one quietly holds a
// wallet at the version it already has. That is a thing to be told, not to work out.
// null when the updater is going to run, otherwise what stopped it.
const noUpdates = updatesDisabled(root.flags.updates)
if (noUpdates === 'CASHME_NO_UPDATES') note('[app] updates: disabled by CASHME_NO_UPDATES')

// paparam prints help but does not stop us running the command — without this,
// `cashme get --help` would print its help and then sit waiting on bluetooth.
if (root.flags.help || root.current?.flags?.help) {
  await flush()
  Bare.exit()
}
if (root.flags.version) {
  console.log(`${appName} v${pkg.version}`)
  await flush()
  Bare.exit()
}

// Where this run is allowed to reach the network from, before anything reaches it. A bad
// proxy url or an interface this host does not have is a mistake in the command line, so it
// stops the run here rather than halfway through a payment.
try {
  configureNetwork({ proxy: root.flags.proxy, iface: root.flags.dhtInterface })
  // Which hyperdht address this run presents, unless a command overrides it for itself.
  configureAddress({ stable: root.flags.stable })
  const named = root.current
  const handover = named?.name === get.name || named?.name === give.name
  const overDht = handover && named.flags.dht

  // Both flags cover part of a run rather than all of it, and neither refuses a command for
  // the part it cannot reach. What they do instead is say so, here, once, before anything
  // goes out — so nobody has to guess which half went where.

  // A proxy carries what a proxy can carry. Neither the hyperdht nor the local network
  // handover is http, so neither goes through it, and that is the command working as asked:
  // the mint swap behind the handover is proxied all the same.
  const via = proxyInForce()
  if (via && (overDht || (handover && named.flags.lan))) {
    const wire = overDht ? 'the hyperdht' : 'the local network'
    note(`${via.source} carries the mint and relay traffic; the handover over ${wire} is direct`)
  }

  // --dht-interface reaches the hyperdht and nothing else, so on a command that never opens
  // it the flag is inert, and on one that does it still leaves the mint traffic to the
  // routing table. Both are worth a line: a flag reached for and silently doing nothing is
  // the same surprise as one silently doing too little.
  const pinned = interfaceInForce()
  if (named && pinned) {
    note(
      overDht
        ? `--dht-interface ${pinned} pins the handover; the mint traffic behind it goes out ` +
            'by the routing table'
        : `--dht-interface ${pinned} does nothing here: \`${appName} ${named.name}\` never ` +
            'opens the hyperdht'
    )
  }
} catch (err) {
  note('[app:error]', err.message)
  await flush()
  Bare.exit(1)
}

let wait
try {
  wait = updateWindow(root.flags.updateWindow)
} catch (err) {
  note('[app:error]', err.message)
  await flush()
  Bare.exit(1)
}

if (root.flags.updater) {
  await runUpdater(dir, wait)
  await flush()
  Bare.exit()
}

debug('updates:', noUpdates ? `disabled (${noUpdates})` : 'enabled')

// The updater is a detached process that fetches over the hyperdht, and inherits none of
// this run's flags — so lib/updater.mjs forwards it the one that governs where its traffic
// leaves from. Nothing else it does is covered by a flag here: a proxy cannot carry the
// hyperdht any more than it can carry `give --dht`, which this run would have gone ahead
// with too. `--no-updates` is how to say not to start it.
if (noUpdates === null) {
  try {
    spawnUpdater(dir, wait)
  } catch (err) {
    note('[app:error]', err.message)
    await flush()
    Bare.exit(1)
  }
}

try {
  const command = root.current
  if (command) {
    await handlers.get(command.name)({ dir, flags: command.flags, command })
  } else if (uiUsable()) {
    // Bare `cashme` opens the wallet rather than explaining itself. Someone who ran it
    // with nothing to say wants to see their money, and `--help` is still there for the
    // other reading.
    await runTui({ dir, flags: root.flags, ephemeral })
  } else {
    // No terminal to paint on — a pipe, a script, a cron job. The UI would only refuse,
    // and refusing something nobody asked for is worse than answering the other question.
    // With the same wordmark over it that `--help` gets, since this is the same answer.
    introduce()
    console.log(root.help())
  }
} catch (err) {
  // A locked wallet or an unreachable mint is something the user can act on: print what
  // happened, not where. A proxy that could not be reached arrives as somebody else's
  // wording — coco's `Failed to fetch mint` — with ours behind it, and ours is the half
  // that says what to do about it.
  const proxied = proxyFailure(err)
  note(
    '[app:error]',
    proxied && proxied !== err ? `${err.message}: ${proxied.message}` : err.message
  )
  if (process.env.CASHME_DEBUG || debug.enabled) note(err.stack)
  Bare.exitCode = 1
} finally {
  try {
    await closeWallet()
  } catch (err) {
    // Never let a failure to close bury the error that actually stopped the command.
    note('[app:error] could not close the wallet cleanly:', err.message)
    Bare.exitCode = 1
  }
}

// Everything is awaited and the wallet writes synchronously, so anything still holding the
// loop open is a handle nobody waits on — bluetooth's native managers, which ble-swarm
// cannot always free (see lib/ble.mjs) and which keep bare alive for good. The updater is
// detached and outlives us either way. So exit rather than hope the loop drains.
//
// Except that stderr is one of those queues: exiting on the spot would cut off the last
// lines the command wrote, which are usually the ones saying how it went.
await flush()
Bare.exit(Bare.exitCode || 0)
