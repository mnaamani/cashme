import test from 'brittle'
import { MAX_TOKEN_BYTES, assertTokenSize, tokenQueue, withTimeout } from '../lib/token-wire.mjs'

test('a failed token receipt is rejected without poisoning the next receipt', async (t) => {
  const received = []
  const queue = tokenQueue((token) => {
    if (token === 'refused') throw new Error('mint was declined')
    received.push(token)
  })

  await t.exception(queue.enqueue('refused'), /mint was declined/)
  await queue.enqueue('accepted')
  await queue.drained()

  t.alike(received, ['accepted'], 'the next sender can still receive a durable receipt')
})

test('token input and pending receipts have finite limits', async (t) => {
  t.exception(() => assertTokenSize('x'.repeat(MAX_TOKEN_BYTES + 1)), /maximum/)

  let release
  const waiting = new Promise((resolve) => {
    release = resolve
  })
  const queue = tokenQueue(() => waiting, { maxPending: 1 })

  const first = queue.enqueue('first')
  t.absent(queue.canReceive(), 'the one available receipt slot is occupied')
  await t.exception(queue.enqueue('second'), /too many incoming tokens/)
  release()
  await first
  t.ok(queue.canReceive(), 'settling a receipt frees its slot')
})

test('a rejected operation clears its timeout', async (t) => {
  const set = globalThis.setTimeout
  const clear = globalThis.clearTimeout
  const timer = { id: 'timer' }
  let cleared = null
  globalThis.setTimeout = () => timer
  globalThis.clearTimeout = (value) => {
    cleared = value
  }
  t.teardown(() => {
    globalThis.setTimeout = set
    globalThis.clearTimeout = clear
  })

  await t.exception(
    withTimeout(Promise.reject(new Error('connection failed')), 5000, false),
    /connection failed/
  )
  t.is(cleared, timer, 'the rejected operation does not leave a timer behind')
})
