import { useWallet } from './session.mjs'
import { showBalances } from './ui.mjs'

export async function run({ dir }) {
  const wallet = await useWallet(dir)
  const reserved = await showBalances(wallet)
  if (reserved.length) {
    console.log('Reserved proofs are in flight — sent, but not yet confirmed as claimed.')
    console.log('Every cashme run sweeps them: claimed ones are settled, the rest reclaimed.')
  }
}
