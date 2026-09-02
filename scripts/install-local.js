#!/usr/bin/env node
'use strict'

// Builds the standalone binary for this machine and puts it where an install would, so a
// local change can be run as `cashme` without going through a release.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const host = `${os.platform()}-${os.arch()}`
const isWindows = os.platform() === 'win32'
const name = isWindows ? 'cashme.exe' : 'cashme'

// Where an installed cashme lives: install.sh and the `npm i -g @cashme/cli` shim both put
// the binary in ~/.local/bin, and on windows the shim uses %LOCALAPPDATA%\Programs\cashme.
// A locally built one then replaces the installed one rather than sitting beside it.
const dir =
  process.env.CASHME_INSTALL_DIR ||
  (isWindows
    ? path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'Programs',
        'cashme'
      )
    : path.join(os.homedir(), '.local', 'bin'))

const opts = { cwd: root, stdio: 'inherit' }
const res = isWindows
  ? spawnSync('npm.cmd run make', { ...opts, shell: true })
  : spawnSync('npm', ['run', 'make'], opts)
if (res.error) {
  console.error(res.error.message)
  process.exit(1)
}
if (res.status !== 0) process.exit(res.status || 1)

const src = path.join(root, 'out', host, name)
if (!fs.existsSync(src)) {
  console.error(`no binary at ${src} — did the build fail?`)
  process.exit(1)
}

const dest = path.join(dir, name)

// Copy beside the destination and rename over it, so the binary appears whole or not at
// all, and so replacing one that is currently running does not write into it.
const tmp = `${dest}.${process.pid}.tmp`
try {
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(src, tmp)
  fs.chmodSync(tmp, 0o755)
  fs.renameSync(tmp, dest)
} catch (err) {
  try {
    fs.unlinkSync(tmp)
  } catch {}
  console.error(`could not install to ${dest}: ${err.message}`)
  console.error('Pick another directory with CASHME_INSTALL_DIR=<path>.')
  process.exit(1)
}

console.log(`installed ${dest}`)

const paths = (process.env.PATH || '').split(path.delimiter)
if (!paths.includes(dir)) console.log(`${dir} is not on your PATH.`)
