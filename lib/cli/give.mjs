import { findNeighbour } from '../ble.mjs'
import { findPeer } from '../dht.mjs'
import { dhtIdentity, warnEphemeral } from './address.mjs'
import { copyToClipboard, CLIPBOARD_PROGRAMS } from '../clipboard.mjs'
import { note, write } from '../notes.mjs'
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
  // Which of the two ways to reach someone who is not standing here: a radio link to a
  // neighbour, or a holepunched one to a peer anywhere.
  const over = flags.dht ? 'the hyperdht' : 'bluetooth'
  warnEphemeral(flags)
  // --print, and --qr and --copy which imply it, hand the token to the user instead of
  // putting it on a wire — the one way to give with nobody named.
  const offline = Boolean(flags.print || flags.qr || flags.copy)
  if ((!pubKey && !offline) || !flags.amount) {
    console.log(command.help())
    return
  }

  // Both at once is a contradiction: one of them has to be what the run does, and the one
  // the user typed last is not knowable here, so say which won rather than quietly picking.
  if (pubKey && offline) {
    note(`--public-key is ignored: the token is being handed over, not sent over ${over}`)
  }

  const amount = amountFlag(flags.amount)
  // A mint may hold more than one unit and they never add up, so the unit picks the
  // balance being spent as much as the amount does. Everything below — the mint chosen,
  // the fee, the token — is denominated in it.
  const unit = unitFlag(flags.unit)
  const wallet = await useWallet(dir)
  // Every line this command says about itself goes to stderr, because stdout is where the
  // token lands: `cashme give -a 21 --print > token.txt` should hold the token and nothing
  // else. Nothing is printed to stdout at all until there is a token to print.
  await showBalances(wallet, 'Current Balance', { stderr: true })

  // A token can only be spent at the mint that issued its proofs, so pick one mint rather
  // than pooling. A named mint goes through the same balance check as a chosen one, so
  // naming the wrong one says so here rather than through coco's 'Not enough proofs to
  // send'. The fee is charged on top of `amount` and is known only once the send is
  // prepared, so a mint holding exactly `amount` can still be rejected below.
  const named = flags.mint ? await useMint(wallet, flags.mint) : null
  const mintUrl = await mintWithBalance(wallet, amount, unit, named && [named])

  if (!mintUrl) {
    note(`Insufficient ${unit} balance at ${named ?? 'any single mint'}`)
    return
  }
  note(`Spending from ${mintUrl}`)

  // Prepare before touching the network: a spend that cannot happen — too little here once
  // the fee is counted — should fail now, not after a wait for a peer.
  const prepared = await prepareSend(wallet, mintUrl, amount, unit)
  const fee = prepared.fee
  note(`sending ${amount} ${unit}${Number(fee) ? ` (+ ${fee} ${unit} mint fee)` : ''}`)

  if (offline) return handoff(wallet, prepared, flags)

  // Proofs are reserved and no token exists yet: the one place the run must give up
  // cleanly.
  const interrupt = interrupted()

  // Same handover over either wire; only finding the receiver differs. The hyperdht also
  // has us present a key to them — this wallet's own, unless --ephemeral (see address.mjs)
  // — which bluetooth has no equivalent of, so the choice is made only on that branch.
  const reach = flags.dht
    ? (key, opts) => findPeer(key, { ...opts, keyPair: dhtIdentity(wallet, flags) })
    : findNeighbour

  let deliver
  try {
    deliver = await reach(pubKey, { cancelled: interrupt.promise })
  } catch (err) {
    // Nobody there, or the user gave up: hand the proofs back, or they stay out of the
    // balance until a later run sweeps them.
    await cancelSend(wallet, prepared)
    throw err
  } finally {
    interrupt.release()
  }

  // From here the token exists, so the operation must be settled, not cancelled.
  const { operation, token } = await executeSend(wallet, prepared)
  await showBalances(wallet, 'Remaining Balance', { stderr: true })

  // we can only use deliver once, so send everything in one shot
  const received = await deliver(token)
  if (received) {
    await finalizeSend(wallet, operation)
    return
  }

  // No ACK: the receiver may or may not have claimed the token. Try to swap the proofs
  // back right away; if the mint has already burnt them the receiver got them.
  note('no confirmation from receiver, trying to reclaim the proofs...')
  try {
    await reclaimSend(wallet, operation)
    await showBalances(wallet, 'Reclaimed. Balance', { stderr: true })
  } catch (err) {
    note(`could not reclaim: ${err.message}`)
    note(
      'the send is still tracked — retry later, the proofs are spent only if the receiver claimed them'
    )
  }
}

// Delivery by copy-paste or camera: print the token and let the user carry it over
// whatever channel they trust. Nothing comes back the way a bluetooth ACK does, so the
// mint is the only witness — poll it until the proofs are spent.
//
// Giving up here reclaims nothing on purpose. The token is out of our hands and may yet be
// claimed, so the send stays pending with its proofs in flight, for `cashme pending` to
// settle or hand back once the user knows which happened.
async function handoff(wallet, prepared, flags) {
  const { operation, token } = await executeSend(wallet, prepared)
  await showBalances(wallet, 'Remaining Balance', { stderr: true })
  showToken(token, { qr: Boolean(flags.qr) })

  // Printed either way, even when it is on the clipboard: a clipboard holds one thing at a
  // time, and the text above is the copy that survives the next thing copied.
  if (flags.copy) {
    const copier = await copyToClipboard(token)
    if (copier) note(`copied to the clipboard (${copier})`)
    else note(`could not reach a clipboard — tried ${CLIPBOARD_PROGRAMS}`)
  }

  note('waiting for the receiver to claim it — Ctrl-C to stop waiting')
  const interrupt = interrupted()
  let waited = false
  let claimed
  try {
    claimed = await awaitSendClaim(wallet, operation, {
      cancelled: interrupt.promise,
      // A dot per poll on one line, so the QR above stays on screen.
      onPoll: () => {
        waited = true
        write('.')
      }
    })
  } finally {
    interrupt.release()
    // Close the line of dots, and only that line: a claim on the first poll never opened one.
    if (waited) write('\n')
  }

  if (claimed) {
    await showBalances(wallet, 'New Balance', { stderr: true })
    return
  }

  note(`still unclaimed — ${operation.amount} ${operation.unit} stays out of the balance`)
  note('until the receiver takes it. `cashme pending` settles it, or --reclaim hands it back.')
}
