import './polyfills.mjs'
import {
  initializeCoco,
  getEncodedToken,
  getTokenMetadata,
  normalizeUnit,
  OperationInProgressError,
  DEFAULT_UNIT
} from '@cashu/coco-core'
import { FileRepositories } from './coco-store.mjs'
import { newSeed, seedToHex, seedFromHex } from './seed.mjs'
import { normalizeMintUrl } from './mint-url.mjs'
import { note, write } from './notes.mjs'

// coco's default unit ('sat') and its unit normalizer, re-exported so the CLI names units
// the same way the wallet does.
export { DEFAULT_UNIT, normalizeUnit }

// coco (@cashu/coco-core) owns the wallet; lib/coco-store.mjs persists its repositories.
// This module is the thin part on top — opening a wallet and the flows the CLI drives — so
// lib/cli/ never has to know about services, watchers or operation states.

// coco finalizes mint operations from a background processor. A CLI is not long-lived, so
// it drives that itself: poll the quote until the mint says paid, then until the operation
// settles. Ten minutes for each half — long enough for a human to pay an invoice.
const POLL_MS = 3000
const POLL_ATTEMPTS = 200

// Waiting out coco's own processor on an operation it holds (see settledElsewhere). Short
// and few: this delays every command that opens a wallet mid-deposit.
const IN_PROGRESS_MS = 250
const IN_PROGRESS_ATTEMPTS = 12

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

  // initializeCoco also sweeps unfinished send and melt operations, at the cost of a mint
  // round trip when any are outstanding. Sweeping is not settling: a send whose proofs the
  // mint reports spent is finalized, but one still unclaimed is left pending — its proofs
  // stay in flight until someone reclaims them (see pendingSends).
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
  const deposited = await settleInFlightMints({ manager })

  return {
    manager,
    repos,
    dir,
    reclaimed,
    deposited,
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
        note(`[wallet] could not reclaim the ${kind} ${operation.id}: ${err.message}`)
      }
    }
  }
  return reclaimed
}

// Finish the deposits that a run died in the middle of.
//
// A `cashme deposit` that is interrupted between the invoice being paid and the proofs
// being issued leaves a mint operation pending or executing. coco's own recovery runs at
// init and does not always pick these up; its background processor does, but seconds
// later — long enough for the run that opened the wallet to print a balance that is short
// by the deposit. So ask here, before the command sees the wallet, and be right the first
// time. Returns what came in, so the CLI can say why the balance grew.
export async function settleInFlightMints({ manager }) {
  const deposited = []
  for (const operation of await manager.ops.mint.listInFlight()) {
    try {
      // Asks the mint where the quote stands, redeems it if it is paid, and hands back
      // the operation as it now is. An unpaid quote stays as it was, for the next run.
      const current = await manager.ops.mint.refresh(operation.id)
      if (current.state === 'finalized') deposited.push(current)
    } catch (err) {
      // coco's own processor holds a lock on the operations it is working on, and this
      // runs early enough to race it. It is doing what we would have done, so wait for it
      // rather than report a failure the user cannot act on.
      if (err instanceof OperationInProgressError) {
        const current = await settledElsewhere(manager, operation.id)
        if (current) deposited.push(current)
        continue
      }
      // A mint that will not answer costs us nothing here: the deposit stays pending.
      note(`[wallet] could not finish the deposit ${operation.id}: ${err.message}`)
    }
  }
  return deposited.map(({ amount, unit }) => ({ amount, unit }))
}

// Wait out whoever else holds the operation, up to a few seconds. Returns the finished
// operation, or null if it is still going — in which case the next run will pick it up,
// exactly as it did before this function existed.
async function settledElsewhere(manager, operationId) {
  for (let attempt = 0; attempt < IN_PROGRESS_ATTEMPTS; attempt++) {
    await sleep(IN_PROGRESS_MS)
    const current = await manager.ops.mint.get(operationId)
    if (current?.state === 'finalized') return current
    if (current?.state !== 'pending' && current?.state !== 'executing') return null
  }
  return null
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

// Deposit: quote a bolt11 invoice, hand it to the caller to show, then wait for the mint
// to see it paid and issue the proofs. `onQuote` is where the invoice reaches the screen —
// how it is presented is the CLI's business, not ours. `unit` is what the mint issues; the
// operation then mints in the unit its quote was made in.
export async function mintTokens(wallet, mintUrl, amount, { unit = DEFAULT_UNIT, onQuote } = {}) {
  const { manager } = wallet
  const quote = await manager.quotes.mint.create({ mintUrl, amount, method: 'bolt11', unit })
  if (onQuote) onQuote(quote)

  const operation = await manager.ops.mint.prepare({ quote, amount })

  // One loop: coco tracks both halves. `checkPayment` asks the mint where the quote stands
  // and reconciles it, as a category — 'waiting' (unpaid), 'ready' (paid, not redeemed),
  // 'completed' (proofs in hand), 'terminal' (the mint refusing). `finalize` then executes
  // a pending operation, recovers an executing one, and hands back a finished one as is —
  // so racing coco's own processor is harmless.
  //
  // Said once, then a dot per poll on that same line: the QR is on screen above us and a
  // repeated line would scroll it out of view. Every exit from the loop closes the line
  // first, so nothing else prints onto the end of the dots.
  let waiting = false
  const endWaiting = () => {
    if (waiting) write('\n')
    waiting = false
  }

  let paid = false
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    let check = null
    try {
      check = await manager.ops.mint.checkPayment(operation.id)
    } catch (err) {
      // checkPayment insists the operation is pending, and the processor may have moved it
      // on since the last pass. That race alone is ignored — finalize below reads the truth.
      if ((await manager.ops.mint.get(operation.id))?.state === 'pending') {
        endWaiting()
        throw err
      }
    }

    if (check?.category === 'terminal') {
      endWaiting()
      throw new Error(check.terminalFailure?.reason ?? 'the mint refused to issue the proofs')
    }
    if (check?.category === 'waiting') {
      if (!waiting) note('invoice not paid yet, waiting...')
      waiting = true
      write('.')
      await sleep(POLL_MS)
      continue
    }

    endWaiting()
    if (!paid) note('Invoice paid.')
    paid = true

    const current = await manager.ops.mint.finalize(operation.id)
    if (current.state === 'finalized') return current
    if (current.state === 'failed') {
      throw new Error(current.terminalFailure?.reason ?? current.error ?? 'mint operation failed')
    }
    await sleep(POLL_MS)
  }
  endWaiting()
  throw new Error(
    paid
      ? 'the mint did not issue the proofs in time — run `cashme balance` later'
      : 'the invoice was not paid in time — deposit again when you can'
  )
}

// Two steps on purpose: prepare reserves the inputs and works out the fee, so an
// impossible spend fails before the CLI goes looking for a neighbour rather than after.
// `amount` is what the receiver gets; the mint's swap fee comes off our balance on top.
//
// The unit is named rather than left to coco's default. It is the same 'sat' either way,
// but a mint may issue several units and every amount this wallet handles — a --sats flag,
// a lightning invoice, an lnurl amount in millisats — is denominated in sats. Saying so is
// what makes a mint that would answer in another unit fail here rather than downstream.
export function prepareSend(wallet, mintUrl, amount, unit = DEFAULT_UNIT) {
  return wallet.manager.ops.send.prepare({ mintUrl, amount, unit })
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
export function prepareP2pkSend(wallet, mintUrl, amount, pubkey, unit = DEFAULT_UNIT) {
  return wallet.manager.ops.send.prepare({
    mintUrl,
    amount,
    unit,
    target: { type: 'p2pk', pubkey }
  })
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

// Sends whose token is out there with no answer yet — a `give --print` the sender walked
// away from, or a bluetooth run that never got its ACK. Their proofs are in flight: no
// longer ours to spend, not yet known to be theirs, and so in no balance at all until one
// of the two below settles them.
export function pendingSends(wallet) {
  return wallet.manager.ops.send.listInFlight()
}

// Ask the mint whether a pending send's proofs have been spent, and finalize it if they
// have. Gives back the operation as it now stands: 'finalized' means the receiver claimed
// it, 'pending' means the token is still out there — which is also what an unreachable
// mint looks like, since coco reads no news as no claim.
export function refreshSend(wallet, operationId) {
  return wallet.manager.ops.send.refresh(operationId)
}

// Wait for a token handed over out of band to be claimed. There is no ACK on that path, so
// the mint is the only witness: poll it until the proofs come back spent, or until the
// caller gives up. Resolves with the finalized operation, or null when `cancelled` settles
// first — in which case the send simply stays pending, for `cashme pending` or a later run.
export async function awaitSendClaim(wallet, operation, { cancelled, onPoll } = {}) {
  // Nothing to race against when the caller passes no cancellation, so wait forever.
  const stopped = cancelled ?? new Promise(() => {})
  let failures = 0
  for (;;) {
    try {
      const current = await refreshSend(wallet, operation.id)
      failures = 0
      if (current.state !== 'pending') return current
    } catch (err) {
      // refresh swallows a mint it cannot reach; anything reaching us is the operation
      // itself going wrong. Tolerate a blip, give up on a pattern — the token is already
      // out of our hands, so failing here loses nothing but the wait.
      if (++failures >= 5) throw err
    }
    if (onPoll) onPoll()
    if (await Promise.race([sleep(POLL_MS).then(() => null), stopped])) return null
  }
}

// --- melt ------------------------------------------------------------------------------

// What the mint would charge to pay this invoice. Commits nothing — no proofs are touched.
export function quoteMelt(wallet, mintUrl, invoice, unit = DEFAULT_UNIT) {
  return wallet.manager.quotes.melt.create({
    mintUrl,
    method: 'bolt11',
    methodData: { invoice },
    unit
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
// So this rules out the melts that certainly cannot happen, letting `withdraw` refuse them
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

// Has this wallet already been told to trust this mint?
//
// Normalized on the way in, so the answer is about the same mint coco keyed its repos by —
// and a url that is not a mint url at all throws here rather than being reported untrusted.
export function isTrustedMint(wallet, mintUrl) {
  return wallet.manager.mint.isTrustedMint(normalizeMintUrl(mintUrl))
}

// Receive a token, at a mint that is already trusted.
//
// Deliberately does NOT trust the mint the token names. A token is attacker-controlled and
// names its own issuer, so receiving one used to be enough to add a stranger's mint to
// this wallet for good — after which it is a mint a later send may be funded from. coco
// refuses an untrusted mint on its own (UnknownMintError); who to trust is the caller's
// decision, see lib/cli/get.mjs.
export async function receiveToken(wallet, token) {
  await wallet.manager.wallet.receive(token)
  return normalizeMintUrl(inspectToken(token).mintUrl)
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

// What each mint holds, in enough detail to answer the question a balance cannot: not just
// how much, but in what.
//
// A cashu balance is a set of proofs of fixed denominations, and which ones are held decides
// what can be spent without a swap. A wallet holding 200 sat as a single 128 and a 64 and an
// 8 cannot hand over 100 without going back to the mint for change — so the denominations
// are the part worth showing, and the proof count is what says whether a wallet is one swap
// away from tidy or carrying a hundred 1-sat crumbs.
//
// All of it is counted per unit rather than per mint. A mint issuing two units holds two
// separate sets of denominations, and the 64 in one is not change for the 100 in the other
// — pooling them would print a list that answers the question wrongly.
export async function mintDetails(wallet) {
  const byMint = await balances(wallet)
  const ready = await wallet.repos.proofRepository.getAllReadyProofs()
  const reserved = await wallet.repos.proofRepository.getReservedProofs()

  const held = new Map()
  const at = (mintUrl, unit) => {
    if (!held.has(mintUrl)) held.set(mintUrl, new Map())
    const byUnit = held.get(mintUrl)
    if (!byUnit.has(unit)) byUnit.set(unit, { ready: 0, reserved: 0, counts: new Map() })
    return byUnit.get(unit)
  }
  for (const proof of ready) {
    const tally = at(proof.mintUrl, proof.unit)
    tally.ready += 1
    const amount = Number(proof.amount)
    tally.counts.set(amount, (tally.counts.get(amount) ?? 0) + 1)
  }
  for (const proof of reserved) at(proof.mintUrl, proof.unit).reserved += 1

  // Every mint with a balance, plus any holding proofs a balance does not count — a mint
  // whose whole holding is reserved would otherwise not be listed at all.
  const mints = new Set([...Object.keys(byMint), ...held.keys()])

  return [...mints].map((mintUrl) => {
    const byUnit = held.get(mintUrl) ?? new Map()
    // And the same for units within it: one whose whole holding is reserved has no
    // spendable balance to be listed under, but it is still something the mint holds.
    const units = new Set([...Object.keys(byMint[mintUrl] ?? {}), ...byUnit.keys()])
    return {
      mintUrl,
      units: [...units].map((unit) => {
        const figures = byMint[mintUrl]?.[unit] ?? {}
        const tally = byUnit.get(unit) ?? { ready: 0, reserved: 0, counts: new Map() }
        return {
          unit,
          spendable: Number(figures.spendable ?? 0),
          reserved: Number(figures.reserved ?? 0),
          proofs: tally.ready,
          reservedProofs: tally.reserved,
          // Biggest first, which is the order they are spent in and the order that shows at
          // a glance whether the change is there.
          denominations: [...tally.counts.entries()]
            .sort((a, b) => b[0] - a[0])
            .map(([amount, count]) => ({ amount, count }))
        }
      })
    }
  })
}

// The mint holding the most of `unit`, or null if none holds any. Used by `withdraw`, where the
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
