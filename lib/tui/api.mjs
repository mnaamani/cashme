// Everything the screens are allowed to do to the wallet, in one object.
//
// Two reasons it is an object rather than imports in each screen. One is that it can be
// replaced with a fake, so a screen can be rendered and driven in a test without a mint
// anywhere. The other is the queue: coco holds one wallet and this UI can start an
// operation from any screen, so every call goes through `serial` and waits its turn. A
// deposit polling its quote while the user starts a send would otherwise have two
// operations writing the same repositories.
import {
  balances,
  totalBalances,
  pendingSends,
  refreshSend,
  reclaimSend,
  useMint,
  mintTokens,
  mintWithBalance,
  mintDetails,
  prepareSend,
  executeSend,
  cancelSend,
  finalizeSend,
  awaitSendClaim,
  inspectToken,
  isTrustedMint,
  knownMints,
  receiveToken,
  trustMint,
  untrustMint,
  DEFAULT_UNIT
} from '../manager.mjs'
import { planMelt, settleMelt } from '../cli/withdraw.mjs'
import { planZap, settleZap } from '../cli/zap.mjs'
import { planNutzap, settleNutzap, cancelNutzap } from '../cli/nutzap.mjs'
import { findNeighbour, receiveTokens } from '../ble.mjs'
import { findPeer, receiveTokens as receiveOverDht } from '../dht.mjs'
import { findPeer as findOnLan, receiveTokens as receiveOverLan } from '../lan.mjs'
import { wireIdentity, addressMode, setAddressMode } from '../cli/address.mjs'
import { normalizeMintUrl } from '../mint-url.mjs'
import { copyToClipboard, pasteFromClipboard } from '../clipboard.mjs'
import { proxyInForce, interfaceInForce } from '../net.mjs'
import process from 'bare-process'
import { qrCode } from '../cli/ui.mjs'

export function createApi(wallet, { dir } = {}) {
  // One at a time, in the order asked for. Rejections are kept off the chain so a failed
  // operation does not poison the ones queued behind it.
  let chain = Promise.resolve()
  const serial = (fn) => {
    const result = chain.then(fn)
    chain = result.then(
      () => {},
      () => {}
    )
    return result
  }

  // Proofs this session has reserved and not yet turned into a token. A send registers
  // here for exactly as long as it could still hand them back, so that a session ending
  // mid-send — Ctrl-C, or the terminal going away — has something to act on. Without it
  // the proofs are merely reserved: safe, because openWallet sweeps prepared operations on
  // the next run, but out of the balance and in no list until then.
  const holding = new Set()

  return {
    dir,

    // coco's unit, which is what every amount on these screens is in unless one is typed.
    defaultUnit: DEFAULT_UNIT,

    // Registers reserved proofs and returns the way to say they are no longer owed.
    hold(entry) {
      holding.add(entry)
      return () => holding.delete(entry)
    },
    holding: () => [...holding],

    // --- readings ---------------------------------------------------------------

    // One pass over the wallet for everything the menu shows, so the mints, the
    // totals and the pending sends on screen are all from the same moment. Every screen is
    // handed the result, which is also where the mint fields get something to complete
    // from — one read rather than a poll per form.
    snapshot: () =>
      serial(async () => {
        const held = []
        for (const [mintUrl, byUnit] of Object.entries(await balances(wallet))) {
          for (const balance of Object.values(byUnit)) {
            held.push({
              mintUrl,
              unit: balance.unit,
              spendable: Number(balance.spendable),
              reserved: Number(balance.reserved)
            })
          }
        }
        const totals = Object.values(await totalBalances(wallet)).map((total) => ({
          unit: total.unit,
          spendable: Number(total.spendable)
        }))
        const pending = (await pendingSends(wallet)).map((operation) => ({
          id: operation.id,
          amount: Number(operation.amount),
          unit: operation.unit,
          mintUrl: operation.mintUrl,
          method: operation.method,
          operation
        }))
        // Ordered for completion: the ones holding something first, since a mint with no
        // balance is rarely the answer to `give` or `withdraw`, then the rest by name so the
        // suggestion for a given prefix is always the same one.
        const spendable = new Set(held.filter((entry) => entry.spendable).map((e) => e.mintUrl))
        const mints = (await knownMints(wallet))
          .filter((mint) => mint.trusted)
          .map((mint) => mint.mintUrl)
          .sort((a, b) => spendable.has(b) - spendable.has(a) || (a < b ? -1 : a > b ? 1 : 0))

        return { held, totals, pending, mints }
      }),

    // --- deposit ----------------------------------------------------------------

    // Mints new ecash against a lightning invoice. `onQuote` fires as soon as the mint has
    // quoted, which is what puts the invoice and its QR on screen — the promise itself
    // does not settle until the invoice is paid.
    deposit: ({ amount, unit = DEFAULT_UNIT, mintUrl, onQuote }) =>
      serial(async () => {
        const mint = await useMint(wallet, mintUrl)
        return mintTokens(wallet, mint, amount, { unit, onQuote })
      }),

    // What each mint holds and in what denominations. Its own call rather than part of
    // snapshot(): it walks every proof in the wallet, and the menu asks for a total several
    // times a session while this is read only when the screen showing it is open.
    mints: () => serial(() => mintDetails(wallet)),

    // --- give -------------------------------------------------------------------

    // Picks the mint and reserves the proofs, without creating a token yet. Separate from
    // the send because this is the step that can fail on a balance, and it should fail
    // before anyone waits for a peer.
    prepareGive: ({ amount, unit = DEFAULT_UNIT, mint = null }) =>
      serial(async () => {
        const named = mint ? await useMint(wallet, mint) : null
        const mintUrl = await mintWithBalance(wallet, amount, unit, named && [named])
        if (!mintUrl) {
          throw new Error(`insufficient ${unit} balance at ${named ?? 'any single mint'}`)
        }
        const prepared = await prepareSend(wallet, mintUrl, amount, unit)
        return { mintUrl, prepared, fee: Number(prepared.fee || 0) }
      }),

    // Turns reserved proofs into a token. After this the token exists and the send has to
    // be settled rather than cancelled — the proofs may be in someone else's hands.
    executeGive: (prepared) => serial(() => executeSend(wallet, prepared)),
    cancelGive: (prepared) => serial(() => cancelSend(wallet, prepared)),
    finalizeGive: (operation) => serial(() => finalizeSend(wallet, operation)),
    reclaim: (operation) => serial(() => reclaimSend(wallet, operation)),

    // Polls the mint until the proofs are spent. Not serialized: it is a long wait that
    // touches nothing until it finishes, and holding the queue for it would freeze the UI.
    awaitClaim: (operation, { cancelled, onPoll }) =>
      awaitSendClaim(wallet, operation, { cancelled, onPoll }),

    // Finding the receiver and handing over. Off the queue for the same reason: this is
    // radio and network, not the wallet. `wire` is one of the three the CLI offers under
    // the same names — see lib/cli/transport.mjs — and only the hyperdht has an identity
    // to choose, because only there is the key something the receiver may keep.
    reach: (publicKey, { wire = 'bluetooth', cancelled }) => {
      // The address mode governs every wire, so the key is chosen here rather than in
      // whichever branch below happens to be taken.
      const keyPair = wireIdentity(wallet, {})
      return wire === 'dht'
        ? findPeer(publicKey, { cancelled, keyPair })
        : wire === 'lan'
          ? findOnLan(publicKey, { cancelled, keyPair })
          : findNeighbour(publicKey, { cancelled, keyPair })
    },

    // --- get --------------------------------------------------------------------

    inspect: (token) => {
      const parsed = inspectToken(token)
      return { ...parsed, mintUrl: normalizeMintUrl(parsed.mintUrl) }
    },
    trusted: (mintUrl) => serial(() => isTrustedMint(wallet, mintUrl)),
    trust: (mintUrl) => serial(() => useMint(wallet, mintUrl)),

    // --- mints ------------------------------------------------------------------

    // Trusting a mint by name rather than by having been paid by one. Reaches the network,
    // since a url that does not answer as a mint should fail here and not at the first send.
    trustMint: (mintUrl) => serial(() => trustMint(wallet, mintUrl)),
    untrustMint: (mintUrl) => serial(() => untrustMint(wallet, mintUrl)),
    claim: (token) => serial(() => receiveToken(wallet, token)),

    // Listens for tokens over a wire until cancelled, handing each to `ontoken`. The
    // address the sender has to be given comes back through `onaddress`, once the wire is
    // actually up — on bluetooth it is the swarm's key and does not exist before then.
    listen: ({ wire = 'bluetooth', cancelled, ontoken, onaddress }) => {
      const keyPair = wireIdentity(wallet, {}, { listening: true })
      return wire === 'dht'
        ? receiveOverDht({ cancelled, ontoken, onaddress, keyPair })
        : wire === 'lan'
          ? receiveOverLan({ cancelled, ontoken, onaddress, keyPair })
          : receiveTokens({ cancelled, ontoken, onaddress, keyPair })
    },

    // --- withdraw ---------------------------------------------------------------

    planWithdraw: ({ invoice, mint, unit = DEFAULT_UNIT }) =>
      serial(() => planMelt(wallet, invoice, { mint }, unit)),
    settleWithdraw: (plan) => serial(() => settleMelt(wallet, plan)),

    // --- nostr ------------------------------------------------------------------

    // Both are quote-then-confirm, like withdraw: the lookup and the reservation happen
    // first, and nothing moves until the plan they produce has been agreed to.
    planZap: ({ pubkey, amount, comment }) =>
      serial(() => planZap(wallet, { pubkey, amount, comment })),
    settleZap: (plan) => serial(() => settleZap(wallet, plan)),

    planNutzap: ({ pubkey, amount, mint }) =>
      serial(() => planNutzap(wallet, { pubkey, amount, mint })),
    settleNutzap: (plan, { comment } = {}) => serial(() => settleNutzap(wallet, plan, { comment })),
    cancelNutzap: (plan) => serial(() => cancelNutzap(wallet, plan)),

    // --- pending ----------------------------------------------------------------

    refresh: (operationId) => serial(() => refreshSend(wallet, operationId)),

    // --- settings -----------------------------------------------------------------

    // What this session is running as: the two paths a run depends on and never otherwise
    // shows, and the three global choices that decide where its traffic goes and what
    // address it wears. Read fresh each time — the address mode moves while the UI is up.
    settings: () => {
      const via = proxyInForce()
      return {
        binary: process.execPath,
        storage: dir,
        proxy: via ? { name: via.name, source: via.source } : null,
        dhtInterface: interfaceInForce(),
        address: addressMode()
      }
    },

    // The one setting this screen can move. Everything else here was decided on the
    // command line and stays decided: a proxy is wired into coco's fetch at startup, and
    // the storage directory is the wallet that is already open.
    setAddress: (mode) => setAddressMode(mode),
    addressMode,

    // --- odds and ends ----------------------------------------------------------

    qr: qrCode,
    copy: copyToClipboard,
    paste: pasteFromClipboard
  }
}
