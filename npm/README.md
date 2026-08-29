# cashme

A cashu wallet in your terminal — send and receive ecash privately over Bluetooth.

```sh
npm install -g cashme
cashme --help
```

This package is a small shim, not the wallet. The wallet is a standalone
[Bare](https://github.com/holepunchto/bare) binary; the first `cashme` run fetches it and
installs it to `~/.local/bin/cashme` (`%LOCALAPPDATA%\Programs\cashme\cashme.exe` on
windows), and every run after that hands straight over to it. Once installed it keeps itself
up to date in the background, so this package never needs upgrading to get a newer wallet.

That first fetch has two ways to succeed. It asks the pear network first, and if nothing is
seeding the link — or the network blocks it — it downloads the binary for your platform from
the latest [GitHub release](https://github.com/mnaamani/cashme/releases) instead, checked
against the release's `SHA256SUMS`. Neither route depends on the other working.

| variable          | default             |                                        |
| ----------------- | ------------------- | -------------------------------------- |
| `CASHME_METHOD`   | `auto`              | `pear` or `release` to force one route |
| `CASHME_VERSION`  | `latest`            | release to install, e.g. `0.1.0`       |
| `CASHME_LINK`     | the app's pear link | link to bootstrap from                 |
| `CASHME_BASE_URL` | GitHub releases     | mirror to download release assets from |

Because the fetch happens on first run rather than at install time, a failure leaves
`npm install` itself successful. Retry by running `cashme` again, not by reinstalling this
package. Whatever you typed is carried through, so `cashme balance` on a new machine
installs the wallet and then reports the balance.

Other ways in:

```sh
curl -fsSL https://raw.githubusercontent.com/mnaamani/cashme/main/install.sh | sh   # binary from a release
npx pear-install pear://tdnucsbcqeqer3yuyxduty4666zxr1f6ihua1j17g3pwr1qrnd9o
```

Uninstall with `rm ~/.local/bin/cashme` (plus `npm uninstall -g cashme` for this shim).
Wallet storage lives elsewhere and is left alone — see the
[README](https://github.com/mnaamani/cashme#the-wallet-on-disk).

## Experimental — use at your own risk

Full documentation: <https://github.com/mnaamani/cashme>
