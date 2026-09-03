// `cashme relays` — the nostr relays this wallet asks, and the two ways to change the list.
//
// The mirror of `cashme mints`, for the other set of strangers this wallet depends on. A
// mint holds the money; a relay holds the answers — where a nostr user receives lightning
// (kind 0), how they want to be nutzapped (kind 10019), and, for a nutzap, the event
// carrying the ecash itself. Nothing here is custodial, so this list costs nothing to change
// and the worst a bad entry does is fail to answer. But it is where the nostr half of this
// wallet goes looking, it is visible to whoever runs each relay, and until now it was four
// urls compiled into the binary with a --relay flag as the only way around them.
//
// The list this wallet has not touched is the built-in one. The first change starts from
// those rather than from nothing, so --remove leaves the rest standing, and --reset throws
// the wallet's list away and goes back to whatever this binary ships.
import { readRelays, addRelay, removeRelay, resetRelays } from '../relays.mjs'
import { note } from '../notes.mjs'

// Nothing here is async: the list is a small file beside the wallet and no relay is
// contacted while it is changed. `run` matches the other commands' shape all the same,
// since bin.mjs awaits whatever a handler returns.
export function run({ dir, flags }) {
  if (flags.reset) return reset(dir)
  if (flags.add) return add(dir, flags.add)
  if (flags.remove) return remove(dir, flags.remove)
  return list(dir)
}

// The urls are what this command produces, so they go to stdout one per line — `cashme
// relays | wc -l` is a reasonable thing to want. Everything explaining them goes to stderr.
function list(dir) {
  const { urls, custom } = readRelays(dir)
  for (const url of urls) console.log(url)

  if (!urls.length) {
    note('No relays. `zap` and `nutzap` have nowhere to look until one is added:')
    note('  cashme relays --add wss://relay.example')
    note('  cashme relays --reset   # back to the ones built into this binary')
    return
  }
  note('')
  note(
    custom
      ? "This wallet's own list. `cashme relays --reset` goes back to the built-in one."
      : 'The relays built into this binary — this wallet has chosen none of its own.'
  )
  note('`--add` and `--remove` change it; `zap --relay` and `nutzap --relay` add one for a run.')
}

function add(dir, value) {
  const { url, added } = addRelay(dir, value)
  // Nothing is reached here. A relay is only asked when a zap or a nutzap asks it, and a
  // relay that is down today answers tomorrow — so an unreachable one is not a reason to
  // refuse to write it down.
  note(added ? `Added ${url}.` : `${url} is already on the list.`)
  if (added) note('`zap` and `nutzap` will ask it, alongside the rest of the list.')
}

function remove(dir, value) {
  const { url, urls } = removeRelay(dir, value)
  note(`Removed ${url}.`)
  if (!urls.length) {
    note('Nothing is left to ask: `zap` and `nutzap` need at least one relay to look up a')
    note('user on. `cashme relays --reset` puts the built-in list back.')
    return
  }
  note(`${urls.length} ${urls.length === 1 ? 'relay' : 'relays'} left. --add puts one back.`)
}

function reset(dir) {
  const { urls } = resetRelays(dir)
  note(`Back to the ${urls.length} relays built into this binary:`)
  for (const url of urls) note(`  ${url}`)
}
