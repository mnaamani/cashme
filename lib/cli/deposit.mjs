import { useMint, mintTokens } from '../manager.mjs'
import { DEFAULT_MINT_URL } from '../constants.mjs'
import { useWallet } from './session.mjs'
import { showBalances, showInvoice, amountFlag, unitFlag } from './ui.mjs'

export async function run({ dir, flags, command }) {
  if (!flags.amount) {
    console.log(command.help())
    return
  }
  const amount = amountFlag(flags.amount)
  // The one place a unit is chosen, along with `withdraw`: what the mint issues here is
  // what the wallet then holds. Everything downstream reads the unit off the proofs.
  const unit = unitFlag(flags.unit)
  const wallet = await useWallet(dir)
  const mintUrl = await useMint(wallet, flags.mint || DEFAULT_MINT_URL)
  console.error(`minting ${amount} ${unit} at ${mintUrl}`)
  await mintTokens(wallet, mintUrl, amount, {
    unit,
    onQuote: (quote) => showInvoice(quote.request)
  })
  await showBalances(wallet, 'New Balance')
}
