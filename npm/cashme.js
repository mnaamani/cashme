#!/usr/bin/env node
// npm install -g @cashme/cli puts this shim on the PATH. It is not the wallet — the wallet is a
// standalone Bare binary, fetched on first run and dropped in ~/.local/bin
// (%LOCALAPPDATA%\Programs\cashme on windows). Every run after that is just an exec of that
// binary, so the shim costs one existsSync and stays out of the way.
//
// Modelled on holepunchto/pear-cli's pear.js, which does the same for the pear CLI, with a
// second way in: if no peer is seeding the link, fall back to the GitHub release asset —
// the same download install.sh does, so neither route depends on the other surviving.
'use strict'

const process = require('process')
const os = require('os')
const path = require('path')
const fs = require('fs')
const https = require('https')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')
const { isWindows } = require('which-runtime')
const goodbye = require('graceful-goodbye')
const byteSize = require('tiny-byte-size')

// The app's own upgrade link — the key package.json points its OTA updater at, so the
// binary installed here is the one that keeps updating itself afterwards.
const LINK =
  process.env.CASHME_LINK || 'pear://tdnucsbcqeqer3yuyxduty4666zxr1f6ihua1j17g3pwr1qrnd9o'
const REPO = process.env.CASHME_REPO || 'mnaamani/cashme'
const VERSION = process.env.CASHME_VERSION || 'latest'
// pear | release | auto. auto tries the pear network first and falls back to the release.
const METHOD = process.env.CASHME_METHOD || 'auto'

// node's platform and arch names are exactly the host names the builds are published under.
const HOST = `${process.platform}-${process.arch}`

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

async function install() {
  const methods =
    METHOD === 'pear'
      ? [fromPear]
      : METHOD === 'release'
        ? [fromRelease]
        : METHOD === 'auto'
          ? [fromPear, fromRelease]
          : null
  if (methods === null) {
    throw new Error(`unknown CASHME_METHOD '${METHOD}' (expected: auto, pear or release)`)
  }

  const failures = []
  for (const method of methods) {
    try {
      await method()
      return done()
    } catch (err) {
      if (isTTY) clear()
      failures.push(err.message)
      // Every method left the binary unwritten, so the next one starts from the same place.
      if (method !== methods[methods.length - 1]) {
        console.error(err.message + ' — trying another way')
      }
    }
  }
  throw new Error(failures.join('\n  '))
}

// The pear network: no hosting, and the binary comes from whoever is seeding the link.
async function fromPear() {
  const Install = require('pear-install')

  console.log('Fetching cashme from peers:', LINK)

  const install = new Install({ link: LINK })
  let success = false

  if (isTTY) install.on('stats', printStats)
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

  if (!success || !fs.existsSync(BIN)) throw new Error('no binary came back from the pear network')
}

// The GitHub release: what install.sh downloads, verified against the same SHA256SUMS.
async function fromRelease() {
  const asset = `cashme-${HOST}.${isWindows ? 'zip' : 'tar.gz'}`
  const base =
    process.env.CASHME_BASE_URL ||
    (VERSION === 'latest'
      ? `https://github.com/${REPO}/releases/latest/download`
      : `https://github.com/${REPO}/releases/download/v${VERSION.replace(/^v/, '')}`)

  console.log('Downloading', asset)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cashme-'))
  try {
    const archive = path.join(tmp, asset)
    const sha = await download(`${base}/${asset}`, archive)
    await verify(base, asset, sha)

    unpack(archive, tmp)
    const src = path.join(tmp, `cashme${isWindows ? '.exe' : ''}`)
    if (!fs.existsSync(src)) throw new Error(`${asset} holds no cashme binary`)

    place(src)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// Fails closed, as install.sh does: an unverified binary is one this shim has no reason to
// trust, and it holds the keys to real money. A missing sums file throws rather than
// installing anyway — under CASHME_METHOD=auto the pear network has already been tried, so
// there is nothing left to fall back to that would be safer.
async function verify(base, asset, sha) {
  let sums = null
  try {
    sums = await download(`${base}/SHA256SUMS`)
  } catch {
    throw new Error(
      `no SHA256SUMS published alongside ${asset}, so it cannot be verified\n` +
        `Refusing to install. Report it if it persists: https://github.com/${REPO}/issues`
    )
  }

  // The name is matched as its own field, not as a suffix of the line: `endsWith` would
  // take the entry for `not-really-${asset}` as this asset's.
  const entries = sums
    .toString()
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter(([, name]) => name && name.replace(/^\*/, '') === asset)
  if (entries.length !== 1) throw new Error(`SHA256SUMS has no single entry for ${asset}`)

  const want = entries[0][0]
  if (want !== sha) {
    throw new Error(
      `checksum mismatch for ${asset}\n  expected ${want}\n  got      ${sha}\n` +
        `Refusing to install. Report it if it persists: https://github.com/${REPO}/issues`
    )
  }
  console.log('Checksum ok')
}

function unpack(archive, dir) {
  // tar ships with macOS, linux and windows 10+; Expand-Archive is the surer bet on windows.
  const { status, stderr } = isWindows
    ? spawnSync('powershell', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`
      ])
    : spawnSync('tar', ['-xzf', archive, '-C', dir])
  if (status !== 0) {
    throw new Error(`could not unpack ${path.basename(archive)}: ${stderr?.toString().trim()}`)
  }
}

function place(src) {
  fs.mkdirSync(BIN_DIR, { recursive: true })
  try {
    // Rename so the binary appears whole or not at all; across filesystems it cannot, and
    // the temp dir is usually on another one, so copy is the common path rather than the
    // exception. Copy to a sibling first and rename that into place to keep it atomic.
    fs.renameSync(src, BIN)
  } catch (err) {
    if (err.code !== 'EXDEV') throw err
    const staged = BIN + '.tmp'
    fs.copyFileSync(src, staged)
    fs.renameSync(staged, BIN)
  }
  fs.chmodSync(BIN, 0o755)

  // macOS quarantines anything downloaded over http; without this the first run is a dialog.
  if (process.platform === 'darwin') {
    spawnSync('xattr', ['-d', 'com.apple.quarantine', BIN], { stdio: 'ignore' })
  }
}

function done() {
  if (isTTY) clear()
  console.log('cashme installed:', BIN)

  // The run that triggered this asked for something — do it, rather than making them type
  // the command a second time. Straight to BIN, since PATH may not have caught up yet.
  if (process.argv.length > 2) return run()

  if (!onPath(BIN_DIR)) {
    console.log(`${BIN_DIR} is not on your PATH, but 'cashme' still works — this shim is.`)
  }
  console.log('Run: cashme --help')
}

// A fetch can fail for reasons that pass on their own — nothing seeding the link, no release
// for this platform yet, a network that blocks one or the other — and the retry is always to
// run cashme again. Worth spelling out, because the natural guess is to rerun the npm
// install, which only reinstalls this shim and changes nothing.
function fail(err) {
  if (isTTY) clear()
  console.error('Could not install cashme:')
  console.error('  ' + err.message)
  console.error('')
  console.error('The wallet is fetched on first run, not by npm, so retry with:')
  console.error('  cashme')
  console.error('Rerunning npm install -g @cashme/cli would only reinstall this shim.')
  console.error(`Or take a binary from https://github.com/${REPO}/releases`)
  process.exit(1)
}

// --- plumbing ---------------------------------------------------------------

// Downloads to `dest`, returning its sha256; with no `dest`, returns the body itself.
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'))

    const req = https.get(url, { headers: { 'user-agent': 'cashme-installer' } }, (res) => {
      const { statusCode, headers } = res

      // Release assets live behind a redirect to object storage.
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume()
        const next = new URL(headers.location, url).toString()
        return resolve(download(next, dest, redirects + 1))
      }
      if (statusCode !== 200) {
        res.resume()
        const what = path.basename(new URL(url).pathname)
        return reject(new Error(`${what} is not published for ${HOST} (HTTP ${statusCode})`))
      }

      const hash = crypto.createHash('sha256')
      const total = Number(headers['content-length']) || 0
      const chunks = dest ? null : []
      let read = 0

      const file = dest ? fs.createWriteStream(dest) : null
      if (file) file.on('error', reject)

      res.on('data', (chunk) => {
        hash.update(chunk)
        if (chunks) chunks.push(chunk)
        read += chunk.length
        if (dest) printProgress(read, total)
      })
      res.on('error', reject)
      res.on('end', () => {
        if (!file) return resolve(Buffer.concat(chunks))
        file.end(() => {
          if (isTTY && dest) clear()
          resolve(hash.digest('hex'))
        })
      })
      if (file) res.pipe(file)
    })

    req.on('error', reject)
    req.setTimeout(30_000, () => {
      req.destroy(new Error('network timeout reaching github.com'))
    })
  })
}

function onPath(dir) {
  return (process.env.PATH || '').split(isWindows ? ';' : ':').includes(dir)
}

function clear() {
  process.stdout.write('\x1b[2K') // clear line
  process.stdout.write('\r') // cursor to 0
}

function printProgress(read, total) {
  if (!isTTY) return
  clear()
  const pct = total ? ` (${Math.floor((read / total) * 100)}%)` : ''
  process.stdout.write(`[⬇ ${byteSize(read)}${pct}]`)
}

function printStats(stats) {
  if (!isTTY) return
  clear()
  process.stdout.write(
    `[⬇ ${byteSize(stats.download.bytes)} - ${byteSize(stats.download.speed)}/s - ${stats.peers} peers]`
  )
}
