import './polyfills.mjs'
import { initializeCoco, normalizeUnit, DEFAULT_UNIT } from '@cashu/coco-core'
import { FileRepositories } from './coco-store.mjs'
import { newSeed, seedToHex, seedFromHex } from './seed.mjs'
import { note } from './notes.mjs'
import { sweepPreparedOperations, settleInFlightMints } from './wallet/recovery.mjs'

// Keep this file as the wallet-facing API used by the CLI. The implementation lives in
// focused modules so the lifecycle, recovery, send, melt, and mint concerns stay small.
export { DEFAULT_UNIT, normalizeUnit }
export {
  sweepPreparedOperations,
  settleInFlightMints,
  useMint,
  mintTokens
} from './wallet/recovery.mjs'
export {
  prepareSend,
  executeSend,
  prepareP2pkSend,
  executeSendProofs,
  cancelSend,
  finalizeSend,
  reclaimSend,
  pendingSends,
  refreshSend,
  awaitSendClaim
} from './wallet/send.mjs'
export {
  quoteMelt,
  inputFeePpk,
  meltFeasibility,
  prepareMelt,
  cancelMelt,
  payInvoice
} from './wallet/melt.mjs'
export {
  inspectToken,
  isTrustedMint,
  knownMints,
  trustMint,
  untrustMint,
  receiveToken,
  restoreProofs,
  balances,
  totalBalances,
  mintDetails,
  richestMint,
  mintWithBalance
} from './wallet/mints.mjs'

export async function openWallet(dir, { wait = false } = {}) {
  const repos = new FileRepositories(dir, { wait })
  await repos.init()

  let manager
  try {
    if (!repos.seedHex) {
      repos.seedHex = seedToHex(newSeed())
      repos.save()
    }
    const seed = seedFromHex(repos.seedHex)
    manager = await initializeCoco({ repo: repos, seedGetter: () => Promise.resolve(seed) })
    const reclaimed = await sweepPreparedOperations({ manager })
    const deposited = await settleInFlightMints({ manager })

    return {
      manager,
      repos,
      dir,
      reclaimed,
      deposited,
      async close() {
        try {
          await manager.dispose()
        } finally {
          repos.close()
        }
      }
    }
  } catch (err) {
    await abandonWallet(manager, repos)
    throw err
  }
}

async function abandonWallet(manager, repos) {
  try {
    await manager?.dispose()
  } catch (err) {
    note('[wallet] could not dispose after a failed open:', err.message)
  }
  try {
    repos.close()
  } catch (err) {
    note('[wallet] could not close after a failed open:', err.message)
  }
}
