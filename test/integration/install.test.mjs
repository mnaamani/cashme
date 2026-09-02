// `npm run install:local`: the build the release uses, put where an install would put it.
//
// What is worth testing here is the seam between the two halves — that the script finds the
// binary the build wrote and leaves behind something that actually runs. So the real script
// is run, pointed at a directory of its own, and the binary it leaves is executed.
import '../../lib/polyfills.mjs'
import test from 'brittle'
import process from 'bare-process'
import { spawn } from 'bare-subprocess'
import { mkdirSync, rmSync, statSync } from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import { OFFLINE } from './helpers.mjs'

const ROOT = path.join(import.meta.dirname, '..', '..')
const isWindows = os.platform() === 'win32'
const NAME = `cashme${isWindows ? '.exe' : ''}`

// The build fetches the bare prebuilds for the host, so it is one of the tests that needs
// the network.
const BUILD_TIMEOUT = 600000

function run(cmd, args, { cwd = ROOT, env = {}, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWindows
    })

    let output = ''
    let settled = false
    const read = (data) => {
      output += data
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.stdin.end()

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      if (settled) return
      settled = true
      reject(
        new Error(
          `\`${cmd} ${args.join(' ')}\` did not finish within ${timeout}ms. Output:\n${output}`
        )
      )
    }, timeout)

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

test('npm run install:local builds the binary and installs it where it can be run', async (t) => {
  if (OFFLINE) {
    t.pass('skipped: CASHME_TEST_OFFLINE=1 and the build fetches prebuilds')
    return
  }
  t.timeout(BUILD_TIMEOUT + 120000)

  // Never the real install location: the test installs into a directory of its own, which
  // is what CASHME_INSTALL_DIR is for.
  const dir = path.join(os.tmpdir(), `cashme-install-${os.pid()}`)
  mkdirSync(dir, { recursive: true })
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))

  const install = await run('npm', ['run', 'install:local'], {
    env: { CASHME_INSTALL_DIR: dir },
    timeout: BUILD_TIMEOUT
  })
  t.is(install.code, 0, `install:local exited cleanly. Output:\n${install.output}`)

  const bin = path.join(dir, NAME)
  t.ok(install.output.includes(bin), 'and said where it put the binary')

  const stat = statSync(bin)
  t.ok(stat.size > 0, 'the installed binary is not empty')
  if (!isWindows) t.is(stat.mode & 0o111, 0o111, 'and is executable')

  // The point of the whole exercise: what was installed runs, on its own, from where it
  // was put — not through the repo's bin.mjs.
  const version = await run(
    bin,
    ['--no-updates', '--storage', path.join(dir, 'wallet'), '--version'],
    {
      cwd: dir
    }
  )
  t.is(version.code, 0, `the installed binary ran. Output:\n${version.output}`)
  t.ok(/cashme v\d+\.\d+\.\d+/.test(version.output), 'and printed its version')
})
