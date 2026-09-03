// Token delivery over the local network and nothing else: the same handover as bluetooth
// and the hyperdht, to someone on the same wi-fi. The frames are lib/token-wire.mjs,
// byte-for-byte what the other two carry — only the way the two sides find each other
// changes.
//
// Bluetooth finds a neighbour by radio and the hyperdht by announcing a key to the world.
// Here the receiver answers a question asked on the wire itself: the sender multicasts
// "anyone listening?" to a group every second, and a listening receiver replies, unicast,
// with its key and the TCP port it is accepting on. The sender then dials that port and
// runs the same Noise handshake the other two end in, so what token-wire is handed is
// again a NoiseSecretStream with the peer's key on it.
//
// Nothing leaves the LAN. Multicast datagrams go out with a TTL of 1, so the first router
// drops them, and the TCP link that follows is to an address the beacon arrived from —
// there is no server anywhere in this, no DHT to announce to, and no packet that reaches
// the internet. That is the point of it: `--lan` is the transport for two people on one
// network who would rather not put a key on a public DHT to hand over ecash across a room
// that bluetooth cannot cross.
//
// Because the receiver only ever answers, it says nothing until someone asks: there is no
// periodic announcement to overhear. Anyone on the LAN can ask, though, so a listening
// wallet is discoverable by everyone on it — the key is this run's alone (as on bluetooth,
// and unlike `--dht --stable`), so what that reveals is that a wallet is listening here
// now, not which wallet it is.
//
// Every socket here that binds at all binds 0.0.0.0, and --dht-interface does not reach
// them: it pins the hyperdht, as its name says, and this is a different transport.
//
// Worth knowing why there is no --lan-interface beside it, since three of the four sockets
// below could take one — both discovery sockets bind, and the receiver's listening socket
// does too. The fourth is the `tcp.connect` that carries the token, and Bare's TCP stack has
// no way to say which address an outgoing connection leaves from. It is nearly true that the
// connect follows the beacon, the peer being on-link, so the connected route wins; nearly,
// because two interfaces on one subnet (a docked laptop on ethernet and wi-fi at once) give
// the kernel two routes for that prefix and it picks by metric, not by which one heard the
// beacon. Closing that gap means checking the subnet is unambiguous before dialling and
// `socket.localAddress` after, and even then the SYN of a failed check has already left —
// and udx exposes no IP_MULTICAST_IF to pin the query's egress either. Pinning the beacon
// while the ecash leaves from wherever the routing table decides is not worth a flag.
import './polyfills.mjs'
import debuglog from 'bare-debug-log'
import UDX from 'udx-native'
import tcp from 'bare-tcp'
import crypto from 'hypercore-crypto'
import NoiseSecretStream from '@hyperswarm/secret-stream'
import { note } from './notes.mjs'
import { senderChannel, receiverChannel, tokenQueue } from './token-wire.mjs'

const debug = debuglog('cashme:lan')

// Every peer must agree on these three or they never meet. An administratively scoped
// group (239.0.0.0/8), which by definition is not forwarded off the local domain, and a
// port with no other claim on it.
const GROUP = '239.255.42.98'
const PORT = 42698

// Prefixes every packet, so anything else arriving on the port — another program using the
// same group — is dropped before it is parsed rather than mistaken for a peer.
const MAGIC = crypto.hash(Buffer.from('cashme/lan/v0')).subarray(0, 4)

const QUERY = 0
const BEACON = 1

// How often the sender asks. A listening receiver answers the first one within
// milliseconds, so the repeat is for the query or the answer that was dropped on the way —
// see findPeer below for why that, and not a receiver yet to start, is what it is for.
const QUERY_INTERVAL = 1000

// How long to keep asking before giving up. Unlike bluetooth, where the neighbour may still
// be walking over, this one can be answered: the receiver prints the key we were given, so
// it was listening moments ago (see findPeer). Silence for this long is therefore not
// patience being rewarded later, it is something wrong with the network — and the sender is
// holding reserved proofs while it waits, so it is told rather than left there.
const DISCOVERY_TIMEOUT = 30000

// A question with nothing in it: no key, no name, nothing that says who is asking or who
// they are looking for. The reply carries the receiver's key and the sender filters, so
// asking gives away only that someone on this LAN is about to pay somebody.
function query() {
  return Buffer.concat([MAGIC, Buffer.from([QUERY])])
}

// The answer: this run's key, and the port it is accepting TCP on. The address is not in
// here — the sender uses the one the datagram came from, which is by construction an
// address that reaches us.
function beacon(publicKey, port) {
  const tail = Buffer.alloc(3)
  tail[0] = BEACON
  tail.writeUInt16LE(port, 1)
  return Buffer.concat([MAGIC, tail, publicKey])
}

function parse(message) {
  if (message.length < MAGIC.length + 1) return null
  if (!message.subarray(0, MAGIC.length).equals(MAGIC)) return null
  const type = message[MAGIC.length]
  if (type === QUERY) return { type: QUERY }
  if (type !== BEACON || message.length !== MAGIC.length + 3 + 32) return null
  return {
    type: BEACON,
    port: message.readUInt16LE(MAGIC.length + 1),
    publicKey: message.subarray(MAGIC.length + 3)
  }
}

// Join the group on every IPv4 interface rather than letting the kernel pick one: a laptop
// on wi-fi with a VPN or a container bridge up has several, and the one multicast would
// default to is not reliably the one the other side is on. Loopback is in there too, so
// two wallets on one machine — which is how the tests run — find each other with no
// network at all.
//
// Interfaces come and go and some refuse the join; one that fails is one fewer place we
// can be found, not a reason to fail the run.
function joinGroup(socket, interfaces) {
  const joined = []
  for (const iface of interfaces) {
    if (iface.family !== 4) continue
    try {
      socket.addMembership(GROUP, iface.host)
      joined.push(iface.host)
    } catch (err) {
      debug('could not join', GROUP, 'on', iface.host, err.message)
    }
  }
  debug('joined', GROUP, 'on', joined.join(', ') || 'nothing')
  return joined
}

function parsePrefix(pubKey) {
  const prefix = String(pubKey).toLowerCase()
  if (!/^[0-9a-f]{1,64}$/.test(prefix)) {
    throw new Error(
      `--public-key must be hex from the receiver's \`cashme get --lan\`, got ${pubKey}`
    )
  }
  return prefix
}

// Resolves to a function that sends a payload to the peer, once one that matches has
// answered and the link is up.
//
// Like bluetooth and unlike the hyperdht, the key may be a prefix: the beacon carries the
// whole key and the Noise handshake proves it, so enough characters to be unambiguous in
// the room is enough to type.
//
// The receiver is already listening by the time we are typed — its key is printed by the
// run we are looking for and there is no saved address here to type from memory, the way
// `--dht --stable` allows. So the repeat is not waiting for it to appear: it is for the
// datagram that did not arrive. Multicast is unreliable by construction, kernels drop it
// under load, and wi-fi does not retry it the way it retries a unicast frame — one lost
// query would otherwise be a `give` that waits forever with a listener sitting right
// there.
//
// And because the receiver is known to have been up, giving up says something: if nothing
// at all answers, the two are not on one network as far as multicast is concerned, which is
// worth naming — it is what guest wi-fi and a good many VPNs do. If something answered but
// not this key, the network is fine and the key is stale. `cancelled` settles when the
// caller gives up first.
// `keyPair` is who we are to the peer we dial: the Noise handshake presents it, so it
// lands on them as conn.remotePublicKey. Given by the caller, so --stable reaches this
// wire the way it reaches the other two.
export function findPeer(pubKey, { keyPair, cancelled } = {}) {
  const prefix = parsePrefix(pubKey)
  const ours = keyPair ?? crypto.keyPair()
  const udx = new UDX()
  const socket = udx.createSocket()
  // Bound to an ephemeral port on every interface: the beacon comes back unicast to
  // whatever this turns out to be, so the receiver needs nothing announced about us.
  socket.bind(0, '0.0.0.0')
  // Multicast leaves the link and no further, whatever the machine's default TTL is.
  socket.setTTL(1)

  let asking = null
  let waiting = null
  let handed = false

  function stopAsking() {
    if (asking) clearInterval(asking)
    if (waiting) clearTimeout(waiting)
    asking = null
    waiting = null
  }

  async function shutdown() {
    debug('shutting down lan discovery')
    stopAsking()
    await socket.close()
  }

  const finding = new Promise((resolve, reject) => {
    note('looking for', prefix, 'on the local network')
    let found = false

    // A receiver joined on several interfaces answers once per interface, and the asking
    // repeats — report each key we cannot use once, so one wrong neighbour does not fill
    // the screen.
    const reported = new Set()

    socket.on('message', (message, rinfo) => {
      const packet = parse(message)
      if (!packet || packet.type !== BEACON || found) return

      const peer = packet.publicKey.toString('hex')
      if (!peer.startsWith(prefix)) {
        // Reaching a wallet we cannot use looks like reaching nobody, unless we say so. The
        // usual reason is a `--public-key` copied from an earlier run: the receiver's key is
        // fresh on every `cashme get`.
        if (!reported.has(peer)) {
          reported.add(peer)
          note(`saw ${peer} — not the neighbour we are looking for`)
        }
        return
      }

      found = true
      stopAsking()
      debug('beacon from', peer, 'at', `${rinfo.host}:${packet.port}`)

      // The address the beacon arrived from, not one it claimed: a peer cannot point us at
      // a third party, and on a machine with several interfaces this is the one that
      // demonstrably reaches it.
      const link = tcp.connect(packet.port, rinfo.host)
      link.on('error', (err) => {
        debug('tcp error:', err)
        if (!handed) reject(err)
      })

      // One key for the whole find, not one per link: a sender that dials two beacons
      // before one answers should not look like two wallets.
      const conn = new NoiseSecretStream(true, link, { keyPair: ours })

      conn.on('error', (err) => {
        debug('connection error:', err)
        // After the handover the link always ends in an error or a close — that is the
        // hangup, not a failure.
        if (!handed) reject(err)
      })

      conn.on('open', () => {
        // The beacon is unauthenticated — anyone on the LAN can send one. This is where
        // that stops mattering: the handshake proves the key, so a beacon that lied about
        // it ends here, with the proofs still ours.
        const actual = conn.remotePublicKey.toString('hex')
        if (!actual.startsWith(prefix)) {
          conn.destroy()
          reject(new Error(`${rinfo.host} answered for ${prefix} but handshook as ${actual}`))
          return
        }
        debug('connected to', actual)
        senderChannel(conn, {
          trace: debug,
          // discovery has to come down with the link, or the run never exits: the udx
          // socket holds the loop open.
          after: shutdown,
          onopen() {
            handed = true
          }
        }).then(resolve, reject)
      })
    })

    const ask = () => {
      socket.trySend(query(), PORT, GROUP)
    }
    asking = setInterval(ask, QUERY_INTERVAL)
    ask()

    waiting = setTimeout(() => {
      stopAsking()
      // Which of the two failures it was, because they are fixed differently: a key that
      // has moved on is retyped, a network that does not carry multicast is left for
      // `--dht`. What tells them apart is whether anything answered us at all.
      reject(
        new Error(
          reported.size
            ? `no wallet matching ${prefix} answered within ${DISCOVERY_TIMEOUT / 1000}s — ` +
                `${reported.size === 1 ? 'the one that did answer has' : `the ${reported.size} that did answer have`} ` +
                'a different key, so ask for the current one: `cashme get --lan` prints a new key every run'
            : `nobody answered on the local network within ${DISCOVERY_TIMEOUT / 1000}s — check that ` +
                'their `cashme get --lan` is still running, that you are both on the same network, and ' +
                'that it passes multicast between clients (guest wi-fi and many VPNs do not). ' +
                'Use --dht to reach them over the internet instead'
        )
      )
    }, DISCOVERY_TIMEOUT)
  })

  // A failed discovery owns the socket too — nothing else will bring it down.
  const attempt = finding.catch(async (err) => {
    if (!handed) await shutdown()
    throw err
  })

  if (!cancelled) return attempt

  return Promise.race([
    attempt,
    cancelled.then(async (reason) => {
      // The peer got here first and owns the socket; do not tear down a handoff.
      if (handed) return attempt
      await shutdown()
      throw reason instanceof Error ? reason : new Error(String(reason ?? 'cancelled'))
    })
  ])
}

// Listen for tokens until the caller gives up, calling `ontoken` once per valid one.
//
// Same shape as the other two listeners: links are handled concurrently while `ontoken` calls
// are queued, since they swap against a mint through a single wallet. A full queue withholds
// the ACK rather than accumulating an unbounded set of token strings and links.
//
// `cancelled` settles when the caller wants to stop; the socket and the server come down
// before returning.
export async function receiveTokens({ keyPair, ontoken, onaddress, cancelled } = {}) {
  // A run-only key unless the caller hands one down: it is how the sender picks us out of
  // the room, and by default it is worth nothing afterwards. Under --stable it is this
  // wallet's own address, which is worth exactly as much afterwards as that implies — see
  // lib/cli/address.mjs.
  const ours = keyPair ?? crypto.keyPair()
  const queue = tokenQueue(ontoken)

  // Every accepted socket, so shutdown can end one nobody handed a token over — a scanner,
  // or a sender that walked away mid-handshake. server.close() waits for its connections,
  // so an idle one left here is a Ctrl-C that never returns.
  const links = new Set()

  const server = tcp.createServer((socket) => {
    links.add(socket)
    socket.on('close', () => links.delete(socket))
    // isInitiator false: the sender dialled us, so it speaks first.
    const conn = new NoiseSecretStream(false, socket, { keyPair: ours })
    conn.on('error', (err) => debug('connection error:', err))
    conn.on('open', () => {
      debug('incoming connection', conn.remotePublicKey.toString('hex'))
      receiverChannel(conn, { ontoken: queue.enqueue, canReceive: queue.canReceive })
    })
  })

  // Port 0 on every interface: which port it lands on is in the beacon, so it never has to
  // be the same one twice, and nothing has to be free in advance.
  await new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '0.0.0.0', resolve)
  })
  const { port } = server.address()

  const udx = new UDX()
  // reuseAddress so a second wallet on this machine can bind the same discovery port —
  // both then hear the group, and each answers for itself.
  const socket = udx.createSocket({ reuseAddress: true })
  socket.bind(PORT, '0.0.0.0')
  socket.setTTL(1)
  joinGroup(socket, udx.networkInterfaces())

  const reply = beacon(ours.publicKey, port)
  socket.on('message', (message, rinfo) => {
    const packet = parse(message)
    if (!packet || packet.type !== QUERY) return
    debug('query from', `${rinfo.host}:${rinfo.port}`, '— answering with port', port)
    // Unicast, to whoever asked: the answer goes back down the path the question came up,
    // and no further.
    socket.trySend(reply, rinfo.port, rinfo.host)
  })

  debug('accepting on tcp port', port)
  // the sender needs this to find us, so print it rather than debug-log it
  const address = ours.publicKey.toString('hex')
  note('our public key:', address)
  // A screen that owns the terminal has nowhere to read that line from, so it is handed
  // over as well as printed — see lib/tui/screens/get.mjs.
  onaddress?.(address)
  note('waiting for tokens on the local network — Ctrl-C to stop')

  await cancelled

  debug('shutting down lan listener')
  await socket.close()
  for (const link of links) link.destroy()
  await new Promise((resolve) => server.close(resolve))
  // Let a receive still in flight finish, or a Ctrl-C mid-swap closes the wallet under it.
  await queue.drained()
}
