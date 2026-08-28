import process from 'bare-process'
import { findNeighbour } from '../ble.mjs'
import { copyToClipboard, CLIPBOARD_PROGRAMS } from '../clipboard.mjs'
import {
  useMint,
  mintWithBalance,
  prepareSend,
  executeSend,
  cancelSend,
  finalizeSend,
  reclaimSend,
  awaitSendClaim
} from '../manager.mjs'
import { useWallet, interrupted } from './session.mjs'
import { showBalances, showToken, amountFlag, unitFlag } from './ui.mjs'

export async function run({ dir, flags, command }) {
  const pubKey = flags.publicKey
  // --print, and --qr and --copy which imply it, hand the token to the user instead of to
  // a neighbour's radio — the one way to give with nobody named.
  const offline = Boolean(flags.print || flags.qr || flags.copy)
  if ((!pubKey && !offline) || !flags.amount) {
    console.log(command.help())
    return
  }

  const amount = amountFlag(flags.amount)
  // A mint may hold more than one unit and they never add up, so the unit picks the
  // balance being spent as much as the amount does. Everything below — the mint chosen,
  // the fee, the token — is denominated in it.
  const unit = unitFlag(flags.unit)
  const wallet = await useWallet(dir)
  await showBalances(wallet, 'Current Balance')

  // A token can only be spent at the mint that issued its proofs, so pick one mint rather
  // than pooling. The fee is charged on top of `amount` and is known only once the send is
  // prepared, so a mint holding exactly `amount` can still be rejected below.
  const mintUrl = flags.mint
    ? await useMint(wallet, flags.mint)
    : await mintWithBalance(wallet, amount, unit)

  if (!mintUrl) {
    console.log('Insufficient balance at any single mint')
    return
  }
  console.log(`Spending from ${mintUrl}`)

  // Prepare before touching bluetooth: a spend that cannot happen — too little here once
  // the fee is counted — should fail now, not after a wait for a neighbour.
  const prepared = await prepareSend(wallet, mintUrl, amount, unit)
  const fee = prepared.fee
  console.log(`sending ${amount} ${unit}${Number(fee) ? ` (+ ${fee} ${unit} mint fee)` : ''}`)

  if (offline) return handoff(wallet, prepared, flags)

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

// Delivery by copy-paste or camera: print the token and let the user carry it over
// whatever channel they trust. Nothing comes back the way a bluetooth ACK does, so the
// mint is the only witness — poll it until the proofs are spent.
//
// Giving up here reclaims nothing on purpose. The token is out of our hands and may yet be
// claimed, so the send stays pending with its proofs reserved, for `cashme pending` to
// settle or hand back once the user knows which happened.
async function handoff(wallet, prepared, flags) {
  const { operation, token } = await executeSend(wallet, prepared)
  await showBalances(wallet, 'Remaining Balance')
  showToken(token, { qr: Boolean(flags.qr) })

  // Printed either way, even when it is on the clipboard: a clipboard is one paste from
  // being overwritten, and the text above is the only copy that survives that.
  if (flags.copy) {
    const copier = await copyToClipboard(token)
    if (copier) console.error(`copied to the clipboard (${copier})`)
    else console.error(`could not reach a clipboard — tried ${CLIPBOARD_PROGRAMS}`)
  }

  const interrupt = interrupted()
  let claimed
  try {
    console.error('waiting for the receiver to claim it — Ctrl-C to stop waiting')
    claimed = await awaitSendClaim(wallet, operation, {
      cancelled: interrupt.promise,
      // A dot per poll on one line, so the QR above stays on screen. Straight to stderr:
      // console.error is a separate write path in Bare and would land out of order.
      onPoll: () => process.stderr.write('.')
    })
  } finally {
    interrupt.release()
    process.stderr.write('\n')
  }

  if (claimed) {
    await showBalances(wallet, 'New Balance')
    return
  }

  console.error(
    `still unclaimed — ${operation.amount} ${operation.unit} stays reserved until the receiver`
  )
  console.error('takes it. `cashme pending` settles it, or hands it back with --reclaim.')
}
