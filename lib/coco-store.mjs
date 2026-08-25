import './polyfills.mjs'
import { MemoryRepositories, Amount } from '@cashu/coco-core'
import { serializeAmount, deserializeAmount } from '@cashu/coco-core/adapter'
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'bare-fs'
import path from 'bare-path'
import { WALLET_FILE, WALLET_LOCK_FILE } from './constants.mjs'
import { StoreLock } from './lock.mjs'

// A `Repositories` implementation for Bare, so coco can run here at all: its published
// adapters are better-sqlite3, bun:sqlite, IndexedDB and expo-sqlite, none of which load
// under Bare.
//
// coco's own MemoryRepositories already implements every query correctly, so this keeps
// them and adds the two things they lack: durability and rollback. Each repository is
// wrapped in a proxy that writes the whole file after any mutating call — affordable only
// because a personal wallet stays small.
//
// The subtlety is serialization. Repositories hold `Amount` instances, and `Amount`
// stringifies to a bare `"21"` — indistinguishable from a plain string on the way back in,
// which is why a naive JSON round trip yields `amount.greaterThan is not a function` deep
// inside coco. So Amounts and bigints are tagged on the way out and rebuilt on the way in,
// and any other class instance is refused loudly rather than silently flattened.

const VERSION = 3

// Repository methods that only read; every repository in coco's contract names them
// `get*`, `is*` or `list`. Anything else is treated as a mutation and triggers a write, so
// a method added upstream is saved by default rather than silently dropped.
const READ_ONLY = /^(get|is|list)/

export class FileRepositories extends MemoryRepositories {
  // `dir` holds wallet.json; `wait` blocks on the wallet lock rather than failing when
  // another instance has it.
  constructor(dir, { wait = false } = {}) {
    super()
    this.dir = dir
    this.file = path.join(dir, WALLET_FILE)
    this.lock = new StoreLock(path.join(dir, WALLET_LOCK_FILE))
    this.seedHex = null
    this.batching = false
    this.dirty = false
    this.wait = wait
    this.transaction = null // resolves when the open transaction finishes

    // Keep the unwrapped repositories: a transaction scope wraps these, not the gated
    // proxies below, or a transaction would end up waiting for itself.
    Object.defineProperty(this, 'raw', { value: repositories(this), enumerable: false })
    for (const [name, repo] of this.raw) {
      // Root repositories: writes wait for any open transaction (see withTransaction).
      this[name] = persistOn(
        repo,
        () => this.touch(),
        () => this.transaction
      )
    }
  }

  // coco calls this once at startup. Nothing here awaits, but the contract is a promise.
  init() {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
      this.lock.acquire({ wait: this.wait })
    } catch (err) {
      // another instance holds the wallet, or the directory is not usable
      return Promise.reject(err)
    }
    try {
      this.load()
    } catch (err) {
      // a wallet we could not read is a wallet we must not hold open
      this.lock.release()
      return Promise.reject(err)
    }
    return Promise.resolve()
  }

  close() {
    this.flush()
    this.lock.release()
  }

  // A transaction commits once, or not at all. coco's contract requires a failed
  // transaction to leave no trace, and repositories held in memory do not roll back on
  // their own — so the whole state is snapshotted going in and put back on the way out.
  // That is affordable here only because a personal wallet is small.
  //
  // Rolling the whole state back is only safe if nothing else writes while a transaction
  // is open: a snapshot restore would undo those writes too, which is the hazard called
  // out in coco's own fix for its memory repositories
  // (https://github.com/cashubtc/coco/pull/429, issue #422). coco's watchers and
  // processors run on timers during a command, so this is reachable here. The transaction
  // therefore gets its own scope, and writes through the root repositories queue behind it
  // — which is what coco's `testConcurrentRootOperationIsolation` contract case requires.
  async withTransaction(fn) {
    if (this.batching) return fn(this)

    const rollback = this.serializeRepos()
    const scope = this.transactionScope()
    let open
    this.transaction = new Promise((resolve) => {
      open = resolve
    })
    this.batching = true

    let result
    let failure = null
    try {
      result = await fn(scope)
    } catch (err) {
      failure = err
      // Put back what was there before, and leave it dirty: the flush below writes the
      // restored state, which also picks up any write that failed before this began.
      this.applyRepos(JSON.parse(rollback, revive))
    }
    this.batching = false
    this.transaction = null
    open() // let the queued root writes through, onto the state we just settled

    try {
      this.flush()
    } catch (err) {
      // A write that fails while a transaction is already failing must not stand in for
      // it: the caller needs the reason the transaction was rejected, not the disk error
      // that followed. The change stays dirty either way, so the next flush retries it.
      if (!failure) throw err
      console.error('[wallet] could not write the rolled back state:', err.message)
    }

    if (failure) throw failure
    return result
  }

  // The repositories a transaction callback writes through. Same underlying data, but
  // ungated: a transaction must never wait for itself.
  transactionScope() {
    const scope = Object.create(this)
    for (const [name, repo] of this.raw) {
      Object.defineProperty(scope, name, {
        value: persistOn(repo, () => this.touch()),
        enumerable: true
      })
    }
    return scope
  }

  touch() {
    this.dirty = true
    if (!this.batching) this.flush()
  }

  flush() {
    if (!this.dirty) return
    // Cleared only once the write has actually landed. Clearing first would turn a
    // transient failure — a full disk, a codec the adapter lacks — into a change that is
    // in memory, absent from the file, and never retried.
    this.save()
    this.dirty = false
  }

  load() {
    if (!existsSync(this.file)) return this
    const raw = JSON.parse(readFileSync(this.file, 'utf-8'), revive)
    if (raw.version !== VERSION) {
      throw new Error(`${this.file} is a version ${raw.version} wallet, expected ${VERSION}`)
    }
    this.seedHex = raw.seed ?? null
    this.applyRepos(raw.repos)
    return this
  }

  save() {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    const tmp = this.file + '.tmp'
    const body = `{"version":${VERSION},"seed":${JSON.stringify(this.seedHex)},"repos":${this.serializeRepos()}}`
    writeFileSync(tmp, body, { mode: 0o600 })
    renameSync(tmp, this.file)
    return this
  }

  // The state every repository holds, as JSON. Doubles as the rollback snapshot.
  serializeRepos() {
    const repos = {}
    for (const [name, repo] of repositories(this)) {
      const state = {}
      for (const field of persistedFields(repo)) state[field] = repo[field]
      if (Object.keys(state).length) repos[name] = state
    }
    return JSON.stringify(repos, persist)
  }

  // Replace what the repositories hold. Fields absent from the snapshot are emptied rather
  // than left alone, or a rollback would keep whatever the failed transaction added.
  applyRepos(state = {}) {
    for (const [name, repo] of repositories(this)) {
      const saved = state?.[name] ?? {}
      for (const field of persistedFields(repo)) {
        const value = saved[field]
        if (value !== undefined) repo[field] = value
        else if (repo[field] instanceof Map) repo[field] = new Map()
        else repo[field] = []
      }
      for (const [field, value] of Object.entries(saved)) repo[field] = value
    }
    return this
  }
}

// The repositories, as the proxies that wrap them — only functions are intercepted, so
// reading and writing a field through one lands on the repository itself.
function repositories(repos) {
  return Object.entries(repos).filter(
    ([name, value]) => name.endsWith('Repository') && value && typeof value === 'object'
  )
}

// The Maps and arrays a repository keeps its data in. `historyRepository` also holds
// references to other repositories, but those are wiring rather than state and are plain
// objects, so they are skipped.
function persistedFields(repo) {
  return Object.keys(repo).filter((key) => repo[key] instanceof Map || Array.isArray(repo[key]))
}

// `gate` returns the open transaction, if any. Mutations wait for it; reads do not, so a
// read during a transaction sees the uncommitted state rather than deadlocking on it.
function persistOn(repo, onMutate, gate) {
  return new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value

      // Every method is bound to the target rather than the proxy. A method called off the
      // proxy would otherwise see `this` as the proxy, and its own internal helpers — the
      // `key()` a counter repository builds its map keys with, say — would re-enter this
      // trap and be counted as mutations.
      if (READ_ONLY.test(String(prop))) return value.bind(target)

      return function (...args) {
        // Saved whether the call succeeds or not: a method that fails part way through has
        // still changed what is held in memory, and leaving that unwritten would let the
        // file and the wallet drift apart. Inside a transaction this only marks dirty —
        // the rollback there is what undoes a failure.
        const apply = () => {
          let result
          try {
            result = value.apply(target, args)
          } catch (err) {
            onMutate()
            throw err
          }
          if (result instanceof Promise) return result.finally(() => onMutate())
          onMutate()
          return result
        }

        const open = gate?.()
        return open ? open.then(apply) : apply()
      }
    }
  })
}

// --- serialization ---------------------------------------------------------------------

// `this[key]` is the value before `toJSON()` ran, which is the only way to tell an Amount
// from the string it serializes to.
function persist(key, value) {
  const raw = this[key]
  if (raw instanceof Amount) return { $amount: serializeAmount(raw) }
  if (typeof raw === 'bigint') return { $bigint: raw.toString() }
  if (raw instanceof Uint8Array) return { $bytes: Buffer.from(raw).toString('hex') }
  if (raw instanceof Map) return { $map: [...raw.entries()] }
  if (raw && typeof raw === 'object') {
    const name = raw.constructor?.name
    // Anything else with a class identity would come back as a plain object and fail
    // somewhere deep inside coco. Fail here instead, where the cause is obvious.
    if (name && name !== 'Object' && name !== 'Array') {
      throw new Error(`cannot persist a ${name} at "${key}" — this adapter needs a codec for it`)
    }
  }
  return value
}

function revive(key, value) {
  if (value === null || typeof value !== 'object') return value
  if ('$amount' in value) return deserializeAmount(value.$amount)
  if ('$bigint' in value) return BigInt(value.$bigint)
  if ('$bytes' in value) return new Uint8Array(Buffer.from(value.$bytes, 'hex'))
  if ('$map' in value) return new Map(value.$map)
  return value
}
