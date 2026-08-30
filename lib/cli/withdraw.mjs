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
//
// This is the printing half. What it prints is decided by plan() below, so that the
// full-screen UI can put the same decision in a pane instead of on stdout without
// restating any of the rules.
export async function payBolt11(wallet, invoice, flags = {}, unit = DEFAULT_UNIT) {
  const plan = await planMelt(wallet, invoice, flags, unit)

  for (const line of plan.lines) console.log(line)
  if (!plan.payable) return false

  if (!flags.yes && !(await confirm('Pay this invoice?'))) {
    console.log('Cancelled. Nothing was spent.')
    return false
  }

  const result = await settleMelt(wallet, plan)

  console.log('Paid.')
  if (result.changeAmount !== undefined) {
    console.log(`Change returned: ${result.changeAmount} ${plan.unit}`)
  }
  if (result.effectiveFee !== undefined) {
    console.log(`Fee actually paid: ${result.effectiveFee} ${plan.unit}`)
  }
  await showBalances(wallet, 'New Balance')
  return true
}

// Everything knowable about a melt before anything is spent: which mint, what the mint
// quoted, whether this wallet can cover it, and the reasons when it cannot.
//
// Nothing here touches a proof, so a caller may plan a melt and never settle it — which is
// what a confirmation step is. `lines` is the explanation in the order it should be read;
// `payable` is whether there is anything left to confirm.
export async function planMelt(wallet, invoice, flags = {}, unit = DEFAULT_UNIT) {
  const lines = []
  const decline = (extra = []) => ({ payable: false, unit, lines: [...lines, ...extra] })

  // The mint quotes the fee, so it has to be chosen before the cost is known. Without
  // --mint, take the one holding the most of this unit and let the quote decide whether
  // that is enough.
  const mintUrl = flags.mint ? await useMint(wallet, flags.mint) : await richestMint(wallet, unit)
  if (!mintUrl) return decline([`This wallet holds no ${unit} to pay with.`])

  // Quote first: it touches no proofs, and it is the mint — not the invoice — that says
  // what the payment totals.
  const quote = await quoteMelt(wallet, mintUrl, invoice, unit)

  // The mint was asked to quote in `unit`; this is its answer being checked. A mint that
  // answered in something else would be spending proofs the caller never priced.
  if (quote.unit !== unit) {
    return decline([
      `${mintUrl} quoted this invoice in ${quote.unit}, not ${unit}.`,
      `Nothing was spent. Use a mint that melts in ${unit}.`
    ])
  }

  const total = Number(quote.amount) + Number(quote.fee_reserve)
  // The mint's balance in the quote's own unit: what it holds in any other unit cannot
  // pay this invoice.
  const held = (await balances(wallet, { units: [quote.unit] }))[mintUrl]?.[quote.unit]
  const spendable = Number(held?.spendable ?? 0)
  const feePpk = await inputFeePpk(wallet, mintUrl, quote.unit)

  lines.push(`Paying from ${mintUrl}`)
  lines.push(`  invoice     ${quote.amount} ${quote.unit}`)
  lines.push(`  fee reserve ${quote.fee_reserve} ${quote.unit}`)
  lines.push(`  total       ${total} ${quote.unit} of ${spendable} available`)
  if (feePpk) lines.push(`  mint fee    ${feePpk} ppk per proof spent`)
  lines.push("The fee reserve is the mint's worst case; whatever is left comes back as change.")

  const shape = { mintUrl, quote, unit: quote.unit, total, spendable, feePpk }

  if (spendable < total) {
    return {
      ...shape,
      payable: false,
      lines: [...lines, `Not enough at ${mintUrl} to cover the invoice and its fee reserve.`]
    }
  }

  // coco does not budget for a per-input fee when it swaps before melting, so some melts
  // cannot work here whatever we hold. Stop before reserving proofs for one of those.
  const feasible = meltFeasibility(total, feePpk)
  if (!feasible.possible) {
    return {
      ...shape,
      payable: false,
      lines: [
        ...lines,
        `\nThis mint takes ${feasible.fee} ${quote.unit} per proof spent, and coco does`,
        'not budget for that when it swaps before melting — so a payment totalling',
        `less than ${feasible.floor} ${quote.unit} here always comes up short by the fee.`,
        'Nothing was spent. Use a mint with no input fee, or a larger invoice.'
      ]
    }
  }

  return { ...shape, payable: true, lines }
}

// Reserve, then pay. Until execute the proofs come back if anything goes wrong; after it,
// only the mint can say how the payment ended — so a failure here cancels, and a failure
// after it is the mint's answer, not ours to undo.
export async function settleMelt(wallet, plan) {
  const prepared = await prepareMelt(wallet, plan.quote)
  try {
    return await payInvoice(wallet, prepared)
  } catch (err) {
    await cancelMelt(wallet, prepared, 'cashme withdraw failed').catch(() => {})
    throw err
  }
}
