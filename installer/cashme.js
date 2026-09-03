#!/usr/bin/env node
// npm install -g @cashme/cli puts this shim on the PATH. It is not the wallet — the wallet is a
// standalone Bare binary, fetched on first run and dropped in ~/.local/bin
// (%LOCALAPPDATA%\Programs\cashme on windows). Every run after that is just an exec of that
// binary, so the shim costs one existsSync and stays out of the way.
//
// Modelled on holepunchto/pear-cli's pear.js, which does the same for the pear CLI. The binary
// comes from the pear network and nowhere else: no release download, no mirror, no host to
// trust — whoever is seeding the link is the whole supply chain.
'use strict'

const process = require('process')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { spawn, spawnSync } = require('child_process')
const { isWindows, isLinux } = require('which-runtime')
const goodbye = require('graceful-goodbye')
const byteSize = require('tiny-byte-size')

// The app's own upgrade link — the key package.json points its OTA updater at, so the binary
// installed here is the one that keeps updating itself afterwards. Hardcoded on purpose: a
// pear link is the app's address for life, the same one every release is staged to, and it is
// the only thing this shim vouches for. Overriding it would point the fetch at someone else's
// drive, and this binary holds keys to real money — a different link means a different shim,
// published to the registry under a version users can see.
const LINK = 'pear://tdnucsbcqeqer3yuyxduty4666zxr1f6ihua1j17g3pwr1qrnd9o'

const HOME = os.homedir()
const BIN_DIR = isWindows
  ? path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Programs', 'cashme')
  : path.join(HOME, '.local', 'bin')
const BIN = path.join(BIN_DIR, `cashme${isWindows ? '.exe' : ''}`)

const isTTY = process.stdout.isTTY

if (fs.existsSync(BIN)) run()
else install().catch(fail)

// --- running it -------------------------------------------------------------

function run() {
  let child = null
  const exited = new Promise((resolve) => {
    child = spawn(BIN, process.argv.slice(2), { stdio: 'inherit' })
      .on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 0)))
      .on('error', (err) => {
        console.error('Failed to run cashme:', err.message)
        console.error('Remove', BIN, 'and rerun to reinstall.')
        resolve(1)
      })
  })
  // The wallet holds a lock on its storage while it runs, so let it see the signal and
  // close cleanly rather than exiting out from under it.
  goodbye(async () => {
    child.kill()
    process.exit(await exited)
  })
  exited.then((code) => {
    process.exit(code)
  })
}

// --- installing it ----------------------------------------------------------

// The pear network: no hosting, and the binary comes from whoever is seeding the link.
async function install() {
  libatomicCheck()

  const Install = require('pear-install')

  console.log('Fetching cashme from peers:', LINK)

  // Double pear-install's 30s, because that budget covers finding a peer as well as talking
  // to one, and a cold swarm on a slow network can spend most of it on discovery alone.
  const install = new Install({ link: LINK, timeout: 60_000 })
  let success = false
  let dest = null

  if (isTTY) install.on('stats', printStats)
  // pear-install decides where the binary lands, from the app's own package.json name — so
  // take the path it reports rather than trusting BIN, which is this shim's guess at the
  // same computation and would silently drift if either side changed.
  install.on('app', (info) => {
    if (info.dest && path.basename(info.dest) === path.basename(BIN)) dest = info.dest
  })
  install.on('final', (result) => {
    success = result.success
  })
  // Install emits errors it survives as well as the one it throws, so keep the listener —
  // an unhandled 'error' would take the process down with a stack trace.
  install.on('error', () => {})

  try {
    await install.ready()
  } finally {
    // Close before anything else: the swarm and corestore keep the process alive, and on
    // the failure path they would hold it open long after there is anything to wait for.
    await install.close()
  }

  if (!success) throw new Error('no binary came back from the pear network')
  if (dest && dest !== BIN) throw new Error(`cashme installed to ${dest}, not ${BIN}`)
  if (!fs.existsSync(BIN)) throw new Error('the install reported success but left no binary')

  quarantine()
  done()
}

// The prebuilt rocksdb that corestore loads links against libatomic, which a few distros
// leave out of a base install. Without this the fetch dies on a require deep inside the
// swarm stack, naming a library rather than the package that installs it. Borrowed from
// pear-cli, which hit the same thing.
function libatomicCheck() {
  if (!isLinux) return
  try {
    require('rocksdb-native')
  } catch {
    throw new Error(`libatomic is missing, so the peer-to-peer fetch cannot start.

Install it with your package manager:
  Debian/Ubuntu   sudo apt install libatomic1
  Fedora          sudo dnf install libatomic
  RHEL/CentOS     sudo yum install libatomic
  Arch            sudo pacman -S libatomic_ops
  Alpine          sudo apk add libatomic

Or skip the fetch entirely and install the release binary:
  curl -fsSL https://raw.githubusercontent.com/mnaamani/cashme/main/install.sh | sh`)
  }
}

// Strip Gatekeeper's quarantine tag, as install.sh does — and, as there, usually there is
// none to strip: the attribute is set by the downloading application, and the pear network
// is no more one of those than curl is. It matters for a binary that reached this machine
// some other way.
function quarantine() {
  if (process.platform !== 'darwin') return
  spawnSync('xattr', ['-d', 'com.apple.quarantine', BIN], { stdio: 'ignore' })
}

function done() {
  if (isTTY) clear()
  console.log('cashme installed:', BIN)

  // npx is where people go to try something without installing it, and this is the one
  // command that does not honour that: the wallet is a permanent binary in BIN_DIR that
  // updates itself from then on, and nothing here is temporary but the shim npx cached.
  if (viaNpx()) {
    console.log('That is a permanent install, not a temporary npx run — cashme keeps itself')
    console.log(`up to date from here on. To undo it: rm ${BIN}`)
  }

  // The run that triggered this asked for something — do it, rather than making them type
  // the command a second time. Straight to BIN, since PATH may not have caught up yet.
  if (process.argv.length > 2) return run()

  // pear-install puts BIN_DIR on the PATH itself as it installs — the shell rc on unix, the
  // user environment on windows — so this is a stale-shell notice, not a missing-PATH one.
  // Either way 'cashme' works right now, because this shim is already on the PATH.
  if (!onPath(BIN_DIR)) {
    console.log(`${BIN_DIR} was added to your PATH; open a new terminal to pick it up.`)
  }
  console.log('Run: cashme --help')
}

// A fetch can fail for reasons that pass on their own — nothing seeding the link right now, a
// network that blocks the swarm — and the retry is always to run cashme again. Worth spelling
// out, because the natural guess is to rerun the npm install, which only reinstalls this shim
// and changes nothing.
function fail(err) {
  if (isTTY) clear()
  console.error('Could not install cashme:')
  console.error('  ' + err.message)
  console.error('')
  // pear-install reports these as PearError codes. Both have a specific answer, and neither
  // is helped by the generic 'try again' below.
  if (err.code === 'ERR_NETWORK_TIMEOUT') {
    console.error('Nothing answered for the link. Either nobody is seeding it right now, or')
    console.error('this network blocks the swarm (UDP hole punching). A different network, or')
    console.error('the release binary, will get past the second:')
    console.error(
      '  curl -fsSL https://raw.githubusercontent.com/mnaamani/cashme/main/install.sh | sh'
    )
    console.error('')
  } else if (err.code === 'ERR_PERMISSION_REQUIRED') {
    console.error(`Nothing here can write to ${BIN_DIR}. Fix its ownership, or install the`)
    console.error('release binary somewhere you own:')
    console.error(
      '  curl -fsSL https://raw.githubusercontent.com/mnaamani/cashme/main/install.sh | sh -s -- --dir <path>'
    )
    console.error('')
  }
  console.error('The wallet is fetched on first run, not by npm, so retry with:')
  console.error('  cashme')
  console.error('Rerunning npm install -g @cashme/cli would only reinstall this shim.')
  process.exit(1)
}

// --- plumbing ---------------------------------------------------------------

// npm sets this for `npx <pkg>` and `npm exec` alike, from npm 7 on.
function viaNpx() {
  return process.env.npm_command === 'exec'
}

function onPath(dir) {
  return (process.env.PATH || '').split(isWindows ? ';' : ':').includes(dir)
}

function clear() {
  process.stdout.write('\x1b[2K') // clear line
  process.stdout.write('\r') // cursor to 0
}

function printStats(stats) {
  if (!isTTY) return
  clear()
  process.stdout.write(
    `[⬇ ${byteSize(stats.download.bytes)} - ${byteSize(stats.download.speed)}/s - ${stats.peers} peers]`
  )
}
