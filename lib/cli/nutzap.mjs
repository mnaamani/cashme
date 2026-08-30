// `cashme nutzap` — NIP-61: send ecash to a nostr user by locking it to their key and
// publishing it as an event.
//
// Not a NIP-57 zap — that is `cashme zap`, which pays them over lightning and leaves a
// receipt on nostr. A nutzap moves the ecash itself: the proofs are locked to the
// recipient's public key (NUT-11 P2PK) and carried in the tags of a kind 9321 event, so
// there is no invoice, no route, and nothing for us to pay a routing fee on.
// It is `give`, over relays instead of bluetooth.
//
// The delivery is fire and forget, and one-way: from the moment the send executes, the
// proofs are locked to the recipient and we cannot swap them back. Everything that can
// fail — no relays, a mint the recipient will not accept, too little balance — is
// therefore checked before that point.
import { DEFAULT_RELAYS } from '../constants.mjs'
import { normalizeMintUrl } from '../mint-url.mjs'
import {
  useMint,
  mintWithBalance,
  prepareP2pkSend,
  executeSendProofs,
  cancelSend,
  finalizeSend,
  DEFAULT_UNIT
} from '../manager.mjs'
import {
  RelayPool,
  resolveRecipient,
  isAddress,
  ephemeralKeypair,
  signEvent,
  tagValue,
  tagValues,
  NUTZAP_INFO_KIND,
  NUTZAP_KIND
} from '../nostr.mjs'
import { note } from '../notes.mjs'
import { useWallet } from './session.mjs'
import { showBalances, confirm, sats } from './ui.mjs'

export async function run({ dir, flags, command }) {
  if (!flags.pubkey || !flags.sats) {
    console.log(command.help())
    return
  }

  const amount = sats(flags.sats)

  // A nostr address is the domain's claim about whose key this is; an npub is the key
  // itself. Either way what we go on from here is the key.
  const address = isAddress(flags.pubkey)
  if (address) console.log(`Resolving ${flags.pubkey}`)
  const { pubkey: recipient, relays: hinted } = await resolveRecipient(flags.pubkey)
  if (address) console.log(`  ${flags.pubkey} is ${recipient}`)

  // Relay hints from the address come after the defaults: they are where that user is said
  // to post, which is where their kind 10019 is most likely to be.
  const relayUrls = [...DEFAULT_RELAYS, ...hinted, ...(flags.relay || [])]

  const wallet = await useWallet(dir)
  await showBalances(wallet, 'Current Balance')

  const pool = new RelayPool(relayUrls)
  try {
    await nutzap(wallet, pool, { recipient, amount, flags })
  } finally {
    pool.destroy()
  }
}

async function nutzap(wallet, pool, { recipient, amount, flags }) {
  // What the recipient published about receiving nutzaps: the key to lock to, the mints
  // they will redeem at, and the relays they read. Without it we are guessing on all three.
  console.log(`Looking up ${recipient.slice(0, 12)}… on ${pool.urls.length} relays`)
  const info = await readNutzapInfo(pool, recipient)

  if (!info && !flags.mint) {
    throw new Error(
      'this user has published no nutzap profile (kind 10019), so there is no way to know ' +
        'which mints they accept — name one with --mint to send anyway'
    )
  }
  if (!info) {
    console.log('No nutzap profile found. Sending to their nostr key at the mint you named,')
    console.log('to the relays this command queried — they may never see it.')
  }

  const lockKey = lockPubkey(info?.pubkey, recipient)
  const relays = info?.relays?.length ? info.relays : pool.urls

  const mintUrl = await chooseMint(wallet, amount, info, flags)
  console.log(`Spending from ${mintUrl}`)

  // Prepared before the delivery is arranged, exactly as `give` does: a spend that cannot
  // happen should fail while the proofs are still ours.
  const prepared = await prepareP2pkSend(wallet, mintUrl, amount, lockKey, DEFAULT_UNIT)
  const fee = prepared.fee

  console.log(`  amount   ${amount} ${DEFAULT_UNIT}${Number(fee) ? ` (+ ${fee} mint fee)` : ''}`)
  console.log(`  locked to ${lockKey}`)
  console.log(`  relays   ${relays.join(', ')}`)
  console.log('Once sent, only the recipient can spend this ecash — it cannot be reclaimed.')

  if (!flags.yes && !(await confirm('Send this nutzap?'))) {
    await cancelSend(wallet, prepared)
    console.log('Cancelled. Nothing was spent.')
    return
  }

  // The relays we will publish to may not be the ones we queried. Reach them before
  // executing, so an unreachable relay costs us nothing.
  const delivery = new RelayPool(relays)
  try {
    const { operation, token } = await executeSendProofs(wallet, prepared)
    await showBalances(wallet, 'Remaining Balance')

    const event = signEvent(
      {
        kind: NUTZAP_KIND,
        content: flags.comment || '',
        tags: [
          ...token.proofs.map((proof) => ['proof', JSON.stringify(nutzapProof(proof))]),
          ['u', mintUrl],
          ['p', recipient],
          ...(flags.event ? [['e', flags.event]] : [])
        ]
      },
      // Signed by a key used once and thrown away: the relays need a signature, the
      // recipient does not need to know who we are.
      ephemeralKeypair().secretKey
    )

    const results = await delivery.publish(event)
    for (const result of results) {
      console.log(`  ${result.ok ? 'accepted' : 'rejected'} by ${result.relay} ${result.message}`)
    }

    // The proofs are locked to them either way: finalize records what is true — this ecash
    // is no longer ours to spend — rather than leaving an operation for every later run to
    // try, and fail, to reclaim.
    await finalizeSend(wallet, operation)

    if (!results.some((result) => result.ok)) {
      note('\nNo relay accepted the nutzap. The ecash is locked to the recipient and')
      note('cannot be reclaimed — publish this event yourself to deliver it:\n')
      note(JSON.stringify(event))
      throw new Error('the nutzap was not delivered')
    }

    console.log(`Nutzapped ${amount} ${DEFAULT_UNIT}.`)
  } finally {
    delivery.destroy()
  }
}

// The newest kind 10019 the relays hold for this user, read into the three things a nutzap
// needs. Tags we do not understand are ignored; a mint url we cannot make sense of is
// dropped rather than allowed to fail the lookup.
//
// The pool has already checked each event's signature and that it is the kind and author we
// asked for, so what arrives here is the user's own word about how to pay them — not the
// relay's. That check is what stands between us and a relay naming its own key in the
// `pubkey` tag and taking the ecash.
async function readNutzapInfo(pool, recipient) {
  const [event] = await pool.query({ kinds: [NUTZAP_INFO_KIND], authors: [recipient], limit: 1 })
  if (!event) return null

  const mints = []
  for (const mint of tagValues(event, 'mint')) {
    try {
      mints.push(normalizeMintUrl(mint))
    } catch {
      note(`ignoring an unusable mint in their profile: ${mint}`)
    }
  }

  return { pubkey: tagValue(event, 'pubkey'), mints, relays: tagValues(event, 'relay') }
}

// A mint we hold enough at and they will redeem at. Both halves matter: ecash is only
// spendable at the mint that issued it, so a nutzap from a mint they do not trust is ecash
// they will not take.
async function chooseMint(wallet, amount, info, flags) {
  const trusted = info?.mints ?? []

  if (flags.mint) {
    const mintUrl = await useMint(wallet, flags.mint)
    // Ask the same question of a named mint as of a chosen one, so naming one that cannot
    // cover the zap fails here rather than inside coco's proof selection.
    if (!(await mintWithBalance(wallet, amount, DEFAULT_UNIT, [mintUrl]))) {
      throw new Error(`${mintUrl} does not hold ${amount} ${DEFAULT_UNIT} in this wallet`)
    }
    if (trusted.length && !trusted.includes(mintUrl)) {
      note(`Warning: they did not list ${mintUrl} as a mint they trust.`)
      note(`They listed: ${trusted.join(', ')}`)
      if (!flags.yes && !(await confirm('Send from it anyway?'))) {
        throw new Error('cancelled — nothing was spent')
      }
    }
    return mintUrl
  }

  const mintUrl = await mintWithBalance(
    wallet,
    amount,
    DEFAULT_UNIT,
    trusted.length ? trusted : null
  )
  if (mintUrl) return mintUrl

  throw new Error(
    trusted.length
      ? `no single mint they trust holds ${amount} ${DEFAULT_UNIT} in this wallet — ` +
          `they accept ${trusted.join(', ')}`
      : `no single mint holds ${amount} ${DEFAULT_UNIT}`
  )
}

// The key the proofs are locked to, checked before anything is spent.
//
// NIP-61 locks to the pubkey in the profile, which is a 33-byte cashu key, not the x-only
// nostr one. Without a profile the convention is the nostr key with an even-y prefix,
// which is what the recipient's wallet will derive too.
//
// Checked here because nothing downstream does: coco only refuses an empty lock key, and a
// P2PK send cannot be reclaimed — so a `pubkey` tag with a typo in it would lock the ecash
// to a key nobody can ever sign for, and `nutzap` would then finalize the send as
// delivered. The event is signed, so this is not a relay forging a key; it is a recipient
// whose wallet published something we cannot pay to, and the time to say so is now.
//
// An x-only key in that tag is taken as the same even-y convention rather than refused: it
// is the one malformed shape whose intent is unambiguous, and it derives the very key the
// no-profile fallback would have used.
function lockPubkey(published, recipient) {
  if (!published) return `02${recipient}`

  const key = String(published).trim().toLowerCase()
  if (/^0[23][0-9a-f]{64}$/.test(key)) return key
  if (/^[0-9a-f]{64}$/.test(key)) {
    note(`their profile lists an x-only key; locking to 02${key} as NIP-61 does`)
    return `02${key}`
  }

  throw new Error(
    `their nutzap profile locks to "${published}", which is not a cashu public key — ` +
      'ecash locked to it could never be spent, so nothing was sent'
  )
}

// NUT-11 proofs as NIP-61 carries them: one tag per proof, holding the proof as json. The
// dleq comes along when the mint gave us one, since it is what lets the recipient verify
// the proof without asking the mint first.
function nutzapProof(proof) {
  const carried = {
    id: proof.id,
    amount: Number(proof.amount),
    secret: proof.secret,
    C: proof.C
  }
  if (proof.dleq) carried.dleq = proof.dleq
  return carried
}
