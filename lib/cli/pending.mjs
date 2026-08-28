// Sends with a token out in the world and no answer yet. `give` over bluetooth settles
// itself on the ACK; a token handed over out of band has no ACK, so a send the user walked
// away from sits here, its proofs promised to someone else and in nobody's balance, until
// we ask the mint who has them.
import { pendingSends, refreshSend, reclaimSend } from '../manager.mjs'
import { useWallet } from './session.mjs'
import { showBalances } from './ui.mjs'

export async function run({ dir, flags }) {
  const wallet = await useWallet(dir)
  const pending = await pendingSends(wallet)

  if (!pending.length) {
    console.log('No sends waiting to settle.')
    return
  }

  console.log(`${pending.length} send${pending.length === 1 ? '' : 's'} waiting to settle:`)

  let settled = 0
  for (const operation of pending) {
    // The token's own amount, not inputAmount: a send that had to swap for change keeps
    // the original input on the operation, and those bigger proofs went back to the
    // balance when the swap happened. What is still in flight is what the token is worth.
    const held = `${operation.amount} ${operation.unit} at ${operation.mintUrl}`
    // One column of verdicts down the left, so a list of several reads at a glance.
    const say = (verdict, why = '') => console.log(`  ${verdict.padEnd(9)} ${held}${why}`)

    // Asking the mint first is what makes this safe to run at any time: proofs it reports
    // spent are the receiver's, and the send is finalized rather than left half-tracked.
    const current = await refreshSend(wallet, operation.id)
    if (current.state !== 'pending') {
      say('claimed')
      settled++
      continue
    }

    if (!flags.reclaim) {
      say('unclaimed', ' — --reclaim takes it back')
      continue
    }

    // A nutzap's outputs are locked to the recipient's key (NUT-11): the mint will not
    // swap them for us however long they go unclaimed, so there is nothing to take back.
    if (operation.method === 'p2pk') {
      say('unclaimed', ' — locked to the recipient, cannot be reclaimed')
      continue
    }

    try {
      await reclaimSend(wallet, operation)
      say('reclaimed')
      settled++
    } catch (err) {
      // The mint refusing the swap usually means the receiver got there first, between the
      // check above and now.
      say('stuck', ` — could not reclaim: ${err.message}`)
    }
  }

  if (settled) await showBalances(wallet, 'Balance')
}
