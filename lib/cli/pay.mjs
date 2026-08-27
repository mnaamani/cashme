import {
  useMint,
  richestMint,
  balances,
  quoteMelt,
  inputFeePpk,
  meltFeasibility,
  prepareMelt,
  cancelMelt,
  payInvoice
} from '../manager.mjs'
import { useWallet } from './session.mjs'
import { showBalances, confirm } from './ui.mjs'

export async function run({ dir, flags, command }) {
  const invoice = flags.invoice
  if (!invoice) {
    console.log(command.help())
    return
  }

  const wallet = await useWallet(dir)

  // A melt happens at one mint, and the mint is what quotes the fee — so the mint has to
  // be chosen before the cost is known. Without --mint, take the one with the most in it
  // and let the quote below decide whether that is enough.
  const mintUrl = flags.mint ? await useMint(wallet, flags.mint) : await richestMint(wallet)
  if (!mintUrl) {
    console.log('This wallet holds no ecash to pay with.')
    return
  }

  // Quote first: it costs nothing and touches no proofs, and it is the mint — not the
  // invoice — that says what the payment will actually total.
  const quote = await quoteMelt(wallet, mintUrl, invoice)
  const total = Number(quote.amount) + Number(quote.fee_reserve)
  // The mint's balance in the quote's own unit: what it holds in any other unit cannot
  // pay this invoice.
  const held = (await balances(wallet, { units: [quote.unit] }))[mintUrl]?.[quote.unit]
  const feePpk = await inputFeePpk(wallet, mintUrl, quote.unit)

  console.log(`Paying from ${mintUrl}`)
  console.log(`  invoice     ${quote.amount} ${quote.unit}`)
  console.log(`  fee reserve ${quote.fee_reserve} ${quote.unit}`)
  console.log(`  total       ${total} ${quote.unit} of ${held?.spendable ?? 0} available`)
  if (feePpk) console.log(`  mint fee    ${feePpk} ppk per proof spent`)
  console.log("The fee reserve is the mint's worst case; whatever is left comes back as change.")

  if (Number(held?.spendable ?? 0) < total) {
    console.log(`Not enough at ${mintUrl} to cover the invoice and its fee reserve.`)
    return
  }

  // Some melts cannot work at this mint whatever we hold, because coco does not budget
  // for the per-input fee when it swaps before melting. Stop here rather than reserving
  // proofs for a payment that is arithmetically certain to be refused.
  const feasible = meltFeasibility(total, feePpk)
  if (!feasible.possible) {
    console.log(`\nThis mint takes ${feasible.fee} ${quote.unit} per proof spent, and coco does`)
    console.log('not budget for that when it swaps before melting — so a payment totalling')
    console.log(`less than ${feasible.floor} ${quote.unit} here always comes up short by the fee.`)
    console.log('Nothing was spent. Use a mint with no input fee, or a larger invoice.')
    return
  }

  if (!flags.yes && !(await confirm('Pay this invoice?'))) {
    console.log('Cancelled. Nothing was spent.')
    return
  }

  // Reserve the inputs, then pay. Between these two the proofs are ours again if
  // anything goes wrong; after it, only the mint can say how the payment ended.
  const prepared = await prepareMelt(wallet, quote)
  let result
  try {
    result = await payInvoice(wallet, prepared)
  } catch (err) {
    await cancelMelt(wallet, prepared, 'cashme pay failed').catch(() => {})
    throw err
  }

  console.log('Paid.')
  if (result.changeAmount !== undefined) {
    console.log(`Change returned: ${result.changeAmount} ${quote.unit}`)
  }
  if (result.effectiveFee !== undefined) {
    console.log(`Fee actually paid: ${result.effectiveFee} ${quote.unit}`)
  }
  await showBalances(wallet, 'New Balance')
}
