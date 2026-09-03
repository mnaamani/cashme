# Where the traffic goes

The commands default to giving away as little as they can — one-run keys, no reusable
address, nothing announced unless asked for. What they cannot hide by themselves is the IP
address the packets leave from: a mint sees where its user is, and so does a relay, an
lnurl host and a NIP-05 domain. `--proxy` is how to change that.

```sh
cashme --proxy socks5://127.0.0.1:1080 balance
cashme --proxy socks5h://127.0.0.1:1080 deposit -a 100  # the same thing, spelled the other way
cashme --proxy http://proxy.lan:3128 restore            # an http proxy
cashme --proxy socks5://user:pass@127.0.0.1:1080 zap -p npub1... -s 21
export CASHME_PROXY=socks5://127.0.0.1:1080             # or set it once for every run
```

Failing both of those, the environment is read the way curl reads it, so a machine already
set up for a proxy needs nothing said here:

```sh
export https_proxy=socks5://127.0.0.1:1080   # https, wss, and anything ALL_PROXY would cover
export http_proxy=http://proxy.lan:3128      # http and ws
export ALL_PROXY=socks5://127.0.0.1:1080     # both, when neither of the above is set
export no_proxy=localhost,127.0.0.1,.lan     # hosts to reach directly anyway
```

The convention in full: the lower case spelling wins where both are set, `ALL_PROXY` is the
fallback for a scheme with no proxy of its own, and a value may be written `host:port` with
no scheme, which means `http://`. The port is never left out — a proxy url with no port is
refused rather than given one, since 80, 443, 1080 and 8080 all have a claim to being the
default and a guess that lands on the wrong service is handed your proxy password before
anything notices. `http_proxy` is read in **lower case only** — under CGI a
request header `Proxy:` arrives as `HTTP_PROXY` in the environment, so honouring the upper
case spelling would let whoever sent the request choose the proxy. `no_proxy` is a
comma-separated list where `*` alone means every host, an entry matches the hostname or any
domain under it (`local.com` covers `www.local.com`, not `www.notlocal.com`), and an entry
may be an address or a CIDR block.

One way this is deliberately not curl: `no_proxy` carves holes only in a proxy that came
from the environment. A `--proxy` or `CASHME_PROXY` you named covers everything, because an
ambient variable should not be able to punch a hole in a proxy you asked for by name.

Every http request the wallet makes is given 30 seconds to be answered, proxy or no proxy.
Bare's fetch has no deadline of its own, so a mint that accepts a connection and then says
nothing would otherwise hold a command there indefinitely — mid-`give`, with the proofs
already reserved and nothing on screen to say why. The limit is per request, not per command,
so waiting out a lightning invoice is unaffected: each poll is its own request.

Every http and https request and every relay websocket then goes through the proxy: mint
requests (coco's included), lightning address lookups, NIP-05 lookups, nostr relays.
Hostnames are handed to the proxy as written and resolved there, so no DNS query for a mint
leaves this machine either — what `socks5h://` means elsewhere, and what both socks schemes
do here. `socks5://`, `socks5h://`, `http://` and `https://` proxies are supported, with a
username and password in the url when the proxy wants one.

For an `https:` destination — which is every mint, relay and lnurl host worth using — TLS is
end to end: the proxy is asked for a tunnel and carries the ciphertext, reading no more of it
than any other hop. An `http:` destination has no such protection to keep, so an http proxy
is asked to fetch it and reads the whole request, as it would for any other client. A
destination that redirects from `http:` to `https:` is refused rather than followed: the
connection was opened for the scheme first asked for, and answering the second over it would
mean fetching in the clear what the redirect asked to be kept private.

`--dht-interface` sends the hyperdht out from one local address, named either by interface
or by the address itself:

```sh
cashme --dht-interface en0 get --dht
cashme --dht-interface 10.8.0.2 give --dht -k <key> -a 21
```

It is named for what it reaches. Binding a socket to a local address is something the
hyperdht's sockets can do and an outgoing TCP connection in Bare cannot, so mint and relay
traffic is not pinned by it and never was — `--proxy` is the flag for changing what a mint
sees. It is not `--udp-interface` either: `--lan` discovery is UDP as well and is not pinned,
for the reason in the header of `lib/lan.mjs`.

The two flags cover different shapes of thing, and each is honest about its edge:

- **A proxy covers a protocol, not a run.** It carries http, https and the relay
  websockets. It does not carry the hyperdht, which holepunches over UDP, nor `--lan`, which
  finds its peer by multicast — there is nothing there for a proxy to carry, and never was.
  So `give --dht` behind a proxy is a mint swap through the proxy and a token handed over
  the hyperdht directly, which is what was asked for. The run prints a line saying which
  half went where. To keep the handover off the internet as well, use bluetooth, `--lan` or
  `give --print`.
- **`--dht-interface` holds for the hyperdht only.** Bare's TCP stack has no way to bind an
  outgoing connection to a local address, so anything reaching a mint or a relay cannot be
  pinned to one. A command that never opens the hyperdht is not refused for that — the flag
  is simply inert, and the run says so rather than leaving you to assume it took.
- **The OTA updater honours `--dht-interface` too.** It is a detached process that reaches
  the hyperdht — the very thing the flag pins — and it inherits none of a run's flags, so
  the run forwards that one to it by name and its swarm binds where you asked. Nothing else
  it does is a flag's business: a proxy cannot carry the hyperdht any more than it can carry
  `give --dht`. `--no-updates` is how to stop it running at all.

Bluetooth and `give --print` touch no network at all, and neither flag changes them.
