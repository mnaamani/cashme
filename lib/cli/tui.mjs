// `cashme ui` — the whole wallet on one screen instead of one command at a time.
//
// This command breaks the rule the others keep. Everywhere else stdout carries the payload
// and stderr carries the commentary, so a run can be piped; a full-screen UI paints over
// stdout and has no payload at all. So it refuses to start unless stdout is a terminal —
// `cashme ui | cat` is not a smaller version of this, it is escape codes in a file — and
// the commands remain the way to get a token or an invoice out of this wallet and into
// something else.
//
// It also holds the wallet for as long as it is open. There is one lock, so no other
// cashme runs while this one is up. That is the trade for a screen that can show a balance
// changing.
import tty from 'bare-tty'
import pkg from '../../package.json'
import { h } from '../tui/element.mjs'
import { render } from '../tui/runtime.mjs'
import { createApi } from '../tui/api.mjs'
import { App } from '../tui/screens/app.mjs'
import { note } from '../notes.mjs'
import { useWallet } from './session.mjs'

// Whether this run has the terminal the UI needs on both ends. Asked before the UI is
// reached for rather than after, so bare `cashme` can fall back to its help instead of
// failing at something the user never typed (see bin.mjs).
export function usable() {
  return tty.isTTY(0) && tty.isTTY(1)
}

export async function run({ dir, ephemeral = false }) {
  if (!tty.isTTY(1)) {
    throw new Error(
      'the ui needs a terminal on stdout — run it directly, or use the other commands to pipe'
    )
  }
  if (!tty.isTTY(0)) {
    throw new Error('the ui needs a terminal on stdin — there would be no way to type at it')
  }

  const wallet = await useWallet(dir)
  const api = createApi(wallet, { dir })

  const app = render(h(App, { api, version: `v${pkg.version}`, ephemeral }))
  const result = await app.waitUntilExit()
  // The runtime has put the terminal back by now, so anything said here lands in the
  // shell's scrollback where the user can read it — including the error that ended the
  // session, which would otherwise have vanished with the alternate screen.
  await handBack(api)
  if (result instanceof Error) throw result
  note('wallet closed')
}

// Ctrl-C is a keystroke in raw mode, not a signal, so the screen goes the moment it is
// pressed — which is what it should do, but it leaves any send that was mid-flight holding
// reserved proofs. Those are not lost: openWallet sweeps prepared operations, so the next
// run hands them back. But that is a run away, and until then the money is in no balance
// and in no list, which looks exactly like losing it.
//
// So the screen closes and the work carries on here, in the console, out loud. Each send
// is told to give up and then waited on, because handing the proofs back is a swap at the
// mint and the wallet must not close underneath it.
async function handBack(api) {
  const owed = api.holding()
  if (!owed.length) return

  for (const entry of owed) {
    note(
      `a send of ${entry.amount} ${entry.unit} was still being set up — ` +
        `giving the proofs back to ${entry.mintUrl}`
    )
    // Tell whatever is still waiting to stop, so it unwinds by its own path rather than
    // having the proofs pulled out from under it.
    try {
      entry.stop()
    } catch (err) {
      note(`[wallet] could not stop the send cleanly: ${err.message}`)
    }
    try {
      await entry.giveBack()
      note(`reclaimed ${entry.amount} ${entry.unit}`)
    } catch (err) {
      // Already cancelled by the send's own unwinding is the common case here, and it is
      // the outcome we wanted — say what happened rather than treating it as a failure.
      note(
        `[wallet] ${entry.amount} ${entry.unit} could not be given back now (${err.message}) — ` +
          'the next run will reclaim it'
      )
    }
  }
}
