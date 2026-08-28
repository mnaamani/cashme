import { pendingSends } from '../manager.mjs'
import { note } from '../notes.mjs'
import { useWallet } from './session.mjs'
import { showBalances } from './ui.mjs'

export async function run({ dir }) {
  const wallet = await useWallet(dir)
  // The balance itself is what this command produces, so it goes to stdout; everything
  // below explains it, and goes to stderr with the rest of what a run says.
  const reserved = await showBalances(wallet)
  if (reserved.length) {
    note('Reserved proofs are held by an operation this run has not finished with.')
  }

  // A send whose token is already out there holds proofs the mint has not been asked
  // about, and coco counts only ready ones — so that amount is in no figure above. Saying
  // nothing would make it look spent, when it is neither spent nor spendable yet.
  const pending = await pendingSends(wallet)
  if (!pending.length) return

  const byUnit = {}
  for (const operation of pending) {
    byUnit[operation.unit] = (byUnit[operation.unit] ?? 0) + Number(operation.amount)
  }
  const amounts = Object.entries(byUnit)
    .map(([unit, amount]) => `${amount} ${unit}`)
    .join(' and ')

  note(`${amounts} is in flight: sent, and not yet known to be claimed. It is in none of`)
  note('the figures above. `cashme pending` says what became of it.')
}
