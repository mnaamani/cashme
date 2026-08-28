import {
  useMint,
  richestMint,
  DEFAULT_UNIT,
  balances,
  quoteMelt,
  inputFeePpk,
  meltFeasibility,
  prepareMelt,
  cancelMelt,
  payInvoice
} from '../manager.mjs'
import { useWallet } from './session.mjs'
import { showBalances, confirm, unitFlag } from './ui.mjs'

export async function run({ dir, flags, command }) {
  const invoice = flags.invoice
  if (!invoice) {
    console.log(command.help())
    return
  }

  const wallet = await useWallet(dir)
  await payBolt11(wallet, invoice, flags, unitFlag(flags.unit))
}

// The melt, from quote to settled, shared with `cashme zap` — which is this command with
// an lnurl lookup in front of it. Returns whether the invoice was paid: everything that
// declines to pay one says so and leaves the wallet untouched.
//
// `flags` is read for --mint and --yes only, so a caller that has neither can pass {}.
//
// The unit is a separate argument rather than another flag read off `flags`, because
// choosing one is a `withdraw` privilege: only the commands that talk to a mint about a
// denomination — this one and `deposit` — offer --unit. `zap` calls this without a unit
// and so always melts sats, which is the only thing an lnurl amount in millisats can mean.
export async function payBolt11(wallet, invoice, flags = {}, unit = DEFAULT_UNIT) {
  // The mint quotes the fee, so it has to be chosen before the cost is known. Without
  // --mint, take the one holding the most of this unit and let the quote decide whether
  // that is enough.
  const mintUrl = flags.mint ? await useMint(wallet, flags.mint) : await richestMint(wallet, unit)
  if (!mintUrl) {
    console.log(`This wallet holds no ${unit} to pay with.`)
    return false
  }

  // Quote first: it touches no proofs, and it is the mint — not the invoice — that says
  // what the payment totals.
  const quote = await quoteMelt(wallet, mintUrl, invoice, unit)

  // The mint was asked to quote in `unit`; this is its answer being checked. A mint that
  // answered in something else would be spending proofs the caller never priced.
  if (quote.unit !== unit) {
    console.log(`${mintUrl} quoted this invoice in ${quote.unit}, not ${unit}.`)
    console.log(`Nothing was spent. Use a mint that melts in ${unit}.`)
    return false
  }

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
    return false
  }

  // coco does not budget for a per-input fee when it swaps before melting, so some melts
  // cannot work here whatever we hold. Stop before reserving proofs for one of those.
  const feasible = meltFeasibility(total, feePpk)
  if (!feasible.possible) {
    console.log(`\nThis mint takes ${feasible.fee} ${quote.unit} per proof spent, and coco does`)
    console.log('not budget for that when it swaps before melting — so a payment totalling')
    console.log(`less than ${feasible.floor} ${quote.unit} here always comes up short by the fee.`)
    console.log('Nothing was spent. Use a mint with no input fee, or a larger invoice.')
    return false
  }

  if (!flags.yes && !(await confirm('Pay this invoice?'))) {
    console.log('Cancelled. Nothing was spent.')
    return false
  }

  // Reserve, then pay. Until execute the proofs come back if anything goes wrong; after
  // it, only the mint can say how the payment ended.
  const prepared = await prepareMelt(wallet, quote)
  let result
  try {
    result = await payInvoice(wallet, prepared)
  } catch (err) {
    await cancelMelt(wallet, prepared, 'cashme withdraw failed').catch(() => {})
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
  return true
}
