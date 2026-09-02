// `cashme mints` — which mints this wallet trusts, and the two ways to change that.
//
// Trust is the decision behind every other command. A mint holds the bitcoin backing our
// ecash; trusting one means holding a claim against whoever runs it, and means a later send
// may be funded from it. Everywhere else that decision is made as a side effect of
// something — `deposit --mint` names one, `get` asks about the mint a token arrived from —
// which is right in the moment but leaves no way to see the accumulated answer, or to take
// one back. That is what this is.
//
// Untrusting does not remove the mint or its proofs. It stops them being spendable until
// the mint is trusted again, which makes it the reversible move: quarantine a mint you have
// gone off, and change your mind later without losing what is at it.
import tty from 'bare-tty'
import { trustMint, untrustMint, mintDetails } from '../manager.mjs'
import { normalizeMintUrl } from '../mint-url.mjs'
import { note } from '../notes.mjs'
import { useWallet } from './session.mjs'
import { confirm } from './ui.mjs'

export async function run({ dir, flags }) {
  const wallet = await useWallet(dir)

  if (flags.trust) return trust(wallet, flags.trust)
  if (flags.untrust) return untrust(wallet, flags.untrust, flags)
  return list(wallet)
}

// The list is what this command produces, so it goes to stdout — `cashme mints | grep` is a
// reasonable thing to want. Everything explaining it goes to stderr with the rest.
async function list(wallet) {
  const mints = (await mintDetails(wallet)).sort(byUrl)
  if (!mints.length) {
    note('No mints yet. `cashme deposit --mint <url>` or `cashme mints --trust <url>` adds one.')
    return
  }

  // Padded from the longest url rather than a constant, so the columns line up whatever is
  // in the wallet.
  const column = Math.max(...mints.map((mint) => mint.mintUrl.length))
  for (const mint of mints) {
    const state = mint.trusted ? 'trusted' : 'untrusted'
    console.log(`${mint.mintUrl.padEnd(column)}  ${state.padEnd(9)}  ${held(mint)}`)
  }

  // Said once, under the list, rather than beside every line of it: what an untrusted mint
  // means is one fact, and the way back is the part worth printing.
  const untrusted = mints.filter((mint) => !mint.trusted)
  if (!untrusted.length) return
  note('')
  note('Nothing can be spent from an untrusted mint until it is trusted again:')
  for (const mint of untrusted) note(`  cashme mints --trust ${mint.mintUrl}`)
}

async function trust(wallet, mintUrl) {
  // Reaching the mint is part of trusting it: a url that does not answer as one should fail
  // here rather than at the first send funded from it.
  const url = await trustMint(wallet, mintUrl)
  note(`Trusting ${url}.`)
  note('Ecash from it can be received, and a later send may be funded from it.')
}

async function untrust(wallet, mintUrl, flags) {
  const url = normalizeMintUrl(mintUrl)
  const mint = (await mintDetails(wallet)).find((entry) => entry.mintUrl === url)
  if (!mint) throw new Error(`${url} is not a mint this wallet knows`)
  if (!mint.trusted) {
    note(`${url} is already untrusted.`)
    return
  }

  // The ecash does not go anywhere, but it stops being spendable — which is the part
  // somebody has to agree to, and only when there is some.
  const worth = held(mint)
  if (worth !== NOTHING) {
    note(`${url} holds ${worth}.`)
    note('Untrusting it does not remove that ecash, but nothing can be spent from it until')
    note('the mint is trusted again.')
    if (!(await agreed(flags))) {
      note('Left trusted.')
      return
    }
  }

  await untrustMint(wallet, url)
  note(`Untrusted ${url}.`)
  note(`\`cashme mints --trust ${url}\` puts it back.`)
}

// --yes, or an answer at the terminal. With neither — a pipe, a script — the question
// cannot be put, so the run stops rather than deciding on the user's behalf.
function agreed(flags) {
  if (flags.yes) return true
  if (!tty.isTTY(0)) {
    throw new Error('there is no terminal here to ask — rerun with --yes to untrust it anyway')
  }
  return confirm('Untrust it?')
}

const NOTHING = '—'

// What a mint holds, as one string, or an em dash when it holds nothing. Reserved proofs
// are named separately: they are at the mint too, and untrusting strands them the same way.
function held(mint) {
  const worth = mint.units
    .filter((unit) => unit.spendable || unit.reserved)
    .map((unit) => {
      const reserved = unit.reserved ? ` (+ ${unit.reserved} reserved)` : ''
      return `${unit.spendable} ${unit.unit}${reserved}`
    })
  return worth.length ? worth.join('  ') : NOTHING
}

function byUrl(a, b) {
  return a.mintUrl < b.mintUrl ? -1 : a.mintUrl > b.mintUrl ? 1 : 0
}
