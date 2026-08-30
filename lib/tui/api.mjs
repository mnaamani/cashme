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
  prepareSend,
  executeSend,
  cancelSend,
  finalizeSend,
  awaitSendClaim,
  inspectToken,
  isTrustedMint,
  receiveToken,
  DEFAULT_UNIT
} from '../manager.mjs'
import { planMelt, settleMelt } from '../cli/withdraw.mjs'
import { findNeighbour, receiveTokens } from '../ble.mjs'
import { findPeer, receiveTokens as receiveOverDht } from '../dht.mjs'
import { dhtIdentity } from '../cli/address.mjs'
import { normalizeMintUrl } from '../mint-url.mjs'
import { copyToClipboard } from '../clipboard.mjs'
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

  return {
    dir,

    // --- readings ---------------------------------------------------------------

    // One pass over the wallet for everything the dashboard shows, so the mints, the
    // totals and the pending sends on screen are all from the same moment.
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
        return { held, totals, pending }
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

    // Finding the receiver — bluetooth or the hyperdht — and handing over. Off the queue
    // for the same reason: this is radio and network, not the wallet.
    reach: (publicKey, { dht = false, stable = false, cancelled }) =>
      dht
        ? findPeer(publicKey, { cancelled, keyPair: dhtIdentity(wallet, { stable, dht: true }) })
        : findNeighbour(publicKey, { cancelled }),

    // --- receive ----------------------------------------------------------------

    inspect: (token) => {
      const parsed = inspectToken(token)
      return { ...parsed, mintUrl: normalizeMintUrl(parsed.mintUrl) }
    },
    trusted: (mintUrl) => serial(() => isTrustedMint(wallet, mintUrl)),
    trust: (mintUrl) => serial(() => useMint(wallet, mintUrl)),
    claim: (token) => serial(() => receiveToken(wallet, token)),

    // Listens for tokens over a wire until cancelled, handing each to `ontoken`.
    listen: ({ dht = false, stable = false, cancelled, ontoken }) =>
      dht
        ? receiveOverDht({
            cancelled,
            ontoken,
            keyPair: dhtIdentity(wallet, { stable, dht: true }, { listening: true })
          })
        : receiveTokens({ cancelled, ontoken }),

    // --- withdraw ---------------------------------------------------------------

    planWithdraw: ({ invoice, mint, unit = DEFAULT_UNIT }) =>
      serial(() => planMelt(wallet, invoice, { mint }, unit)),
    settleWithdraw: (plan) => serial(() => settleMelt(wallet, plan)),

    // --- pending ----------------------------------------------------------------

    refresh: (operationId) => serial(() => refreshSend(wallet, operationId)),

    // --- odds and ends ----------------------------------------------------------

    qr: qrCode,
    copy: copyToClipboard
  }
}
