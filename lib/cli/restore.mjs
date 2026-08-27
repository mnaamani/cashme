import { useMint, restoreProofs, balances } from '../manager.mjs'
import { DEFAULT_MINT_URL } from '../constants.mjs'
import { useWallet } from './session.mjs'
import { showBalances } from './ui.mjs'

export async function run({ dir, flags }) {
  const wallet = await useWallet(dir)

  // A repair, not a backup: one mint re-signs every secret our seed derives, recovering
  // proofs it issued but this wallet never recorded. Per mint, because a seed says nothing
  // about which mints it was used at.
  const mintUrl = await useMint(wallet, flags.mint || DEFAULT_MINT_URL)

  // coco's proof repository rejects a proof it already holds, and one collision fails the
  // whole keyset — so restoring into an intact wallet only reports a keyset failure. Say
  // what is actually going on instead.
  const held = Object.values((await balances(wallet))[mintUrl] ?? {}).filter(
    (balance) => Number(balance.total) > 0
  )
  if (held.length) {
    const amounts = held.map((balance) => `${balance.total} ${balance.unit}`).join(' and ')
    console.log(`This wallet already holds ${amounts} at ${mintUrl}.`)
    console.log('Restore can only rebuild proofs this wallet has lost: coco refuses to')
    console.log('re-add ones it already has, and that fails the whole keyset.')
    console.log('Nothing was changed.')
    return
  }

  console.log(`Restoring from ${mintUrl} — this can take a while.`)
  await restoreProofs(wallet, mintUrl)
  await showBalances(wallet)
}
