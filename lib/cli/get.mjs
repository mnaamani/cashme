import { receiveTokens } from '../ble.mjs'
import { processToken, inspectToken } from '../manager.mjs'
import { useWallet, interrupted } from './session.mjs'
import { showBalances } from './ui.mjs'

export async function run({ dir }) {
  // Join the swarm and stay there: two neighbours at once, or one paying twice, should not
  // need the command started again. Each token is swapped in under the mint that issued it,
  // and the run ends when the user says so.
  //
  // The wallet is opened up front, not per token: one lock and one coco startup for the
  // whole session — which also means no other cashme can run while we listen.
  const wallet = await useWallet(dir)
  const interrupt = interrupted()

  await receiveTokens({
    cancelled: interrupt.promise,
    async ontoken(tokenString) {
      // TODO: a token names its own mint, which is untrusted input. Confirm with the user
      // (or check a trusted-mint list) before trusting that mint and swapping against it.
      const token = inspectToken(tokenString)
      console.error(`receiving ${token.amount} ${token.unit} from ${token.mintUrl}`)
      await processToken(wallet, tokenString)
      await showBalances(wallet, 'New Balance')
    }
  })
  interrupt.release()
}
