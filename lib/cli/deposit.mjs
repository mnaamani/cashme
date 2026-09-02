import { useMint, mintTokens } from '../manager.mjs'
import { note } from '../notes.mjs'
import { useWallet } from './session.mjs'
import { showBalances, showInvoice, amountFlag, unitFlag, mintFlag } from './ui.mjs'

export async function run({ dir, flags, command }) {
  if (!flags.amount) {
    console.log(command.help())
    return
  }
  const amount = amountFlag(flags.amount)
  // Where a unit enters the wallet: what the mint issues here is what the wallet then
  // holds, and everything downstream reads the unit off the proofs. `withdraw` and `give`
  // name one too, but only to pick which of those balances they move.
  const unit = unitFlag(flags.unit)
  const wallet = await useWallet(dir)
  const mintUrl = await useMint(wallet, await mintFlag(wallet, flags.mint))
  note(`minting ${amount} ${unit} at ${mintUrl}`)
  await mintTokens(wallet, mintUrl, amount, {
    unit,
    onQuote: (quote) => showInvoice(quote.request)
  })
  // stderr, like everything else here: stdout is the invoice, so `cashme deposit -a 100 |
  // pbcopy` hands over a payable string and nothing else.
  await showBalances(wallet, 'New Balance', { stderr: true })
}
