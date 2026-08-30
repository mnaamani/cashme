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

export async function run({ dir }) {
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

  const app = render(h(App, { api, version: `v${pkg.version}` }))
  const result = await app.waitUntilExit()
  // The runtime has put the terminal back by now, so anything said here lands in the
  // shell's scrollback where the user can read it — including the error that ended the
  // session, which would otherwise have vanished with the alternate screen.
  if (result instanceof Error) throw result
  note('wallet closed')
}
