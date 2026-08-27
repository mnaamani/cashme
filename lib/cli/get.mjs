import { receiveTokens } from '../ble.mjs'
import { processToken, inspectToken } from '../manager.mjs'
import { useWallet, interrupted } from './session.mjs'
import { showBalances } from './ui.mjs'

export async function run({ dir }) {
  // connect to ble-swarm, and stay there: a neighbour who owes us twice, or two of them
  // at once, should not need us to start the command again. Each token is swapped and
  // added to our wallet under the mint that issued it, and the run ends when the user
  // says so.
  //
  // The wallet is opened up front rather than per token — it is one lock and one coco
  // startup for the whole session, and it means no other cashme can run while we listen.
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
