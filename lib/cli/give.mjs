import { findNeighbour } from '../ble.mjs'
import {
  useMint,
  mintWithBalance,
  prepareSend,
  executeSend,
  cancelSend,
  finalizeSend,
  reclaimSend
} from '../manager.mjs'
import { useWallet, interrupted } from './session.mjs'
import { showBalances, sats } from './ui.mjs'

export async function run({ dir, flags, command }) {
  const pubKey = flags.publicKey
  if (!pubKey) {
    console.log(command.help())
    return
  }

  const amount = sats(flags.sats)
  const wallet = await useWallet(dir)
  await showBalances(wallet, 'Current Balance')

  // A token can only be spent at the mint that issued its proofs, so this picks one
  // mint rather than pooling. The mint's fee is charged on top of `amount`, and is only
  // known once the send is prepared, so a mint holding exactly `amount` can still be
  // rejected below — with the mint's own message, which says more than a guess would.
  const mintUrl = flags.mint
    ? await useMint(wallet, flags.mint)
    : await mintWithBalance(wallet, amount)

  if (!mintUrl) {
    console.log('Insufficient balance at any single mint')
    return
  }
  console.log(`Spending from ${mintUrl}`)

  // Prepare before touching bluetooth: this is where a spend that cannot happen — too
  // little at this mint once the fee is counted — fails, and failing now beats failing
  // after the user has waited for a neighbour to show up.
  const prepared = await prepareSend(wallet, mintUrl, amount)
  const fee = prepared.fee
  console.log(`sending ${amount} sat${Number(fee) ? ` (+ ${fee} sat mint fee)` : ''}`)

  // The bluetooth wait is where a `give` sits with proofs reserved and no token yet, so
  // it is the one place the run has to be able to give up cleanly.
  const interrupt = interrupted()

  let deliver
  try {
    deliver = await findNeighbour(pubKey, { cancelled: interrupt.promise })
  } catch (err) {
    // No neighbour, or the user gave up: hand the reserved proofs back before leaving,
    // or they stay locked out of the balance until something else releases them.
    await cancelSend(wallet, prepared)
    throw err
  } finally {
    interrupt.release()
  }

  // From here the proofs are in flight: the token exists, so the operation has to be
  // settled rather than cancelled.
  const { operation, token } = await executeSend(wallet, prepared)
  await showBalances(wallet, 'Remaining Balance')

  // we can only use deliver once, so send everything in one shot
  const received = await deliver(token)
  if (received) {
    await finalizeSend(wallet, operation)
    return
  }

  // No ACK: the receiver may or may not have claimed the token. Try to swap the proofs
  // back right away; if the mint has already burnt them the receiver got them.
  console.error('no confirmation from receiver, trying to reclaim the proofs...')
  try {
    await reclaimSend(wallet, operation)
    await showBalances(wallet, 'Reclaimed. Balance')
  } catch (err) {
    console.error('could not reclaim:', err.message)
    console.error(
      'the send is still tracked — retry later, the proofs are spent only if the receiver claimed them'
    )
  }
}
