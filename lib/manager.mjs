import './polyfills.mjs'
import { initializeCoco, getEncodedToken, getTokenMetadata, DEFAULT_UNIT } from '@cashu/coco-core'
import { FileRepositories } from './coco-store.mjs'
import { newSeed, seedToHex, seedFromHex } from './seed.mjs'
import { normalizeMintUrl } from './mint-url.mjs'

// coco's default unit ('sat'), re-exported so the CLI names it the same way the wallet does.
export { DEFAULT_UNIT }

// coco (@cashu/coco-core) owns the wallet: proofs, quotes, operations, history and NUT-13
// counters all live in its repositories, which we persist through lib/coco-store.mjs.
// This module is the thin part on top — opening a wallet, and the handful of flows the CLI
// drives — so bin.mjs never has to know about services, watchers or operation states.

// coco's mint operations are finalized by a background processor once the canonical quote
// says the invoice is paid. A CLI is not a long-lived app, so it has to drive that itself:
// refresh the quote until the mint says PAID, then wait for the operation to settle.
// Ten minutes of patience for each half — long enough for a human to pay an invoice.
const POLL_MS = 3000
const POLL_ATTEMPTS = 200

export async function openWallet(dir, { wait = false } = {}) {
  const repos = new FileRepositories(dir, { wait })
  await repos.init()

  if (!repos.seedHex) {
    // Deterministic secrets from the first operation onwards, so `cashme restore` can
    // always ask a mint to re-sign what it issued us.
    repos.seedHex = seedToHex(newSeed())
    repos.save()
  }
  const seed = seedFromHex(repos.seedHex)

  // initializeCoco also sweeps unfinished send and melt operations, so a run that died
  // mid-handoff is tidied up here: proofs the receiver took are settled, the rest reclaimed.
  // That costs a mint round trip at startup when anything is outstanding.
  let manager
  try {
    manager = await initializeCoco({ repo: repos, seedGetter: () => Promise.resolve(seed) })
  } catch (err) {
    // The lock is held from `init()` onwards; a wallet we failed to bring up must not keep
    // the next run out.
    repos.close()
    throw err
  }

  // coco leaves prepared operations behind (see sweepPreparedOperations), so the wallet is
  // only consistent once they are given back — do it here, where every command comes
  // through, rather than trusting each one to remember.
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
// coco's recovery, which initializeCoco runs, sweeps operations in init, executing and
// pending — but it deliberately skips prepared ones, logging "Found stale prepared
// operation, user can rollback manually" and moving on (recoverPendingOperations, for
// sends and melts alike). A prepared send or melt has reserved its inputs and produced
// nothing: left behind by a run that died between prepare and execute — Ctrl-C while
// `give` waits on bluetooth, a crash between `pay`'s quote and its payment — it locks
// those proofs out of the balance for good, and reports as reserved forever.
//
// Prepared receives are left alone on purpose. They reserve nothing of ours; what they
// hold is an incoming token that may still be claimable, so the way out of one is to
// finish it, not to roll it back.
//
// The wallet lock means no other cashme can be mid-operation while we hold it, so every
// prepared operation found here belongs to a run that is already gone. Returns what was
// given back, so the CLI can say so rather than the balance quietly changing.
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
          // What was reserved, which is the amount plus the fees — not what the receiver
          // or the invoice would have got.
          amount: operation.inputAmount ?? operation.amount,
          unit: operation.unit
        })
      } catch (err) {
        // Not fatal: the command the user actually asked for can still run, just with less
        // to spend than it could have had.
        console.error(`[wallet] could not reclaim the ${kind} ${operation.id}: ${err.message}`)
      }
    }
  }
  return reclaimed
}

// A mint has to be known and trusted before coco will mint or receive against it. The CLI
// takes the user naming a mint as the decision to trust it.
export async function useMint(wallet, mintUrl) {
  const url = normalizeMintUrl(mintUrl)
  if (!(await wallet.manager.mint.isTrustedMint(url))) {
    await wallet.manager.mint.addMint(url, { trusted: true })
  }
  return url
}

// Deposit: create a bolt11 quote, hand the invoice to the user, and wait for the mint to
// see it paid and issue the proofs.
export async function mintTokens(wallet, mintUrl, amount) {
  const { manager } = wallet
  const quote = await manager.quotes.mint.create({ mintUrl, amount, method: 'bolt11' })
  console.log('pay lightning invoice:', quote.request)

  const operation = await manager.ops.mint.prepare({ quote, amount })

  // One loop, because coco tracks both halves for us. `checkPayment` asks the mint where
  // the quote stands and reconciles a paid or issued one on the spot, reporting it as a
  // category rather than a state string: 'waiting' is an invoice nobody has paid yet,
  // 'ready' is paid and not yet redeemed, 'completed' is proofs in hand, 'terminal' is the
  // mint refusing. `finalize` then executes a pending operation, recovers an executing one
  // and hands back a finished one as it is — including when coco's own processor got there
  // first, so this no longer has to stay out of its way.
  let paid = false
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    let check = null
    try {
      check = await manager.ops.mint.checkPayment(operation.id)
    } catch (err) {
      // checkPayment insists the operation is still pending, and the processor may have
      // moved it on between one pass and the next. That race is the only thing ignored
      // here: there is nothing left to ask the mint, and finalize below reads the truth.
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

// Sending is two steps on purpose, and the CLI uses the gap between them.
//
// `prepareSend` reserves the inputs and works out the fee, which is where an impossible
// spend fails — before we go looking for a neighbour over bluetooth, rather than after.
// `amount` is what the receiver gets; the mint's swap fee comes out of our balance on top.
export function prepareSend(wallet, mintUrl, amount) {
  return wallet.manager.ops.send.prepare({ mintUrl, amount })
}

// Produce the token from a prepared send. From here the proofs are in flight, and the
// operation has to be settled one way or the other.
export async function executeSend(wallet, prepared) {
  const { operation, token } = await wallet.manager.ops.send.execute(prepared)
  return { operation, token: getEncodedToken(token) }
}

// Give the reserved inputs back. Only valid before the token exists — once it does, the
// way back is reclaimSend.
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

// Ask a mint what it would charge to pay this invoice. Quoting commits nothing: no proofs
// are touched, and the quote is what the CLI shows the user before they agree to spend.
export function quoteMelt(wallet, mintUrl, invoice) {
  return wallet.manager.quotes.melt.create({
    mintUrl,
    method: 'bolt11',
    methodData: { invoice }
  })
}

// coco decides to swap before melting whenever the proofs it selects reach this multiple
// of what the melt needs — SWAP_THRESHOLD_NUMERATOR / _DENOMINATOR in
// packages/core/infra/handlers/melt/MeltBolt11Handler.utils.ts. Kept as a ratio of
// integers, as coco does: in floating point the comparison below lands one sat low and
// waves through melts that cannot work.
const SWAP_THRESHOLD_NUMERATOR = 11
const SWAP_THRESHOLD_DENOMINATOR = 10

// What the mint charges per input proof, in parts per thousand (NUT-02), for the keyset a
// melt would spend. Zero for a mint that takes no input fee — the only kind coco melts
// from reliably, see meltFeasibility below. The highest of the unit's active keysets is
// used, since coco picks which one to spend and a low fee on another is no comfort.
export async function inputFeePpk(wallet, mintUrl, unit = 'sat') {
  const keysets = await wallet.repos.keysetRepository.getKeysetsByMintUrl(mintUrl)
  const active = keysets.filter((keyset) => keyset.unit === unit && keyset.active)
  const relevant = active.length ? active : keysets.filter((keyset) => keyset.unit === unit)
  return relevant.reduce((most, keyset) => Math.max(most, keyset.feePpk || 0), 0)
}

// Can this melt succeed at all?
//
// coco swaps before melting once the selected proofs reach SWAP_THRESHOLD × total, and
// builds that swap to send the whole selected amount — so the mint's per-input fee lands
// on top of it and the swap comes up short. coco knows; the handler says so itself, in
// packages/core/infra/handlers/melt/MeltBolt11Handler.ts (commit 3252aa3c, "docs(core):
// note melt swap fee buffer assumption"):
//
//   FIXME: This relies on the 10% swap threshold buffer to cover the future melt input
//   fee. Pathological fee/output combinations can still make the fee-inflated send side
//   exceed the amount validated above.
//
// In practice it is not only pathological combinations: the threshold decides whether to
// swap but reserves nothing extra, so on a fee-charging mint the fee is always on top. A
// melt therefore only goes through when the selection lands in
// [total + fee, total × SWAP_THRESHOLD), and that window is empty unless total is more
// than ten times the fee. Below that no combination of proofs works, which is what this
// rules out — the melts that certainly cannot happen, so `pay` can refuse them before
// reserving anything rather than after the mint has said no.
//
// Above the floor a melt can still fail, because the fee grows with the number of proofs
// spent and we cannot know that count until coco has selected them. Those are left to try:
// coco rolls a failed melt back cleanly, and payInvoice explains what happened.
//
// Verified against testnut (input_fee_ppk 100): 4 sat and 10 sat totals fail, 20 sat pays.
// test/melt-fee.test.mjs pins those three so this stays honest if the rule is edited.
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

// Reserve the inputs for a quoted payment. Still reversible — nothing has been sent to the
// mint to pay yet, so `cancelMelt` gives the proofs straight back.
export function prepareMelt(wallet, quote) {
  return wallet.manager.ops.melt.prepare({ quote })
}

export function cancelMelt(wallet, prepared, reason) {
  return wallet.manager.ops.melt.cancel(prepared.id, reason)
}

// Pay. The mint may settle immediately or leave the payment in flight, in which case the
// operation is refreshed until it lands — a lightning payment can take a while, and the
// wallet must not be closed thinking it is done.
//
// A melt that stays pending is NOT a failure: the proofs are spent at the mint and the
// payment may yet succeed. Only the mint can say, which is what refresh asks it.
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

// coco 2.0.0 mis-budgets a melt that needs a swap at a mint charging per-input fees: it
// builds the swap's send outputs at amount + fee_reserve + swap_fee and reserves the same
// as inputs, but the mint takes its fee out of the inputs — so the swap is short by
// exactly the fee and cashu-ts refuses it. The operation rolls back cleanly (coco restores
// the proofs), so nothing is lost; only the payment does not happen. Say so, rather than
// leaving the user with "Not enough funds available to send" and a full wallet.
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

// What a token claims about itself, before we touch the network. The mint url is
// attacker-controlled, so callers check it against their own policy before receiving.
export function inspectToken(token) {
  const meta = getTokenMetadata(token)
  return { mintUrl: meta.mint, unit: meta.unit, amount: meta.amount }
}

// Receive a token: the issuing mint is whichever one the token names, so it has to be
// trusted before coco will swap against it.
export async function processToken(wallet, token) {
  const mintUrl = await useMint(wallet, inspectToken(token).mintUrl)
  await wallet.manager.wallet.receive(token)
  return mintUrl
}

// NUT-13 restore, as a repair: ask one mint to re-sign every secret our seed derives, so
// proofs it issued but this wallet never recorded come back.
export function restoreProofs(wallet, mintUrl) {
  return wallet.manager.wallet.restore(mintUrl)
}

// { mintUrl: { unit: { spendable, reserved, total, unit } } }
//
// Per unit rather than per mint: a mint can issue more than one, and a snapshot that adds
// them together says a mint holds 30 when it holds 20 sat and 10 of something else. The
// CLI only ever asks for sat, but that is the CLI's choice, not the wallet's.
export function balances(wallet, scope) {
  return wallet.manager.wallet.balances.byMintAndUnit(scope)
}

// One snapshot per unit, across every mint: { unit: { spendable, reserved, total, unit } }.
export function totalBalances(wallet, scope) {
  return wallet.manager.wallet.balances.totalByUnit(scope)
}

// The mint holding the most of `unit`, or null when no mint holds any. Used when paying an
// invoice, where the cost is not known until a mint has quoted it.
export async function richestMint(wallet, unit = DEFAULT_UNIT) {
  let best = null
  for (const [mintUrl, byUnit] of Object.entries(await balances(wallet, { units: [unit] }))) {
    const spendable = Number(byUnit[unit]?.spendable ?? 0)
    if (!best || spendable > best.spendable) best = { mintUrl, spendable }
  }
  return best && best.spendable > 0 ? best.mintUrl : null
}

// The first mint whose spendable balance in `unit` covers `amount`. Fees are not counted:
// they are only known once a send is prepared, so this is a filter rather than a guarantee.
export async function mintWithBalance(wallet, amount, unit = DEFAULT_UNIT) {
  const byMint = await balances(wallet, { units: [unit] })
  for (const [mintUrl, byUnit] of Object.entries(byMint)) {
    if (Number(byUnit[unit]?.spendable ?? 0) >= amount) return mintUrl
  }
  return null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
