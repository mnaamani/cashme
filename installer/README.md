# cashme - installer

Installs `cashme`, a cashu wallet in your terminal — send and receive ecash over Bluetooth.

## Experimental — use at your own risk

## Install

```sh
npm install -g @cashme/cli
cashme --help
```

This package is a small shim. The first `cashme` run fetches the binary and
installs it, and every run after that hands straight over to it. Once installed `cashme` keeps itself
up to date in the background, so this package never needs upgrading to get a newer wallet.

That fetch is peer-to-peer: the binary comes off the pear network from whoever is
seeding the link, with no release download, no mirror and no server to trust. If nothing is
seeding the link, or the network blocks the swarm, the install fails rather than reaching for
a second source.

Because the fetch happens on first run rather than at install time, a failure leaves
`npm install` itself successful. Retry by running `cashme` again, not by reinstalling this
package. Whatever you typed is carried through, so `cashme balance` on a new machine
installs the wallet and then reports the balance.

## Uninstall

```sh
rm ~/.local/bin/cashme
npm uninstall -g @cashme/cli
```

Wallet storage lives elsewhere and is left alone.

