// `cashme zap` — NIP-57: pay a nostr user over lightning, with a receipt they can show.
//
// The other half of `nutzap`. A nutzap hands over the ecash itself, locked to the
// recipient's key; a zap is a real lightning payment — we melt ecash at our mint, the mint
// routes sats to their node, and their lnurl host publishes a kind 9735 receipt that
// clients display under the note. So a zap is public where a nutzap is not, and our mint
// sees who we paid.
//
// Mechanically it is `cashme withdraw` with a lookup in front of it: find the recipient's
// lightning address, ask that host for an invoice, then melt against it.
import { relaysFor } from '../relays.mjs'
import {
  RelayPool,
  resolveRecipient,
  readProfile,
  isAddress,
  ephemeralKeypair,
  signEvent,
  ZAP_REQUEST_KIND
} from '../nostr.mjs'
import { isLightningAddress, payEndpoint, fetchPayParams, requestInvoice } from '../lnurl.mjs'
import { note } from '../notes.mjs'
import { useWallet } from './session.mjs'
import { payBolt11, planMelt, settleMelt } from './withdraw.mjs'
import { confirm, sats } from './ui.mjs'

export async function run({ dir, flags, command }) {
  if (!flags.pubkey || !flags.sats) {
    console.log(command.help())
    return
  }

  const amount = sats(flags.sats)
  // lnurl works in millisats throughout; sats are only what the user types.
  const msats = amount * 1000

  const target = await findEndpoint(dir, flags)
  const params = await fetchPayParams(target.endpoint)

  if (msats < params.minSendable || msats > params.maxSendable) {
    throw new Error(
      `they accept between ${params.minSendable / 1000} and ${params.maxSendable / 1000} sat, ` +
        `and this is ${amount}`
    )
  }

  const zapRequest = await buildZapRequest(target, params, { msats, flags })
  const invoice = await requestInvoice(params, { msats, zapRequest, comment: flags.comment })

  // The wallet is opened last, once there is an invoice worth paying. A lookup that fails
  // then never took the wallet lock, so it cannot get in the way of another run.
  const wallet = await useWallet(dir)
  // No unit argument: `zap` has no --unit to offer, and an lnurl amount is millisats, so
  // the melt is in sats or it does not happen.
  const paid = await payBolt11(wallet, invoice, flags)
  if (paid) {
    note(
      zapRequest
        ? `Zapped ${amount} sat to ${target.label}. Their relays will carry the receipt.`
        : `Paid ${amount} sat to ${target.label}.`
    )
  }
}

// Where the sats are going, and who — if anyone — we can address a zap request to.
//
// `--pubkey` takes three forms and they resolve differently. A key (npub or hex) means
// reading their profile off relays for a lightning address. An address is ambiguous: the
// same `name@domain` is both a NIP-05 nostr address and a lud16 lightning address, served
// from different paths on that host. We try nostr first, because that is the form that can
// carry a receipt, and fall back to paying the address directly.
//
// `dir` is the storage directory, which is where the relay list lives — read rather than
// taken from the wallet on purpose, since this runs before the wallet is opened.
export async function findEndpoint(dir, flags) {
  const typed = String(flags.pubkey).trim()
  const address = isAddress(typed)

  let recipient = null
  let hinted = []
  try {
    if (address) note(`Resolving ${typed}`)
    const resolved = await resolveRecipient(typed)
    recipient = resolved.pubkey
    hinted = resolved.relays
    if (address) note(`  ${typed} is ${recipient}`)
  } catch (err) {
    // Only an address has anywhere left to go: a key that will not parse is a typo.
    if (!address) throw err
    note(`  no nostr address there (${err.message})`)
    note('  paying it as a plain lightning address — there will be no zap receipt')
  }

  if (!recipient) {
    if (!isLightningAddress(typed)) throw new Error(`nothing to pay at "${typed}"`)
    return { endpoint: payEndpoint(typed), recipient: null, relays: [], label: typed }
  }

  const relayUrls = relaysFor(dir, { hinted, extra: flags.relay || [] })
  const pool = new RelayPool(relayUrls)
  let profile
  try {
    note(`Looking up ${recipient.slice(0, 12)}… on ${pool.urls.length} relays`)
    profile = await readProfile(pool, recipient)
  } finally {
    pool.destroy()
  }

  const listed = profile?.lud16 || profile?.lud06
  if (listed) {
    note(`  they receive at ${profile.lud16 ?? 'an lnurl in their profile'}`)
    return {
      endpoint: payEndpoint(listed),
      recipient,
      relays: relayUrls,
      label: profile.name ? `${profile.name} (${listed})` : listed
    }
  }

  // No profile, or one with no lightning address in it. If what they typed was an address
  // it is still payable — the nostr lookup only ever told us whose key it is.
  if (isLightningAddress(typed)) {
    note('  their profile lists no lightning address; paying the address you typed')
    return { endpoint: payEndpoint(typed), recipient, relays: relayUrls, label: typed }
  }

  throw new Error(
    profile
      ? 'their nostr profile lists no lightning address (lud16 or lud06), so there is ' +
          'nowhere to send this — pass their lightning address instead'
      : 'no nostr profile (kind 0) found on these relays — pass their lightning address ' +
          'instead, or try --relay'
  )
}

// The kind 9734 the lnurl host turns into a receipt, or null when this payment cannot be a
// zap. NIP-57 needs both halves: a recipient key to address it to, and a host that says it
// takes zap requests. Without either the sats still arrive, they just arrive silently.
async function buildZapRequest(target, params, { msats, flags }) {
  if (!target.recipient) return null

  if (!params.allowsNostr) {
    note(`\n${target.label} does not issue zap receipts (their host allows no nostr).`)
    note('The payment would go through as an ordinary lightning payment instead:')
    note('nothing would appear on nostr, and nobody would see who paid.')
    if (!flags.yes && !(await confirm('Pay them anyway?'))) {
      throw new Error('cancelled — nothing was spent')
    }
    return null
  }

  return signEvent(
    {
      kind: ZAP_REQUEST_KIND,
      content: flags.comment || '',
      tags: [
        // One tag holding every relay, which is where the host publishes the receipt.
        ['relays', ...target.relays],
        ['amount', String(msats)],
        ['p', target.recipient],
        ...(flags.event ? [['e', flags.event]] : [])
      ]
    },
    // Signed by a key used once and thrown away, as a nutzap is: relays need a signature,
    // the recipient does not need to know who we are. The cost is that the receipt shows
    // an npub nobody recognises rather than an identity — this wallet has none to offer.
    ephemeralKeypair().secretKey
  )
}

// The whole of a zap up to the moment money moves, for a caller that does its own asking.
//
// `cashme zap` walks the same ground but stops to prompt along the way; a screen cannot be
// prompted at, so nothing here reads stdin. What would have been a question comes back as
// a warning for the caller to put in front of the user with the plan, and the melt plan
// itself is the same one `withdraw` shows — a zap is a lightning payment with a lookup in
// front of it, so it is confirmed and settled the same way.
export async function planZap(wallet, { pubkey, amount, comment = '', event = null, relay = [] }) {
  const warnings = []
  const msats = amount * 1000

  const target = await findEndpoint(wallet.dir, { pubkey, relay })
  const params = await fetchPayParams(target.endpoint)

  if (msats < params.minSendable || msats > params.maxSendable) {
    throw new Error(
      `they accept between ${params.minSendable / 1000} and ${params.maxSendable / 1000} sat, ` +
        `and this is ${amount}`
    )
  }

  // A receipt needs both a nostr key to attribute it to and a host willing to carry it.
  // Missing either is not a failure — it is an ordinary lightning payment, which is worth
  // saying because the whole point of a zap is the part that would be missing.
  let zapRequest = null
  if (!target.recipient) {
    warnings.push('no nostr key there — this pays the lightning address, with no zap receipt')
  } else if (!params.allowsNostr) {
    warnings.push(
      `${target.label} issues no zap receipt: their host allows no nostr, so this goes ` +
        'through as an ordinary payment and nobody sees who paid'
    )
  } else {
    zapRequest = signEvent(
      {
        kind: ZAP_REQUEST_KIND,
        content: comment,
        tags: [
          ['relays', ...target.relays],
          ['amount', String(msats)],
          ['p', target.recipient],
          ...(event ? [['e', event]] : [])
        ]
      },
      ephemeralKeypair().secretKey
    )
  }

  const invoice = await requestInvoice(params, { msats, zapRequest, comment })
  // No unit to choose: an lnurl amount is millisats, so the melt is in sats or not at all.
  const melt = await planMelt(wallet, invoice, {}, 'sat')

  return {
    // What was typed and what it turned out to mean are two different things, and the
    // second is only knowable after the lookup — so both go back for the caller to put in
    // front of the user before any of it is paid.
    typed: pubkey,
    recipient: target.recipient,
    label: target.label,
    amount,
    receipt: Boolean(zapRequest),
    warnings,
    melt
  }
}

// Pays it. Separate from the plan above for the reason every spend in this wallet is: the
// quote is what the user agrees to, and nothing is spent until they have.
export function settleZap(wallet, plan) {
  return settleMelt(wallet, plan.melt)
}
