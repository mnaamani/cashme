// Must come first: coco pulls in @noble, which needs TextEncoder at module scope.
import '../lib/polyfills.mjs'
import test from 'brittle'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import { Amount, toAmount } from '@cashu/coco-core'
import { FileRepositories } from '../lib/coco-store.mjs'

const MINT = 'https://mint.example.com'

let counter = 0
function tmpdir(t) {
  const dir = path.join(os.tmpdir(), `cashme-coco-${os.pid()}-${counter++}`)
  mkdirSync(dir, { recursive: true })
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function open(t, dir) {
  const repos = new FileRepositories(dir)
  await repos.init()
  t.teardown(() => repos.lock.release())
  return repos
}

function coreProof(amount, secret) {
  return {
    id: '009a1f293253e41e',
    amount: toAmount(amount, 'sat'),
    secret,
    C: '02' + secret.padStart(64, '0'),
    mintUrl: MINT,
    unit: 'sat',
    state: 'ready'
  }
}

test('proofs survive a reload as Amounts, not as strings', async (t) => {
  const dir = tmpdir(t)

  const repos = await open(t, dir)
  await repos.proofRepository.saveProofs(MINT, [coreProof(2, 'a'), coreProof(8, 'b')])
  repos.close()

  const reopened = await open(t, dir)
  const proofs = await reopened.proofRepository.getReadyProofs(MINT)
  t.is(proofs.length, 2)

  const [first] = proofs
  t.ok(first.amount instanceof Amount, 'the amount came back as an Amount')
  // The bug this adapter exists to prevent: a plain "2" has no greaterThan, and coco only
  // finds out deep inside an operation.
  t.execution(() => first.amount.greaterThan(toAmount(1, 'sat')))
  t.is(first.amount.toNumber(), 2)
  t.is(first.secret, 'a')
})

test('mints and counters survive a reload', async (t) => {
  const dir = tmpdir(t)

  const repos = await open(t, dir)
  await repos.mintRepository.addNewMint({ mintUrl: MINT, name: 'test', isTrusted: true })
  await repos.counterRepository.setCounter(MINT, 'keyset-1', 7)
  repos.close()

  const reopened = await open(t, dir)
  const mints = await reopened.mintRepository.getAllMints()
  t.is(mints.length, 1)
  t.is(mints[0].mintUrl, MINT)
  t.is((await reopened.counterRepository.getCounter(MINT, 'keyset-1')).counter, 7)
})

test('a write lands on every mutation, without being asked to save', async (t) => {
  const dir = tmpdir(t)
  const repos = await open(t, dir)

  await repos.counterRepository.setCounter(MINT, 'keyset-1', 1)
  const written = JSON.parse(readFileSync(path.join(dir, 'wallet.json'), 'utf-8'))
  t.is(written.version, 3)
  t.ok(written.repos.counterRepository, 'the counter was on disk before anything called save')
})

test('a transaction is written once, at the end', async (t) => {
  const dir = tmpdir(t)
  const repos = await open(t, dir)

  let writes = 0
  const save = repos.save.bind(repos)
  repos.save = () => {
    writes++
    return save()
  }

  await repos.withTransaction(async (scope) => {
    await scope.counterRepository.setCounter(MINT, 'keyset-1', 1)
    await scope.counterRepository.setCounter(MINT, 'keyset-2', 2)
    await scope.proofRepository.saveProofs(MINT, [coreProof(1, 'a')])
    t.is(writes, 0, 'nothing is written while the transaction is open')
  })
  t.is(writes, 1, 'one write for the whole transaction')
})

test('reads do not trigger writes', async (t) => {
  const dir = tmpdir(t)
  const repos = await open(t, dir)
  await repos.counterRepository.setCounter(MINT, 'keyset-1', 1)

  let writes = 0
  const save = repos.save.bind(repos)
  repos.save = () => {
    writes++
    return save()
  }

  await repos.counterRepository.getCounter(MINT, 'keyset-1')
  await repos.proofRepository.getReadyProofs(MINT)
  await repos.mintRepository.getAllMints()
  t.is(writes, 0)
})

test('a type the codec does not know is refused, not flattened', async (t) => {
  const dir = tmpdir(t)
  const repos = await open(t, dir)

  // Nothing in coco stores a Date today; if that changes, this is the failure we want —
  // loud, at the write, naming the type — rather than a plain object surfacing later.
  await repos.counterRepository.setCounter(MINT, 'keyset-1', 1)
  repos.counterRepository.counters.set('bad', { when: new Date() })

  t.exception(() => repos.save(), /needs a codec for it/)
})

test('a write that fails is retried, not forgotten', async (t) => {
  const dir = tmpdir(t)
  const repos = await open(t, dir)

  const save = repos.save.bind(repos)
  repos.save = () => {
    throw new Error('disk full')
  }
  await t.exception(repos.counterRepository.setCounter(MINT, 'keyset-1', 1), /disk full/)
  t.ok(repos.dirty, 'the change is still pending')
  t.absent(existsSync(path.join(dir, 'wallet.json')), 'nothing was written')

  repos.save = save
  repos.flush()
  const written = JSON.parse(readFileSync(path.join(dir, 'wallet.json'), 'utf-8'))
  t.ok(written.repos.counterRepository, 'the pending change landed on the next flush')
})

test('a failed transaction leaves the file holding the rolled back state', async (t) => {
  const dir = tmpdir(t)
  const repos = await open(t, dir)
  await repos.counterRepository.setCounter(MINT, 'keyset-1', 1)

  await t.exception(
    repos.withTransaction(async (scope) => {
      await scope.counterRepository.setCounter(MINT, 'keyset-2', 2)
      throw new Error('mint said no')
    }),
    /mint said no/
  )

  t.is(await repos.counterRepository.getCounter(MINT, 'keyset-2'), null, 'rolled back in memory')
  const reopened = new FileRepositories(dir)
  repos.close()
  await reopened.init()
  t.teardown(() => reopened.close())
  t.is(await reopened.counterRepository.getCounter(MINT, 'keyset-2'), null, 'and on disk')
  t.is((await reopened.counterRepository.getCounter(MINT, 'keyset-1')).counter, 1, 'kept the rest')
})

test('a write failing during rollback does not hide why the transaction failed', async (t) => {
  const dir = tmpdir(t)
  const repos = await open(t, dir)

  repos.save = () => {
    throw new Error('disk full')
  }
  await t.exception(
    repos.withTransaction(async (scope) => {
      await scope.counterRepository.setCounter(MINT, 'keyset-1', 1)
      throw new Error('mint said no')
    }),
    /mint said no/,
    'the transaction error survives, not the disk error'
  )
  t.ok(repos.dirty, 'and the write is still pending')
})

test('a wallet from a future version is refused', async (t) => {
  const dir = tmpdir(t)
  writeFileSync(path.join(dir, 'wallet.json'), JSON.stringify({ version: 99, repos: {} }))

  const repos = new FileRepositories(dir)
  await t.exception(repos.init(), /version 99 wallet/)
  t.absent(repos.lock.fd, 'the lock was released when the load failed')
})

test('only one instance may hold a wallet', async (t) => {
  const dir = tmpdir(t)
  const first = await open(t, dir)

  const second = new FileRepositories(dir)
  await t.exception(second.init(), /another cashme instance/)

  first.close()
  const third = new FileRepositories(dir)
  await t.execution(third.init(), 'the lock is available once released')
  third.close()
})

test('the seed is kept alongside the repositories', async (t) => {
  const dir = tmpdir(t)
  const repos = await open(t, dir)
  repos.seedHex = 'ab'.repeat(64)
  repos.save()
  repos.close()

  const reopened = await open(t, dir)
  t.is(reopened.seedHex, 'ab'.repeat(64))
})
