import { DEFAULT_UNIT, OperationInProgressError } from '@cashu/coco-core'
import { normalizeMintUrl } from '../mint-url.mjs'
import { note, write } from '../notes.mjs'

const POLL_MS = 3000
const POLL_ATTEMPTS = 200
const IN_PROGRESS_MS = 250
const IN_PROGRESS_ATTEMPTS = 12

export async function sweepPreparedOperations({ manager }) {
  const reclaimed = []
  for (const [kind, ops] of [
    ['send', manager.ops.send],
    ['payment', manager.ops.melt]
  ]) {
    for (const operation of await ops.listPrepared()) {
      try {
        await ops.cancel(operation.id)
        reclaimed.push({
          kind,
          id: operation.id,
          amount: operation.inputAmount ?? operation.amount,
          unit: operation.unit
        })
      } catch (err) {
        note(`[wallet] could not reclaim the ${kind} ${operation.id}: ${err.message}`)
      }
    }
  }
  return reclaimed
}

export async function settleInFlightMints({ manager }) {
  const deposited = []
  for (const operation of await manager.ops.mint.listInFlight()) {
    try {
      const current = await manager.ops.mint.refresh(operation.id)
      if (current.state === 'finalized') deposited.push(current)
    } catch (err) {
      if (err instanceof OperationInProgressError) {
        const current = await settledElsewhere(manager, operation.id)
        if (current) deposited.push(current)
        continue
      }
      note(`[wallet] could not finish the deposit ${operation.id}: ${err.message}`)
    }
  }
  return deposited.map(({ amount, unit }) => ({ amount, unit }))
}

async function settledElsewhere(manager, operationId) {
  for (let attempt = 0; attempt < IN_PROGRESS_ATTEMPTS; attempt++) {
    await sleep(IN_PROGRESS_MS)
    const current = await manager.ops.mint.get(operationId)
    if (current?.state === 'finalized') return current
    if (current?.state !== 'pending' && current?.state !== 'executing') return null
  }
  return null
}

export async function useMint(wallet, mintUrl) {
  const url = normalizeMintUrl(mintUrl)
  if (!(await wallet.manager.mint.isTrustedMint(url))) {
    await wallet.manager.mint.addMint(url, { trusted: true })
  }
  return url
}

export async function mintTokens(wallet, mintUrl, amount, { unit = DEFAULT_UNIT, onQuote } = {}) {
  const { manager } = wallet
  const quote = await manager.quotes.mint.create({ mintUrl, amount, method: 'bolt11', unit })
  if (onQuote) onQuote(quote)

  const operation = await manager.ops.mint.prepare({ quote, amount })
  let waiting = false
  const endWaiting = () => {
    if (waiting) write('\n')
    waiting = false
  }

  let paid = false
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    let check = null
    try {
      check = await manager.ops.mint.checkPayment(operation.id)
    } catch (err) {
      if ((await manager.ops.mint.get(operation.id))?.state === 'pending') {
        endWaiting()
        throw err
      }
    }

    if (check?.category === 'terminal') {
      endWaiting()
      throw new Error(check.terminalFailure?.reason ?? 'the mint refused to issue the proofs')
    }
    if (check?.category === 'waiting') {
      if (!waiting) note('invoice not paid yet, waiting...')
      waiting = true
      write('.')
      await sleep(POLL_MS)
      continue
    }

    endWaiting()
    if (!paid) note('Invoice paid.')
    paid = true

    const current = await manager.ops.mint.finalize(operation.id)
    if (current.state === 'finalized') return current
    if (current.state === 'failed') {
      throw new Error(current.terminalFailure?.reason ?? current.error ?? 'mint operation failed')
    }
    await sleep(POLL_MS)
  }
  endWaiting()
  throw new Error(
    paid
      ? 'the mint did not issue the proofs in time — run `cashme balance` later'
      : 'the invoice was not paid in time — deposit again when you can'
  )
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
