import { useMint, mintTokens } from '../manager.mjs'
import { DEFAULT_MINT_URL } from '../constants.mjs'
import { useWallet } from './session.mjs'
import { showBalances, showInvoice, sats } from './ui.mjs'

export async function run({ dir, flags, command }) {
  if (!flags.sats) {
    console.log(command.help())
    return
  }
  const amount = sats(flags.sats)
  const wallet = await useWallet(dir)
  const mintUrl = await useMint(wallet, flags.mint || DEFAULT_MINT_URL)
  console.error(`minting ${amount} sat at ${mintUrl}`)
  await mintTokens(wallet, mintUrl, amount, { onQuote: (quote) => showInvoice(quote.request) })
  await showBalances(wallet, 'New Balance')
}
