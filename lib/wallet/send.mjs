import { DEFAULT_UNIT, getEncodedToken } from '@cashu/coco-core'

const POLL_MS = 3000

export function prepareSend(wallet, mintUrl, amount, unit = DEFAULT_UNIT) {
  return wallet.manager.ops.send.prepare({ mintUrl, amount, unit })
}

export async function executeSend(wallet, prepared) {
  const { operation, token } = await wallet.manager.ops.send.execute(prepared)
  return { operation, token: getEncodedToken(token) }
}

export function prepareP2pkSend(wallet, mintUrl, amount, pubkey, unit = DEFAULT_UNIT) {
  return wallet.manager.ops.send.prepare({
    mintUrl,
    amount,
    unit,
    target: { type: 'p2pk', pubkey }
  })
}

export function executeSendProofs(wallet, prepared) {
  return wallet.manager.ops.send.execute(prepared)
}

export function cancelSend(wallet, prepared) {
  return wallet.manager.ops.send.cancel(prepared.id)
}

export function finalizeSend(wallet, operation) {
  return wallet.manager.ops.send.finalize(operation.id)
}

export function reclaimSend(wallet, operation) {
  return wallet.manager.ops.send.reclaim(operation.id)
}

export function pendingSends(wallet) {
  return wallet.manager.ops.send.listInFlight()
}

export function refreshSend(wallet, operationId) {
  return wallet.manager.ops.send.refresh(operationId)
}

export async function awaitSendClaim(wallet, operation, { cancelled, onPoll } = {}) {
  const stopped = cancelled ?? new Promise(() => {})
  let failures = 0
  for (;;) {
    try {
      const current = await refreshSend(wallet, operation.id)
      failures = 0
      if (current.state !== 'pending') return current
    } catch (err) {
      if (++failures >= 5) throw err
    }
    if (onPoll) onPoll()
    if (await Promise.race([sleep(POLL_MS).then(() => null), stopped])) return null
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
