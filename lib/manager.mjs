import './polyfills.mjs'
import { initializeCoco, getEncodedToken, getTokenMetadata, DEFAULT_UNIT } from '@cashu/coco-core'
import { FileRepositories } from './coco-store.mjs'
import { newSeed, seedToHex, seedFromHex } from './seed.mjs'
import { normalizeMintUrl } from './mint-url.mjs'

// coco's default unit ('sat'), re-exported so the CLI names it the same way the wallet does.
export { DEFAULT_UNIT }

// coco (@cashu/coco-core) owns the wallet; lib/coco-store.mjs persists its repositories.
// This module is the thin part on top — opening a wallet and the flows the CLI drives — so
// lib/cli/ never has to know about services, watchers or operation states.

// coco finalizes mint operations from a background processor. A CLI is not long-lived, so
// it drives that itself: poll the quote until the mint says paid, then until the operation
// settles. Ten minutes for each half — long enough for a human to pay an invoice.
const POLL_MS = 3000
const POLL_ATTEMPTS = 200

export async function openWallet(dir, { wait = false } = {}) {
  const repos = new FileRepositories(dir, { wait })
  await repos.init()

  if (!repos.seedHex) {
    // From the first operation onwards, so `cashme restore` can always ask a mint to
    // re-sign what it issued us.
    repos.seedHex = seedToHex(newSeed())
    repos.save()
  }
  const seed = seedFromHex(repos.seedHex)

  // initializeCoco also sweeps unfinished send and melt operations — proofs the receiver
  // took are settled, the rest reclaimed — at the cost of a mint round trip when any are
  // outstanding.
  let manager
  try {
    manager = await initializeCoco({ repo: repos, seedGetter: () => Promise.resolve(seed) })
  } catch (err) {
    // The lock is held from init() onwards; a wallet we failed to open must not keep the
    // next run out.
    repos.close()
    throw err
  }

  // coco leaves prepared operations behind (see sweepPreparedOperations), so do this here,
  // where every command comes through, rather than trusting each one to remember.
  const reclaimed = await sweepPreparedOperations({ manager })

  return {
    manager,
    repos,
    dir,
    reclaimed,
    // coco's watchers keep the loop alive, so a command that is done has to say so.
    async close() {
      await manager.dispose()
      repos.close()
    }
  }
}

// Give back the proofs held by operations that were prepared and never executed.
//
// coco's own recovery (recoverPendingOperations) sweeps init, executing and pending
// operations but deliberately skips prepared ones — "Found stale prepared operation, user
// can rollback manually". Such an operation has reserved inputs and produced nothing, left
// by a run that died between prepare and execute, and its proofs stay reserved forever.
// The wallet lock means no live run owns one, so every one found here is stale.
//
// Prepared receives are left alone: they reserve nothing of ours, and what they hold is an
// incoming token that may still be claimable. Returns what was given back, so the CLI can
// say so rather than the balance quietly changing.
export async function sweepPreparedOperations({ manager }) {
  const reclaimed = []
  for (const [kind, ops] of [
    ['send', manager.ops.send],
    ['payment', manager.ops.melt]
  ]) {
    for (const operation of await ops.listPrepared()) {
      try {
        await ops.cancel(operation.id)
        reclaimed.push({
          kind,
          id: operation.id,
          // What was reserved — amount plus fees, not what the receiver or invoice
          // would have got.
          amount: operation.inputAmount ?? operation.amount,
          unit: operation.unit
        })
      } catch (err) {
        // Not fatal: the user's command still runs, just with less to spend.
        console.error(`[wallet] could not reclaim the ${kind} ${operation.id}: ${err.message}`)
      }
    }
  }
  return reclaimed
}

// coco needs a mint trusted before it will mint or receive against it. Naming a mint is
// taken as the decision to trust it.
export async function useMint(wallet, mintUrl) {
  const url = normalizeMintUrl(mintUrl)
  if (!(await wallet.manager.mint.isTrustedMint(url))) {
    await wallet.manager.mint.addMint(url, { trusted: true })
  }
  return url
}

// Deposit: quote a bolt11 invoice, print it, wait for the mint to see it paid and issue
// the proofs.
export async function mintTokens(wallet, mintUrl, amount) {
  const { manager } = wallet
  const quote = await manager.quotes.mint.create({ mintUrl, amount, method: 'bolt11' })
  console.log('pay lightning invoice:', quote.request)

  const operation = await manager.ops.mint.prepare({ quote, amount })

  // One loop: coco tracks both halves. `checkPayment` asks the mint where the quote stands
  // and reconciles it, as a category — 'waiting' (unpaid), 'ready' (paid, not redeemed),
  // 'completed' (proofs in hand), 'terminal' (the mint refusing). `finalize` then executes
  // a pending operation, recovers an executing one, and hands back a finished one as is —
  // so racing coco's own processor is harmless.
  let paid = false
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    let check = null
    try {
      check = await manager.ops.mint.checkPayment(operation.id)
    } catch (err) {
      // checkPayment insists the operation is pending, and the processor may have moved it
      // on since the last pass. That race alone is ignored — finalize below reads the truth.
      if ((await manager.ops.mint.get(operation.id))?.state === 'pending') throw err
    }

    if (check?.category === 'terminal') {
      throw new Error(check.terminalFailure?.reason ?? 'the mint refused to issue the proofs')
    }
    if (check?.category === 'waiting') {
      console.error('invoice not paid yet, waiting...')
      await sleep(POLL_MS)
      continue
    }

    if (!paid) console.error('Invoice paid.')
    paid = true

    const current = await manager.ops.mint.finalize(operation.id)
    if (current.state === 'finalized') return current
    if (current.state === 'failed') {
      throw new Error(current.terminalFailure?.reason ?? current.error ?? 'mint operation failed')
    }
    await sleep(POLL_MS)
  }
  throw new Error(
    paid
      ? 'the mint did not issue the proofs in time — run `cashme balance` later'
      : 'the invoice was not paid in time — deposit again when you can'
  )
}

// Two steps on purpose: prepare reserves the inputs and works out the fee, so an
// impossible spend fails before the CLI goes looking for a neighbour rather than after.
// `amount` is what the receiver gets; the mint's swap fee comes off our balance on top.
export function prepareSend(wallet, mintUrl, amount) {
  return wallet.manager.ops.send.prepare({ mintUrl, amount })
}

// Produce the token. From here the proofs are in flight and the operation must be settled,
// not cancelled.
export async function executeSend(wallet, prepared) {
  const { operation, token } = await wallet.manager.ops.send.execute(prepared)
  return { operation, token: getEncodedToken(token) }
}

// Reserve inputs for a send whose outputs only `pubkey` can spend (NUT-11 P2PK). Used by
// `nutzap`, which locks the ecash to the recipient's nostr key so it can be published
// where anyone can read it.
//
// The lock has no refund path: once executed, these proofs are the recipient's whether
// they ever claim them or not — reclaimSend cannot swap them back, because the mint now
// wants a signature only they can make. So the caller must be sure it can deliver before
// it executes.
export function prepareP2pkSend(wallet, mintUrl, amount, pubkey) {
  return wallet.manager.ops.send.prepare({ mintUrl, amount, target: { type: 'p2pk', pubkey } })
}

// executeSend, but handing back the token as coco built it. A nutzap carries the proofs
// themselves in the event's tags, not an encoded `cashuB...` string.
export function executeSendProofs(wallet, prepared) {
  return wallet.manager.ops.send.execute(prepared)
}

// Give the reserved inputs back. Only before the token exists; after that, reclaimSend.
export function cancelSend(wallet, prepared) {
  return wallet.manager.ops.send.cancel(prepared.id)
}

// The receiver acknowledged: the proofs are theirs, stop tracking them as ours.
export function finalizeSend(wallet, operation) {
  return wallet.manager.ops.send.finalize(operation.id)
}

// No acknowledgement: try to swap the proofs back. Throws if the receiver did claim them
// after all, in which case the mint has already burnt them.
export function reclaimSend(wallet, operation) {
  return wallet.manager.ops.send.reclaim(operation.id)
}

// --- melt ------------------------------------------------------------------------------

// What the mint would charge to pay this invoice. Commits nothing — no proofs are touched.
export function quoteMelt(wallet, mintUrl, invoice) {
  return wallet.manager.quotes.melt.create({
    mintUrl,
    method: 'bolt11',
    methodData: { invoice }
  })
}

// coco swaps before melting once the proofs it selects reach this multiple of what the
// melt needs (SWAP_THRESHOLD_NUMERATOR/_DENOMINATOR in
// packages/core/infra/handlers/melt/MeltBolt11Handler.utils.ts). Kept as integers, as coco
// does: in floating point the comparison below lands a sat low and waves through melts
// that cannot work.
const SWAP_THRESHOLD_NUMERATOR = 11
const SWAP_THRESHOLD_DENOMINATOR = 10

// What the mint charges per input proof, in parts per thousand (NUT-02), for the keyset a
// melt would spend. Zero for a mint with no input fee — the only kind coco melts from
// reliably, see meltFeasibility. Takes the highest of the unit's active keysets, since coco
// picks which one to spend.
export async function inputFeePpk(wallet, mintUrl, unit = 'sat') {
  const keysets = await wallet.repos.keysetRepository.getKeysetsByMintUrl(mintUrl)
  const active = keysets.filter((keyset) => keyset.unit === unit && keyset.active)
  const relevant = active.length ? active : keysets.filter((keyset) => keyset.unit === unit)
  return relevant.reduce((most, keyset) => Math.max(most, keyset.feePpk || 0), 0)
}

// Can this melt succeed at all?
//
// coco swaps before melting once the selected proofs reach SWAP_THRESHOLD × total, and
// builds that swap to send the whole selected amount — so a per-input fee lands on top and
// the swap comes up short. coco knows; MeltBolt11Handler.ts says so itself (commit
// 3252aa3c): "FIXME: This relies on the 10% swap threshold buffer to cover the future melt
// input fee." In practice the threshold reserves nothing extra, so on a fee-charging mint
// the fee is always on top: the selection has to land in [total + fee,
// total × SWAP_THRESHOLD), a window that is empty unless total exceeds ten times the fee.
//
// So this rules out the melts that certainly cannot happen, letting `pay` refuse them
// before reserving anything. Above the floor a melt can still fail — the fee grows with
// the number of proofs, unknowable until coco selects them — but coco rolls those back
// cleanly and payInvoice explains them.
//
// Verified against testnut (input_fee_ppk 100): 4 and 10 sat fail, 20 sat pays.
// test/melt-fee.test.mjs pins those three.
export function meltFeasibility(total, feePpk) {
  const amount = Number(total)
  if (!feePpk) return { possible: true, floor: 0, fee: 0 }

  // NUT-02: the fee is ceil(inputs × ppk / 1000), so one input already costs this much.
  const fee = Math.ceil(feePpk / 1000)
  // The window is non-empty when total × NUM/DEN > total + fee, i.e. when
  // total × (NUM − DEN) > fee × DEN.
  const floor =
    Math.floor(
      (fee * SWAP_THRESHOLD_DENOMINATOR) / (SWAP_THRESHOLD_NUMERATOR - SWAP_THRESHOLD_DENOMINATOR)
    ) + 1
  return { possible: amount >= floor, floor, fee }
}

// Reserve the inputs for a quoted payment. Still reversible: nothing has gone to the mint
// yet, so `cancelMelt` gives the proofs straight back.
export function prepareMelt(wallet, quote) {
  return wallet.manager.ops.melt.prepare({ quote })
}

export function cancelMelt(wallet, prepared, reason) {
  return wallet.manager.ops.melt.cancel(prepared.id, reason)
}

// Pay. The mint may settle at once or leave the payment in flight, in which case the
// operation is refreshed until it lands — the wallet must not be closed thinking it is
// done. A pending melt is NOT a failure: the proofs are spent at the mint and the payment
// may yet succeed. Only the mint can say, which is what refresh asks it.
export async function payInvoice(wallet, prepared) {
  let executed
  try {
    executed = await wallet.manager.ops.melt.execute(prepared)
  } catch (err) {
    throw explainMeltFailure(err, prepared)
  }
  if (executed.state === 'finalized') return executed

  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_MS)
    const current = await wallet.manager.ops.melt.refresh(executed.id)
    if (current.state === 'finalized') return current
    if (current.state === 'failed') {
      throw new Error(current.error ?? 'the mint could not pay the invoice')
    }
  }
  throw new Error(
    'the payment is still in flight — run `cashme balance` later to see how it settled'
  )
}

// The failure meltFeasibility could not rule out up front: coco 2.0.0 builds the swap's
// outputs at amount + fee_reserve + swap_fee and reserves the same as inputs, but the mint
// takes its fee out of those inputs, so the swap is short by exactly the fee and cashu-ts
// refuses it. coco rolls back cleanly and nothing is lost — but the user is left with
// "Not enough funds available to send" and a full wallet, so explain it.
function explainMeltFailure(err, prepared) {
  const shortByFee =
    /Not enough funds available/i.test(err.message) &&
    prepared.needsSwap &&
    Number(prepared.swap_fee) > 0
  if (!shortByFee) return err

  return new Error(
    `this mint charges a fee per input, and coco does not budget for it when a melt needs ` +
      `a swap: it reserved ${prepared.inputAmount} for a swap that costs ` +
      `${prepared.inputAmount} plus ${prepared.swap_fee} in fees. Nothing was spent — the ` +
      `payment was rolled back. A mint that charges no input fee will work.`,
    { cause: err }
  )
}

// What a token claims about itself, before touching the network. The mint url is
// attacker-controlled: callers check it against their own policy before receiving.
export function inspectToken(token) {
  const meta = getTokenMetadata(token)
  return { mintUrl: meta.mint, unit: meta.unit, amount: meta.amount }
}

// Receive a token. The issuing mint is whichever the token names, and has to be trusted
// before coco will swap against it.
export async function processToken(wallet, token) {
  const mintUrl = await useMint(wallet, inspectToken(token).mintUrl)
  await wallet.manager.wallet.receive(token)
  return mintUrl
}

// NUT-13 restore, as a repair: ask one mint to re-sign every secret our seed derives, to
// recover proofs it issued but this wallet never recorded.
export function restoreProofs(wallet, mintUrl) {
  return wallet.manager.wallet.restore(mintUrl)
}

// { mintUrl: { unit: { spendable, reserved, total, unit } } }
//
// Split by unit, because a mint can issue more than one and adding them together would
// report 30 for a mint holding 20 sat and 10 of something else.
export function balances(wallet, scope) {
  return wallet.manager.wallet.balances.byMintAndUnit(scope)
}

// One snapshot per unit, across every mint: { unit: { spendable, reserved, total, unit } }.
export function totalBalances(wallet, scope) {
  return wallet.manager.wallet.balances.totalByUnit(scope)
}

// The mint holding the most of `unit`, or null if none holds any. Used by `pay`, where the
// cost is not known until a mint has quoted it.
export async function richestMint(wallet, unit = DEFAULT_UNIT) {
  let best = null
  for (const [mintUrl, byUnit] of Object.entries(await balances(wallet, { units: [unit] }))) {
    const spendable = Number(byUnit[unit]?.spendable ?? 0)
    if (!best || spendable > best.spendable) best = { mintUrl, spendable }
  }
  return best && best.spendable > 0 ? best.mintUrl : null
}

// The first mint whose spendable balance in `unit` covers `amount`. Fees are not counted —
// they are known only once a send is prepared — so this is a filter, not a guarantee.
//
// `allowed`, when given, narrows the search to those mint urls: a nutzap is only worth
// anything at a mint the recipient trusts, so it cannot take just any mint holding enough.
export async function mintWithBalance(wallet, amount, unit = DEFAULT_UNIT, allowed = null) {
  const byMint = await balances(wallet, { units: [unit] })
  for (const [mintUrl, byUnit] of Object.entries(byMint)) {
    if (allowed && !allowed.includes(mintUrl)) continue
    if (Number(byUnit[unit]?.spendable ?? 0) >= amount) return mintUrl
  }
  return null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
