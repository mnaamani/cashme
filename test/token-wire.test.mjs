import test from 'brittle'
import { tokenQueue } from '../lib/token-wire.mjs'

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
