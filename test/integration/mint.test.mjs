// The wallet against a real mint, driven through the CLI a user actually types.
//
// Everything here spends: a throwaway wallet directory per test, and a mint that issues
// ecash without a lightning payment. Nothing touches a real wallet. What is being checked
// is that ecash survives a full round trip — minted, sent, claimed, reclaimed — and that
// the balance says so at every step.
import '../../lib/polyfills.mjs'
import test from 'brittle'
import { readFileSync, writeFileSync } from 'bare-fs'
import path from 'bare-path'
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
  t.ok(token, `a token is printed${token ? '' : `. Output:\n${give.output}`}`)

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
  t.ok(
    token,
    `a token to offer a wallet that has never heard of this mint${token ? '' : `. Output:\n${give.output}`}`
  )

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

test('trust is a list that can be read, taken back, and given again', opts, async (t) => {
  const dir = walletdir(t)
  await cli(dir, ['deposit', '--amount', '200', '--mint', MINT])

  const listed = await cli(dir, ['mints'])
  t.is(listed.code, 0, '`cashme mints` succeeds')
  t.ok(new RegExp(`${MINT}\\s+trusted`).test(listed.output), 'the mint deposited at is trusted')

  // Untrusting keeps the ecash and keeps the mint on the list. What it takes away is the
  // ability to spend, which is the whole of what trust means to coco.
  const off = await cli(dir, ['mints', '--untrust', MINT, '--yes'])
  t.is(off.code, 0, 'it can be untrusted')
  t.ok(/does not remove that ecash/.test(off.output), 'saying what that costs')

  const after = await cli(dir, ['mints'])
  t.ok(new RegExp(`${MINT}\\s+untrusted`).test(after.output), 'and the list says so')

  const balance = await cli(dir, ['balance'])
  t.is(satsIn(balance.output, 'Balance'), 200, 'the ecash is still ours and still counted')
  t.ok(/is untrusted, so nothing above at it can be spent/.test(balance.output), 'with the caveat')

  // The claim the warning makes, checked rather than assumed: this is what untrusting is for.
  const refused = await cli(dir, ['give', '--print', '--amount', '50'])
  t.not(refused.code, 0, 'and nothing can be spent from it')
  t.ok(/not trusted/.test(refused.output), 'because the mint is not trusted')

  const on = await cli(dir, ['mints', '--trust', MINT])
  t.is(on.code, 0, 'trusting it again succeeds')

  const give = await cli(dir, ['give', '--print', '--amount', '50'], {
    until: /waiting for the receiver/
  })
  t.ok(/cashuB[A-Za-z0-9_-]+/.test(give.output), 'and the ecash is spendable once more')
})

test('a mint can be trusted by name, before it has ever been used', opts, async (t) => {
  const dir = walletdir(t)

  const trusted = await cli(dir, ['mints', '--trust', MINT])
  t.is(trusted.code, 0, 'a url alone is enough to trust one')

  const listed = await cli(dir, ['mints'])
  t.ok(new RegExp(`${MINT}\\s+trusted`).test(listed.output), 'it is on the list')
  // Trusted and empty is a real state, and it has to read as one rather than as a balance
  // of zero somethings.
  t.ok(/—/.test(listed.output), 'holding nothing, said as nothing rather than as 0')

  // The url is reached as part of trusting it, so one that is not a mint fails here.
  const bogus = await cli(dir, ['mints', '--trust', 'https://not-a-mint.invalid'])
  t.not(bogus.code, 0, 'and a url that is not a mint is refused rather than recorded')
})

test('a mint that cannot be reached can still be untrusted', opts, async (t) => {
  // Quarantining a mint you cannot reach is the case this matters most in, and it is the
  // one coco makes awkward: untrustMint writes the decision and then refreshes the mint's
  // info, which goes to the network whenever the cached copy is older than its five minute
  // TTL. Unhandled, that reports a failure for an untrust that already happened.
  const dir = walletdir(t)
  await cli(dir, ['mints', '--trust', MINT])

  // Age the cached record past the TTL, which is what a wallet opened tomorrow looks like.
  const file = path.join(dir, 'wallet.json')
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  for (const [, mint] of stored.repos.mintRepository.mints.$map) mint.updatedAt = 0
  writeFileSync(file, JSON.stringify(stored))

  // A proxy pointing at nothing is the cheapest way to be offline for one run.
  const off = await cli(dir, [
    '--proxy',
    'socks5://127.0.0.1:1',
    'mints',
    '--untrust',
    MINT,
    '--yes'
  ])
  t.is(off.code, 0, 'the untrust succeeds rather than reporting the failed refresh')
  t.ok(/Untrusted/.test(off.output), 'and says so')

  const listed = await cli(dir, ['mints'])
  t.ok(new RegExp(`${MINT}\\s+untrusted`).test(listed.output), 'the wallet agrees afterwards')
})
