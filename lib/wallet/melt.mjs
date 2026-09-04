import { DEFAULT_UNIT } from '@cashu/coco-core'

const POLL_MS = 3000
const POLL_ATTEMPTS = 200
const SWAP_THRESHOLD_NUMERATOR = 11
const SWAP_THRESHOLD_DENOMINATOR = 10

export function quoteMelt(wallet, mintUrl, invoice, unit = DEFAULT_UNIT) {
  return wallet.manager.quotes.melt.create({
    mintUrl,
    method: 'bolt11',
    methodData: { invoice },
    unit
  })
}

export async function inputFeePpk(wallet, mintUrl, unit = 'sat') {
  const keysets = await wallet.repos.keysetRepository.getKeysetsByMintUrl(mintUrl)
  const active = keysets.filter((keyset) => keyset.unit === unit && keyset.active)
  const relevant = active.length ? active : keysets.filter((keyset) => keyset.unit === unit)
  return relevant.reduce((most, keyset) => Math.max(most, keyset.feePpk || 0), 0)
}

export function meltFeasibility(total, feePpk) {
  const amount = Number(total)
  if (!feePpk) return { possible: true, floor: 0, fee: 0 }

  const fee = Math.ceil(feePpk / 1000)
  const floor =
    Math.floor(
      (fee * SWAP_THRESHOLD_DENOMINATOR) / (SWAP_THRESHOLD_NUMERATOR - SWAP_THRESHOLD_DENOMINATOR)
    ) + 1
  return { possible: amount >= floor, floor, fee }
}

export function prepareMelt(wallet, quote) {
  return wallet.manager.ops.melt.prepare({ quote })
}

export function cancelMelt(wallet, prepared, reason) {
  return wallet.manager.ops.melt.cancel(prepared.id, reason)
}

export async function payInvoice(wallet, prepared) {
  let executed
  try {
    executed = await wallet.manager.ops.melt.execute(prepared)
  } catch (err) {
    throw explainMeltFailure(err, prepared)
  }
  if (executed.state === 'finalized') return executed

  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_MS)
    const current = await wallet.manager.ops.melt.refresh(executed.id)
    if (current.state === 'finalized') return current
    if (current.state === 'failed') {
      throw new Error(current.error ?? 'the mint could not pay the invoice')
    }
  }
  throw new Error(
    'the payment is still in flight — run `cashme balance` later to see how it settled'
  )
}

function explainMeltFailure(err, prepared) {
  const shortByFee =
    /Not enough funds available/i.test(err.message) &&
    prepared.needsSwap &&
    Number(prepared.swap_fee) > 0
  if (!shortByFee) return err

  return new Error(
    `this mint charges a fee per input, and coco does not budget for it when a melt needs ` +
      `a swap: it reserved ${prepared.inputAmount} for a swap that costs ` +
      `${prepared.inputAmount} plus ${prepared.swap_fee} in fees. Nothing was spent — the ` +
      `payment was rolled back. A mint that charges no input fee will work.`,
    { cause: err }
  )
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
