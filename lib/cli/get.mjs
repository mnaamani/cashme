import process from 'bare-process'
import tty from 'bare-tty'
import { note, flush } from '../notes.mjs'
import { receiveTokens } from '../ble.mjs'
import { receiveTokens as receiveOverDht } from '../dht.mjs'
import { receiveTokens as receiveOverLan } from '../lan.mjs'
import { wireIdentity } from './address.mjs'
import { transportFrom, DHT, LAN } from './transport.mjs'
import { isTrustedMint, useMint, receiveToken, inspectToken } from '../manager.mjs'
import { normalizeMintUrl } from '../mint-url.mjs'
import { MAX_TOKEN_BYTES, assertTokenSize } from '../token-wire.mjs'
import { useWallet, interrupted } from './session.mjs'
import { showBalances, confirm } from './ui.mjs'

export async function run({ dir, flags }) {
  const transport = transportFrom(flags)

  // A token pasted in, piped in, or waited for over a wire. The first two are one token
  // and done; the third is a session (see below).
  const pasted = await tokenFromArgs(flags)
  // Whether an unknown mint can be put to the user at all. Asked before the wallet is
  // opened and before stdin is drained by a pasted token — by the time one has been read
  // from a pipe there is nobody left there to answer.
  const asking = tty.isTTY(0)
  const wallet = await useWallet(dir)

  if (pasted !== null) {
    await claim(wallet, pasted, { flags, asking })
    return
  }

  // Listen and stay listening: two senders at once, or one paying twice, should not need
  // the command started again. Each token is swapped in under the mint that issued it, and
  // the run ends when the user says so.
  //
  // The wallet is opened up front, not per token: one lock and one coco startup for the
  // whole session — which also means no other cashme can run while we listen.
  const interrupt = interrupted()
  // Any wire, same shape: listen, hand each token to the wallet, stop when the user does.
  // Only the DHT has an address to choose, because only there is the key something the
  // sender may keep (see lib/dht.mjs) rather than a way to pick us out of the room.
  // One identity for every wire — the key a sender ends up holding is the same one
  // whichever way they reached us, which is the point of --stable (see address.mjs).
  const keyPair = wireIdentity(wallet, flags, { listening: true })
  const listen =
    transport === DHT
      ? (opts) => receiveOverDht({ keyPair, ...opts })
      : transport === LAN
        ? (opts) => receiveOverLan({ keyPair, ...opts })
        : (opts) => receiveTokens({ keyPair, ...opts })
  await listen({
    cancelled: interrupt.promise,
    ontoken: (token) => claim(wallet, token, { flags, asking })
  })
  interrupt.release()
}

async function claim(wallet, tokenString, { flags, asking }) {
  const token = inspectToken(tokenString)
  // Normalized here so everything below — the trust check, the question, the mint we go on
  // to trust — is about one spelling of the mint, the one coco keys its repos by.
  const mintUrl = normalizeMintUrl(token.mintUrl)
  note(`receiving ${token.amount} ${token.unit} from ${mintUrl}`)

  if (!(await isTrustedMint(wallet, mintUrl))) {
    await approveMint(mintUrl, { flags, asking })
    // Approved, so record it: from here this mint is one this wallet holds ecash at, and
    // every later token from it is received without asking again.
    await useMint(wallet, mintUrl)
  }

  await receiveToken(wallet, tokenString)
  await showBalances(wallet, 'New Balance')
}

// May we take ecash from a mint this wallet has never used? Returns only on a yes; a no
// throws, which the caller's queue turns into the token being printed rather than lost.
//
// What is being decided is not really this token, it is the mint. Receiving means holding
// a claim against whoever runs it: they have the bitcoin, they can refuse to pay it out,
// and from here on this wallet may fund a send from them. A token is attacker-controlled
// and names its own issuer, so anyone who can reach a listening `cashme get` could
// otherwise put their mint into this wallet permanently, just by paying it.
async function approveMint(mintUrl, { flags, asking }) {
  // Named on the command line: the same doctrine as everywhere else in this CLI — naming a
  // mint is the decision to trust it — and what makes an unattended `get` possible without
  // trusting whatever turns up.
  if ((flags.mint ?? []).some((named) => safeNormalize(named) === mintUrl)) return

  if (!asking) {
    throw new Error(
      `${mintUrl} is a mint this wallet has never used, and there is no terminal here to ` +
        `ask — rerun with --mint ${mintUrl} to accept it`
    )
  }

  note('')
  note(`${mintUrl} is a mint this wallet has never used.`)
  note('Receiving means trusting it: it holds the bitcoin backing this ecash, it can')
  note('refuse to pay it out, and a later send may be funded from it.')
  // A mint reached over plaintext is one anyone on the path can read and rewrite, which is
  // worth more than a line in the general warning above.
  if (mintUrl.startsWith('http://')) {
    note('It is also reached over http, so the connection is neither private nor authentic.')
  }
  // The lines above are queued on stderr and the question goes straight to stdout, so
  // without this the terminal shows the question first and the reasons for it after — see
  // lib/notes.mjs. A prompt about trusting a stranger's mint has to arrive in order.
  await flush()
  if (!(await confirm(`Trust ${mintUrl} and receive this ecash?`))) {
    throw new Error(`declined ${mintUrl} — nothing was received and the mint was not added`)
  }
}

// A --mint the user typed is compared, not used, so a bad one should not take the run down
// here: it fails on its own terms wherever it is actually reached.
function safeNormalize(mintUrl) {
  try {
    return normalizeMintUrl(mintUrl)
  } catch {
    return null
  }
}

// `--token <string>` for a paste, `--token -` or a stdin that is not a terminal for a pipe
// — `cashme get < token.txt` and `pbpaste | cashme get` both land here. Null means nothing
// was handed over, so the command falls back to listening on a wire.
//
// A script, a service or a `< /dev/null` has no terminal on stdin either, and would be
// read from forever waiting for a token nobody is typing — hence --bluetooth, --lan and
// --dht, any of which says this run listens regardless of what stdin looks like.
//
// Trimmed because a token copied out of a chat message arrives with whitespace around it,
// and a redirected file ends in a newline.
async function tokenFromArgs(flags) {
  if (flags.token && flags.token !== '-') return assertTokenSize(flags.token.trim())
  if ((flags.bluetooth || flags.dht || flags.lan) && flags.token !== '-') return null
  if (flags.token !== '-' && tty.isTTY(0)) return null

  const token = (await readStdin()).trim()
  if (!token) throw new Error('nothing to receive on stdin')
  return assertTokenSize(token)
}

function readStdin(maxBytes = MAX_TOKEN_BYTES) {
  const stdin = process.stdin
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    const finish = (done, value) => {
      stdin.off('data', ondata)
      stdin.off('end', onend)
      stdin.off('error', onerror)
      stdin.pause()
      done(value)
    }
    const ondata = (chunk) => {
      const data = Buffer.from(chunk)
      bytes += data.byteLength
      if (bytes > maxBytes) {
        finish(reject, new Error(`stdin token is larger than the ${maxBytes}-byte limit`))
        return
      }
      chunks.push(data)
    }
    const onend = () => finish(resolve, Buffer.concat(chunks).toString())
    const onerror = (err) => finish(reject, err)
    stdin.on('data', ondata)
    stdin.on('end', onend)
    stdin.on('error', onerror)
    stdin.resume()
  })
}
