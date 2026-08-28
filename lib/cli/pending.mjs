// Sends with a token out in the world and no answer yet. `give` over bluetooth settles
// itself on the ACK; a token handed over out of band has no ACK, so a send the user walked
// away from sits here with its proofs reserved — spendable by nobody until we ask the mint
// who has them.
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
    // balance when the swap happened. What is still reserved is what the token is worth.
    const at = `${operation.amount} ${operation.unit} at ${operation.mintUrl}`

    // Asking the mint first is what makes this safe to run at any time: proofs it reports
    // spent are the receiver's, and the send is finalized rather than left half-tracked.
    const current = await refreshSend(wallet, operation.id)
    if (current.state !== 'pending') {
      console.log(`  claimed  ${at}`)
      settled++
      continue
    }

    if (!flags.reclaim) {
      console.log(`  unclaimed ${at} — --reclaim takes it back`)
      continue
    }

    // A nutzap's outputs are locked to the recipient's key (NUT-11): the mint will not
    // swap them for us however long they go unclaimed, so there is nothing to take back.
    if (operation.method === 'p2pk') {
      console.log(`  unclaimed ${at} — locked to the recipient, cannot be reclaimed`)
      continue
    }

    try {
      await reclaimSend(wallet, operation)
      console.log(`  reclaimed ${at}`)
      settled++
    } catch (err) {
      // The mint refusing the swap usually means the receiver got there first, between the
      // check above and now.
      console.log(`  could not reclaim ${at}: ${err.message}`)
    }
  }

  if (settled) await showBalances(wallet, 'Balance')
}
