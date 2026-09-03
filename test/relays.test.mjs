// The relay list: how a url is written down, how the file behaves, and what a lookup gets.
//
// The list decides where `zap` and `nutzap` go looking, and the part worth pinning down is
// the first change: it starts from the relays built into the binary rather than from
// nothing, so removing one leaves the rest instead of emptying the list.
import '../lib/polyfills.mjs'
import test from 'brittle'
import os from 'bare-os'
import path from 'bare-path'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'bare-fs'
import {
  normalizeRelayUrl,
  readRelays,
  relayUrls,
  relaysFor,
  addRelay,
  removeRelay,
  resetRelays,
  relaysFile
} from '../lib/relays.mjs'
import { DEFAULT_RELAYS } from '../lib/constants.mjs'
import { relays, root } from '../lib/cli/commands.mjs'

function storage(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cashme-relays-'))
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const flags = (argv) => {
  root.parse(argv)
  return root.current.flags
}

test('a relay url is written down one way, however it was typed', (t) => {
  t.is(normalizeRelayUrl('wss://relay.example'), 'wss://relay.example')
  t.is(normalizeRelayUrl('  wss://relay.example  '), 'wss://relay.example', 'trimmed')
  t.is(normalizeRelayUrl('relay.example'), 'wss://relay.example', 'wss is the assumed scheme')
  t.is(normalizeRelayUrl('wss://relay.example/'), 'wss://relay.example', 'no trailing slash')
  t.is(normalizeRelayUrl('https://relay.example'), 'wss://relay.example', 'https means wss')
  t.is(normalizeRelayUrl('http://relay.example'), 'ws://relay.example', 'and http means ws')
  t.is(normalizeRelayUrl('wss://relay.example/nostr/'), 'wss://relay.example/nostr', 'a path stays')
  t.is(
    normalizeRelayUrl('wss://relay.example?x=1#y'),
    'wss://relay.example',
    'a query or a fragment is not part of the address'
  )

  // ws:// is allowed and not encouraged; anything that is not a websocket is refused, so a
  // mint url pasted into the wrong command fails here rather than on a lookup that answers
  // nothing.
  t.is(normalizeRelayUrl('ws://localhost:7000'), 'ws://localhost:7000')
  t.exception(() => normalizeRelayUrl('ftp://relay.example'), /wss:\/\/ or ws:\/\//)
  t.exception(() => normalizeRelayUrl(''), /a relay url is needed/)
})

test('an untouched wallet uses the relays built into the binary', (t) => {
  const dir = storage(t)

  const { urls, custom } = readRelays(dir)
  t.alike(urls, DEFAULT_RELAYS, 'the built-in list')
  t.absent(custom, 'and it says it is not this wallet’s own')
  t.absent(existsSync(relaysFile(dir)), 'nothing is written until something is changed')
})

test('the first change starts from the built-in list rather than from nothing', (t) => {
  const dir = storage(t)

  const gone = DEFAULT_RELAYS[0]
  removeRelay(dir, gone)
  const after = readRelays(dir)
  t.alike(after.urls, DEFAULT_RELAYS.slice(1), 'removing one leaves the rest standing')
  t.ok(after.custom, 'and the list is now this wallet’s own')

  const { added, urls } = addRelay(dir, 'relay.example')
  t.ok(added)
  t.is(urls[urls.length - 1], 'wss://relay.example', 'an addition goes on the end')

  t.absent(addRelay(dir, 'wss://relay.example/').added, 'the same relay twice is not an error')
  t.is(relayUrls(dir).length, urls.length, 'and does not appear twice')

  t.exception(() => removeRelay(dir, 'wss://nobody.example'), /is not on this wallet/)
})

test('reset deletes the list rather than writing the defaults into it', (t) => {
  const dir = storage(t)
  addRelay(dir, 'wss://relay.example')
  t.ok(existsSync(relaysFile(dir)))

  const { urls, custom } = resetRelays(dir)
  t.alike(urls, DEFAULT_RELAYS, 'back to what this binary ships')
  t.absent(custom)
  // The file is gone, not rewritten — so a later version shipping a different default is
  // picked up rather than frozen here.
  t.absent(existsSync(relaysFile(dir)), 'the file is gone')
})

test('a lookup gets the list, the hints and the flags, in that order', (t) => {
  const dir = storage(t)
  resetRelays(dir)

  const urls = relaysFor(dir, {
    hinted: ['wss://hinted.example', 'not a relay at all'],
    extra: ['extra.example', DEFAULT_RELAYS[0]]
  })
  t.alike(
    urls,
    [...DEFAULT_RELAYS, 'wss://hinted.example', 'wss://extra.example'],
    'this wallet’s own list first, then where the recipient is said to post, then the flags'
  )

  // A hint came from a host we asked about somebody else; a flag was typed by hand.
  t.exception(() => relaysFor(dir, { extra: ['ftp://relay.example'] }), /wss:\/\/ or ws:\/\//)
})

test('a wallet with no relays says so rather than querying nothing', (t) => {
  const dir = storage(t)
  for (const url of DEFAULT_RELAYS) removeRelay(dir, url)

  t.alike(relayUrls(dir), [], 'removing every relay is allowed — it is a choice')
  t.exception(() => relaysFor(dir), /this wallet has no relays/)
  t.exception(() => relaysFor(dir, { hinted: ['ftp://nope'] }), /this wallet has no relays/)
  t.alike(
    relaysFor(dir, { hinted: ['wss://hinted.example'] }),
    ['wss://hinted.example'],
    'but a relay the lookup itself found is still somewhere to ask'
  )
})

test('a relay list this binary cannot read is refused rather than half-used', (t) => {
  const dir = storage(t)
  writeFileSync(relaysFile(dir), JSON.stringify({ version: 99, relays: ['wss://relay.example'] }))
  t.exception(() => readRelays(dir), /version 99 relay list/)

  writeFileSync(relaysFile(dir), 'not json')
  t.exception(() => readRelays(dir), /not readable as json/)
})

test('the relays command reads the list, and changes one thing at a time', (t) => {
  t.is(flags(['relays', '--add', 'wss://relay.example']).add, 'wss://relay.example')
  t.is(flags(['relays', '--remove', 'wss://relay.example']).remove, 'wss://relay.example')
  t.ok(flags(['relays', '--reset']).reset)

  t.absent(flags(['relays']).add, 'and with no flags it only reads')
  t.absent(flags(['relays']).remove)
  t.ok(relays.name, 'the command is the one the CLI dispatches on')
})
