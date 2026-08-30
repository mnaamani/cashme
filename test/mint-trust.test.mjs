// The `--mint` flag on `get`, as typed.
//
// It is the only way past the trust gate where there is no terminal to ask on — a piped
// token, or a `get --dht` running as a service — so a short form wired to something else,
// or a flag that keeps only the last of several mints, would leave those runs unable to
// receive at all. The gate itself is checked against a real mint in
// test/integration/mint.test.mjs; this is the wiring under it.
import '../lib/polyfills.mjs'
import test from 'brittle'
import { get, root } from '../lib/cli/commands.mjs'

const flags = (argv) => {
  root.parse(argv)
  return root.current.flags
}

test('get --mint names the mints a run may receive from', (t) => {
  t.alike(flags(['get', '--mint', 'https://mint.example']).mint, ['https://mint.example'])
  t.alike(flags(['get', '-m', 'https://mint.example']).mint, ['https://mint.example'], 'short form')

  // Repeatable, because a wallet holds ecash at more than one mint and a listener should
  // not have to be restarted per mint.
  t.alike(
    flags(['get', '--mint', 'https://one.example', '--mint', 'https://two.example']).mint,
    ['https://one.example', 'https://two.example'],
    'every one given is kept, not just the last'
  )

  t.absent(flags(['get']).mint, 'and nothing is pre-approved without it')
  t.ok(get.name, 'the command is the one the CLI dispatches on')
})
