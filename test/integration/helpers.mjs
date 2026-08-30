// Shared machinery for the integration tests: a throwaway wallet, a nostr relay we control,
// and a way to run the real CLI as a subprocess.
import '../../lib/polyfills.mjs'
import process from 'bare-process'
import { spawn } from 'bare-subprocess'
import { mkdirSync, rmSync } from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import { Server } from 'bare-ws'

// The mint these tests spend at. testnut issues ecash without a real lightning payment,
// which is the only reason a test can mint at all. Point it elsewhere to run against
// another mint; the tests never assume testnut beyond that.
export const MINT = process.env.CASHME_TEST_MINT || 'https://testnut.cashu.space'

// Set when the mint is deliberately not available — CI without egress, or an offline
// laptop. The tests that need it then report themselves skipped rather than failing.
export const OFFLINE = process.env.CASHME_TEST_OFFLINE === '1'

const ROOT = path.join(import.meta.dirname, '..', '..')

let counter = 0

// A wallet directory of its own per test, so nothing here can touch a real one.
export function walletdir(t) {
  const dir = path.join(os.tmpdir(), `cashme-integration-${os.pid()}-${counter++}`)
  mkdirSync(dir, { recursive: true })
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Run the real cashme CLI the way a user does, and hand back everything it printed. The
// commands are what we are testing: their output is the contract a user sees, and driving
// them any other way would test something else.
// `until` is for the commands that are not meant to end. `give --print` hands the token
// over and then waits for the receiver to claim it, which in a test never happens — so the
// test says what it is waiting to see, and the run is stopped once it has. Leaving the send
// pending is not a workaround: it is the state the reclaim path exists for.
export function cli(dir, args, { timeout = 120000, until = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, 'bin.mjs'), '--no-updates', '--storage', dir, ...args],
      { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
    )

    let output = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, output })
    }

    const read = (data) => {
      output += data
      if (until && until.test(output)) {
        child.kill('SIGKILL')
        finish(null)
      }
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    // Nothing is typed at these runs: every command that would prompt is passed --yes.
    child.stdin.end()

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      if (settled) return
      settled = true
      reject(
        new Error(
          `\`cashme ${args.join(' ')}\` did not finish within ${timeout}ms. Output:\n${output}`
        )
      )
    }, timeout)

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', finish)
  })
}

// A CLI run the test keeps hold of while it is still going.
//
// `cli` above is for a command that ends, or that only has to say one thing before being
// stopped. A handover needs both sides at once: the receiver has to be listening, and the
// key it prints read off, before the sender can be started against it. So this hands back
// the running process and a way to wait on a line of its output.
export function session(t, dir, args) {
  const child = spawn(
    process.execPath,
    [path.join(ROOT, 'bin.mjs'), '--no-updates', '--storage', dir, ...args],
    { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
  )

  const run = { output: '' }
  let waiting = null
  let closed = false

  const settle = () => {
    if (!waiting) return
    if (waiting.pattern.test(run.output)) {
      const { resolve, timer } = waiting
      waiting = null
      clearTimeout(timer)
      resolve(run.output)
    } else if (closed) {
      const { reject, timer } = waiting
      waiting = null
      clearTimeout(timer)
      reject(new Error(`\`cashme ${args.join(' ')}\` ended first. Output:\n${run.output}`))
    }
  }

  const read = (data) => {
    run.output += data
    settle()
  }
  child.stdout.on('data', read)
  child.stderr.on('data', read)
  child.stdin.end()
  child.on('close', () => {
    closed = true
    settle()
  })

  // Resolves once the run has printed something matching, on the output so far or on what
  // it prints next.
  run.waitFor = (pattern, timeout = 120000) =>
    new Promise((resolve, reject) => {
      waiting = {
        pattern,
        resolve,
        reject,
        timer: setTimeout(() => {
          waiting = null
          reject(
            new Error(
              `\`cashme ${args.join(' ')}\` never printed ${pattern} within ${timeout}ms. ` +
                `Output:\n${run.output}`
            )
          )
        }, timeout)
      }
      settle()
    })

  run.kill = () => child.kill('SIGKILL')
  // These runs are meant to outlive the assertion they were started for, so nothing else
  // stops them.
  t.teardown(run.kill)
  return run
}

// A relay that says exactly what a test tells it to.
//
// The point is not to be a relay: it is to be a relay we can make dishonest. A real one
// cannot be asked to forge an event or answer a question with something else, and those
// are the cases the wallet's checking exists for.
export class StubRelay {
  constructor() {
    this.events = [] // what we serve to a REQ
    this.received = [] // what was published to us
    // The host is not optional: left to itself bare-ws binds ::1, while a client dialling
    // 127.0.0.1 gets a connection refused it reports only as a network error.
    this.server = new Server({ port: 0, host: '127.0.0.1' }, (socket) => this._onconnection(socket))
  }

  // Resolves once the relay is listening, to the url a client should dial.
  ready() {
    if (this.server.listening) return Promise.resolve(this.url)
    return new Promise((resolve) => this.server.on('listening', () => resolve(this.url)))
  }

  get url() {
    return `ws://127.0.0.1:${this.server.address().port}`
  }

  // Serve this event to any REQ whose filter matches it.
  serve(event) {
    this.events.push(event)
    return this
  }

  _onconnection(socket) {
    socket.on('error', () => {}) // a client that vanishes is not a test failure
    socket.on('data', (data) => {
      let message
      try {
        message = JSON.parse(data.toString())
      } catch {
        return
      }

      if (message[0] === 'REQ') {
        const [, id, filter] = message
        for (const event of this.events) {
          if (filter.kinds && !filter.kinds.includes(event.kind)) continue
          if (filter.authors && !filter.authors.includes(event.pubkey)) continue
          socket.write(JSON.stringify(['EVENT', id, event]), 'utf8')
        }
        socket.write(JSON.stringify(['EOSE', id]), 'utf8')
      }

      if (message[0] === 'EVENT') {
        const event = message[1]
        this.received.push(event)
        socket.write(JSON.stringify(['OK', event.id, true, '']), 'utf8')
      }
    })
  }

  // Serve whatever the test asked for, on a relay that closes when the test ends.
  static async open(t) {
    const relay = new StubRelay()
    t.teardown(() => relay.server.close())
    await relay.ready()
    return relay
  }
}

// Pull the one number a balance line reports, so a test can assert on it.
export function satsIn(output, label) {
  const match = new RegExp(`${label}:\\s*(\\d+) sat`).exec(output)
  return match ? Number(match[1]) : null
}
