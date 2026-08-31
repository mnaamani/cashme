// Entry point: parse argv, decide where the wallet lives, dispatch.
//
// One module per command in lib/cli/, named after it (lib/cli/withdraw.mjs is `cashme withdraw`).
import './lib/polyfills.mjs'
import { persistent } from 'bare-storage'
import process from 'bare-process'
import debuglog from 'bare-debug-log'
import os from 'bare-os'
import path from 'bare-path'
import pkg from './package.json'
import { appName, isDev } from './lib/cli/env.mjs'
import {
  root,
  balance,
  deposit,
  give,
  get,
  pending,
  nutzap,
  zap,
  withdraw,
  restore
} from './lib/cli/commands.mjs'
import { closeWallet } from './lib/cli/session.mjs'
import { spawnUpdater, runUpdater, updateWindow } from './lib/updater.mjs'
import {
  configureNetwork,
  updaterBlocked,
  proxyFailure,
  proxyInForce,
  interfaceInForce
} from './lib/net.mjs'
import { run as runBalance } from './lib/cli/balance.mjs'
import { run as runDeposit } from './lib/cli/deposit.mjs'
import { run as runWithdraw } from './lib/cli/withdraw.mjs'
import { run as runGive } from './lib/cli/give.mjs'
import { run as runGet } from './lib/cli/get.mjs'
import { run as runPending } from './lib/cli/pending.mjs'
import { run as runNutzap } from './lib/cli/nutzap.mjs'
import { run as runZap } from './lib/cli/zap.mjs'
import { run as runRestore } from './lib/cli/restore.mjs'
import { note, flush } from './lib/notes.mjs'

const debug = debuglog('cashme:app')

// paparam would run these itself, but a throwing handler goes through its bail(), which
// prints a stack trace. We want the message only, so dispatch by hand.
const handlers = new Map([
  [balance.name, runBalance],
  [deposit.name, runDeposit],
  [withdraw.name, runWithdraw],
  [give.name, runGive],
  [get.name, runGet],
  [pending.name, runPending],
  [nutzap.name, runNutzap],
  [zap.name, runZap],
  [restore.name, runRestore]
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
// paparam prints help but does not stop us running the command — without this,
// `cashme get --help` would print its help and then sit waiting on bluetooth.
if (root.flags.help || root.current?.flags?.help) Bare.exit()
if (root.flags.version) {
  console.log(`${appName} v${pkg.version}`)
  Bare.exit()
}

// Where this run is allowed to reach the network from, before anything reaches it. A bad
// proxy url or an interface this host does not have is a mistake in the command line, so it
// stops the run here rather than halfway through a payment.
try {
  configureNetwork({ proxy: root.flags.proxy, iface: root.flags.dhtInterface })
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

const updates = root.flags.updates
const storage = root.flags.storage || (isDev ? null : path.join(persistent(), appName))
const dir = storage || path.join(os.tmpdir(), 'pear', appName)
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
  Bare.exit()
}

debug('updates:', updates === false ? 'disabled' : 'enabled')
debug('storage path:', dir)

// The updater is a detached process that fetches over the hyperdht on its own, knowing
// nothing of what this run was told. Rather than let it go out on terms the run did not
// choose, it is left unstarted and said so — see updaterBlocked() for which flags stop it
// and why a proxy inherited from the environment is not one of them.
const blocked = updaterBlocked()
if (updates !== false && blocked) {
  note(
    `updates are off this run: the updater reaches the hyperdht as a process of its own, ` +
      `which ${blocked} does not cover`
  )
} else if (updates !== false) {
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
  if (!command) {
    console.log(root.help())
  } else {
    await handlers.get(command.name)({ dir, flags: command.flags, command })
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
