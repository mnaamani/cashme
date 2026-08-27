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

  // A token can only be spent at the mint that issued its proofs, so pick one mint rather
  // than pooling. The fee is charged on top of `amount` and is known only once the send is
  // prepared, so a mint holding exactly `amount` can still be rejected below.
  const mintUrl = flags.mint
    ? await useMint(wallet, flags.mint)
    : await mintWithBalance(wallet, amount)

  if (!mintUrl) {
    console.log('Insufficient balance at any single mint')
    return
  }
  console.log(`Spending from ${mintUrl}`)

  // Prepare before touching bluetooth: a spend that cannot happen — too little here once
  // the fee is counted — should fail now, not after a wait for a neighbour.
  const prepared = await prepareSend(wallet, mintUrl, amount)
  const fee = prepared.fee
  console.log(`sending ${amount} sat${Number(fee) ? ` (+ ${fee} sat mint fee)` : ''}`)

  // Proofs are reserved and no token exists yet: the one place the run must give up
  // cleanly.
  const interrupt = interrupted()

  let deliver
  try {
    deliver = await findNeighbour(pubKey, { cancelled: interrupt.promise })
  } catch (err) {
    // No neighbour, or the user gave up: hand the proofs back, or they stay out of the
    // balance until a later run sweeps them.
    await cancelSend(wallet, prepared)
    throw err
  } finally {
    interrupt.release()
  }

  // From here the token exists, so the operation must be settled, not cancelled.
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
