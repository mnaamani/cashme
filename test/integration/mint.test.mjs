// The wallet against a real mint, driven through the CLI a user actually types.
//
// Everything here spends: a throwaway wallet directory per test, and a mint that issues
// ecash without a lightning payment. Nothing touches a real wallet. What is being checked
// is that ecash survives a full round trip — minted, sent, claimed, reclaimed — and that
// the balance says so at every step.
import '../../lib/polyfills.mjs'
import test from 'brittle'
import { cli, walletdir, satsIn, MINT, OFFLINE } from './helpers.mjs'

const opts = { skip: OFFLINE, timeout: 300000 }

test('ecash is minted, and the balance says so', opts, async (t) => {
  const dir = walletdir(t)

  const deposit = await cli(dir, ['deposit', '--amount', '200', '--mint', MINT])
  t.is(deposit.code, 0, '`cashme deposit` succeeds')
  t.is(satsIn(deposit.output, 'New Balance'), 200)

  const balance = await cli(dir, ['balance'])
  t.is(satsIn(balance.output, 'Balance'), 200, 'and it is still there on the next run')
})

test('a token round trips through the mint and comes back whole', opts, async (t) => {
  const dir = walletdir(t)
  await cli(dir, ['deposit', '--amount', '200', '--mint', MINT])

  // --print leaves the send pending: the token is out there, and the wallet cannot know
  // whether anyone took it. That is why the amount leaves the balance immediately, and why
  // the command keeps waiting once the token is printed.
  const give = await cli(dir, ['give', '--print', '--amount', '50'], {
    until: /waiting for the receiver/
  })
  const token = /cashuB[A-Za-z0-9_-]+/.exec(give.output)?.[0]
  t.ok(token, 'a token is printed')

  const sent = await cli(dir, ['balance'])
  t.ok(satsIn(sent.output, 'Balance') < 200, 'the sent ecash is out of the balance')

  const get = await cli(dir, ['get', '--token', token])
  t.is(get.code, 0, '`cashme get` claims it')
  t.ok(/receiving 50 sat/.test(get.output), 'for the amount that was sent')

  // The mint has now seen those proofs spent, so the send is no longer outstanding: the
  // next run notices and closes it out, rather than leaving it pending forever.
  const pending = await cli(dir, ['pending'])
  t.ok(/No sends waiting to settle/.test(pending.output), 'the send settles itself')

  // Back where we started, less the mint's fee for the two swaps it took to get here.
  const back = satsIn((await cli(dir, ['balance'])).output, 'Balance')
  t.ok(back <= 200 && back > 190, `the ecash came back whole (${back} sat)`)
})

test('a mint the wallet has never used is refused, not trusted', opts, async (t) => {
  const sender = walletdir(t)
  await cli(sender, ['deposit', '--amount', '200', '--mint', MINT])

  const give = await cli(sender, ['give', '--print', '--amount', '50'], {
    until: /waiting for the receiver/
  })
  const token = /cashuB[A-Za-z0-9_-]+/.exec(give.output)?.[0]
  t.ok(token, 'a token to offer a wallet that has never heard of this mint')

  // A fresh wallet, so the mint the token names is a stranger — and a test has no terminal
  // to be asked on, which is the case a listening `get` runs in on a server.
  const stranger = walletdir(t)
  const refused = await cli(stranger, ['get', '--token', token])
  t.not(refused.code, 0, 'the claim fails rather than trusting whoever issued the token')
  t.ok(/never used/.test(refused.output), 'and says why')
  t.ok(new RegExp(`--mint ${MINT}`).test(refused.output), 'naming the way to accept it')

  // Refusing must leave nothing behind: a mint recorded here would be one a later send
  // could be funded from, which is the whole point of not trusting it.
  const balance = await cli(stranger, ['balance'])
  t.absent(new RegExp(MINT).test(balance.output), 'the mint was not added to the wallet')

  // The same token, the same wallet, with the mint named: the ecash arrives.
  const accepted = await cli(stranger, ['get', '--token', token, '--mint', MINT])
  t.is(accepted.code, 0, '`--mint` is what lets it through')
  t.ok(satsIn(accepted.output, 'New Balance') >= 49, 'and the ecash lands in the balance')
})

test('a send nobody claimed is handed back', opts, async (t) => {
  const dir = walletdir(t)
  await cli(dir, ['deposit', '--amount', '200', '--mint', MINT])

  const before = satsIn((await cli(dir, ['balance'])).output, 'Balance')
  await cli(dir, ['give', '--print', '--amount', '50'], { until: /waiting for the receiver/ })

  const pending = await cli(dir, ['pending'])
  t.ok(/unclaimed 50 sat/.test(pending.output), 'the unclaimed send is listed')

  const reclaim = await cli(dir, ['pending', '--reclaim'])
  t.ok(/reclaimed 50 sat/.test(reclaim.output), 'and --reclaim takes it back')

  // Reclaiming swaps at the mint, which costs the input fee — so what comes back is the
  // balance less fees, never more than we started with.
  const after = satsIn((await cli(dir, ['balance'])).output, 'Balance')
  t.ok(after <= before, 'nothing is conjured by a reclaim')
  t.ok(after > before - 50, 'and the 50 sat is not lost either')
})

test('restore refuses to double up proofs the wallet already holds', opts, async (t) => {
  const dir = walletdir(t)
  await cli(dir, ['deposit', '--amount', '200', '--mint', MINT])

  // NUT-13 rebuilds proofs from the seed. Run against a wallet that still has them, coco
  // refuses the whole keyset rather than adding a second copy — which would be a balance
  // that does not exist.
  const restore = await cli(dir, ['restore', '--mint', MINT])
  t.ok(/already holds/.test(restore.output), 'it says why it will not')

  const balance = await cli(dir, ['balance'])
  t.is(satsIn(balance.output, 'Balance'), 200, 'and the balance is untouched')
})
