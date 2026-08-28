import process from 'bare-process'
import tty from 'bare-tty'
import { note } from '../notes.mjs'
import { receiveTokens } from '../ble.mjs'
import { processToken, inspectToken } from '../manager.mjs'
import { useWallet, interrupted } from './session.mjs'
import { showBalances } from './ui.mjs'

export async function run({ dir, flags }) {
  // A token pasted in, piped in, or waited for over bluetooth. The first two are one token
  // and done; the third is a session (see below).
  const pasted = await tokenFromArgs(flags)
  const wallet = await useWallet(dir)

  if (pasted !== null) {
    await claim(wallet, pasted)
    return
  }

  // Join the swarm and stay there: two neighbours at once, or one paying twice, should not
  // need the command started again. Each token is swapped in under the mint that issued it,
  // and the run ends when the user says so.
  //
  // The wallet is opened up front, not per token: one lock and one coco startup for the
  // whole session — which also means no other cashme can run while we listen.
  const interrupt = interrupted()
  await receiveTokens({
    cancelled: interrupt.promise,
    ontoken: (token) => claim(wallet, token)
  })
  interrupt.release()
}

// TODO: a token names its own mint, which is untrusted input. Confirm with the user
// (or check a trusted-mint list) before trusting that mint and swapping against it.
async function claim(wallet, tokenString) {
  const token = inspectToken(tokenString)
  note(`receiving ${token.amount} ${token.unit} from ${token.mintUrl}`)
  await processToken(wallet, tokenString)
  await showBalances(wallet, 'New Balance')
}

// `--token <string>` for a paste, `--token -` or a stdin that is not a terminal for a pipe
// — `cashme get < token.txt` and `pbpaste | cashme get` both land here. Null means nothing
// was handed over, so the command falls back to bluetooth.
//
// A script, a service or a `< /dev/null` has no terminal on stdin either, and would be
// read from forever waiting for a token nobody is typing — hence --bluetooth, which says
// which of the two this run is regardless of what stdin looks like.
//
// Trimmed because a token copied out of a chat message arrives with whitespace around it,
// and a redirected file ends in a newline.
async function tokenFromArgs(flags) {
  if (flags.token && flags.token !== '-') return flags.token.trim()
  if (flags.bluetooth && flags.token !== '-') return null
  if (flags.token !== '-' && tty.isTTY(0)) return null

  const token = (await readStdin()).trim()
  if (!token) throw new Error('nothing to receive on stdin')
  return token
}

function readStdin() {
  const stdin = process.stdin
  return new Promise((resolve, reject) => {
    let data = ''
    stdin.on('data', (chunk) => {
      data += chunk.toString()
    })
    stdin.on('end', () => resolve(data))
    stdin.on('error', reject)
    stdin.resume()
  })
}
