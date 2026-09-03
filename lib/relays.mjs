// The nostr relays this wallet uses, and the file they are kept in.
//
// `zap` and `nutzap` are the only things here that talk to nostr, and both start by asking
// relays a question: where a user receives lightning (kind 0), how they want to be nutzapped
// (kind 10019), and — for a nutzap — where to publish the ecash itself. Which relays get
// asked used to be four urls compiled into the binary, which is a reasonable default and a
// bad permanent answer: a relay goes away, or starts refusing to serve, and the only way to
// route around it was a --relay flag typed on every run.
//
// So the list is the wallet's, the way the trusted mints are. Until something is changed it
// is the built-in defaults; the first change materializes those into the file and applies
// itself to them, so removing one relay leaves the other three rather than emptying the
// list, and `--reset` throws the file away and goes back to whatever this binary ships.
//
// Kept beside the wallet rather than inside it. A relay list is not money — losing it costs
// four urls — and `cashme zap` looks up the recipient before it opens the wallet, on purpose,
// so a lookup that fails never takes the wallet lock. Reading this must not take it either.
import { readFileSync, existsSync, mkdirSync, renameSync, writeFileSync, unlinkSync } from 'bare-fs'
import path from 'bare-path'
import { DEFAULT_RELAYS, RELAYS_FILE } from './constants.mjs'

const VERSION = 1

// A relay url as this wallet stores it: a websocket scheme, a host, and nothing trailing.
//
// `wss://` is filled in when the scheme is left off, since that is the only one anybody
// means when they type a bare hostname. `ws://` is allowed and not encouraged — it is
// cleartext to anyone on the path, who then sees which keys this wallet is asking about.
export function normalizeRelayUrl(value) {
  const typed = String(value ?? '').trim()
  if (!typed) throw new Error('a relay url is needed')

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `wss://${typed}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`not a relay url: "${value}"`)
  }

  const scheme = url.protocol.toLowerCase()
  if (scheme === 'https:') url.protocol = 'wss:'
  else if (scheme === 'http:') url.protocol = 'ws:'
  else if (scheme !== 'wss:' && scheme !== 'ws:') {
    throw new Error(`a relay is reached over wss:// or ws://, not ${url.protocol}//`)
  }
  if (!url.hostname) throw new Error(`not a relay url: "${value}"`)

  // Everything after the host is dropped: a query or a fragment on a relay url is not part
  // of the address, and a lone trailing slash is the difference between two spellings of
  // the same relay — which would otherwise both sit in the list.
  url.search = ''
  url.hash = ''
  const suffix = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${suffix}`
}

// The relays to use, and whether they are this wallet's own choice or the built-in list.
// `custom` is what lets the list say which it is rather than presenting four urls the user
// never picked as though they had.
export function readRelays(dir) {
  const file = relaysFile(dir)
  if (!existsSync(file)) return { urls: [...DEFAULT_RELAYS], custom: false }

  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (err) {
    throw new Error(`${file} is not readable as json: ${err.message}`)
  }
  if (raw.version !== VERSION) {
    throw new Error(`${file} is a version ${raw.version} relay list, expected ${VERSION}`)
  }
  const urls = Array.isArray(raw.relays) ? raw.relays.map(normalizeRelayUrl) : []
  // An empty file is a wallet that has removed every relay, which is a choice and is left
  // standing — but nothing can be looked up on no relays, so the caller is told, and the
  // commands say so rather than failing deep inside a query that answers nothing.
  return { urls: [...new Set(urls)], custom: true }
}

// The urls alone, which is what everything asking a relay a question wants.
export function relayUrls(dir) {
  return readRelays(dir).urls
}

// Add one. Idempotent: a relay already on the list is not a failure, it is the list already
// saying what the user asked it to say.
export function addRelay(dir, value) {
  const url = normalizeRelayUrl(value)
  const { urls } = readRelays(dir)
  if (urls.includes(url)) return { url, urls, added: false }
  const next = [...urls, url]
  writeRelays(dir, next)
  return { url, urls: next, added: true }
}

// Remove one, by any spelling of it.
export function removeRelay(dir, value) {
  const url = normalizeRelayUrl(value)
  const { urls } = readRelays(dir)
  if (!urls.includes(url)) throw new Error(`${url} is not on this wallet's relay list`)
  const next = urls.filter((entry) => entry !== url)
  writeRelays(dir, next)
  return { url, urls: next }
}

// Back to the built-in list, by deleting the file rather than writing the defaults into it
// — so a later version shipping a different default is picked up rather than frozen here.
export function resetRelays(dir) {
  const file = relaysFile(dir)
  if (existsSync(file)) unlinkSync(file)
  return readRelays(dir)
}

export function relaysFile(dir) {
  return path.join(dir, RELAYS_FILE)
}

// Written the way the wallet is: to a temp file, then renamed over the real one, so a crash
// leaves the old list rather than half of a new one. No fsync — this is four urls, not the
// proofs, and the cost of losing the last write is retyping one of them.
function writeRelays(dir, urls) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = relaysFile(dir)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ version: VERSION, relays: urls }, null, 2)}\n`, {
    mode: 0o600
  })
  renameSync(tmp, file)
}

// The relays one lookup should use: this wallet's list, plus where the recipient is said to
// post (a NIP-05 hint), plus anything named on the command line for this run alone. In that
// order, because the wallet's own list is the one it stands behind and the hints are a
// stranger's suggestion.
//
// A hint that is not a relay url is dropped rather than thrown over: it came from a host we
// asked about somebody else, and one bad string in it should not stop the zap.
export function relaysFor(dir, { hinted = [], extra = [] } = {}) {
  const urls = readRelays(dir).urls
  const suggested = hinted.map(readable).filter(Boolean)
  // Typed by hand, so a bad one here is a mistake worth stopping on.
  const named = extra.map((url) => normalizeRelayUrl(url))

  const all = [...new Set([...urls, ...suggested, ...named])]
  if (!all.length) {
    throw new Error(
      'this wallet has no relays, so there is nothing to look the recipient up on — ' +
        '`cashme relays --add <url>` adds one, `cashme relays --reset` puts the built-in ' +
        'list back'
    )
  }
  return all
}

function readable(value) {
  try {
    return normalizeRelayUrl(value)
  } catch {
    return null
  }
}
