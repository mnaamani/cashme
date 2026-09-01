# Installing

Three routes, all ending in the same standalone binary. `curl | sh` takes it from
the GitHub release; npm and `pear` bootstrap it off the pear network.

## Install

With a shell, taking the binary for your platform from the latest
[release](https://github.com/mnaamani/cashme/releases):

```sh
curl -fsSL https://raw.githubusercontent.com/mnaamani/cashme/main/install.sh | sh
```

or with npm, which bootstraps the same binary off the pear network instead:

```sh
npm install -g @cashme/cli
```

or with `pear` itself, or `pear-install` on its own:

```sh
npm install -g pear
pear install pear://tdnucsbcqeqer3yuyxduty4666zxr1f6ihua1j17g3pwr1qrnd9o

npx pear-install pear://tdnucsbcqeqer3yuyxduty4666zxr1f6ihua1j17g3pwr1qrnd9o
```

Every route puts the same standalone binary in `~/.local/bin/cashme`
(`%LOCALAPPDATA%\Programs\cashme\cashme.exe` on windows) and, if that directory is not on
your PATH, adds it to your shell's rc file. Open a new terminal, then:

```sh
cashme --help
```

The wallet keeps itself up to date in the background from its own pear link, so whichever
way it got there, it does not need reinstalling to move to a newer version. `--no-updates`
skips that for a run. To uninstall, delete the binary — the wallet's storage lives
[elsewhere](usage.md#the-wallet-on-disk) and outlives it.

## Which route to use

- **`curl | sh`** ([`install.sh`](../install.sh)) needs nothing but curl. It downloads the
  release asset for your platform, checks it against the release's `SHA256SUMS`, and
  installs it. `--dir` puts it somewhere else, `--version` pins a release, `--force`
  replaces an existing install; `sh install.sh --help` lists the rest. The release is the
  only place it looks: with no asset for your platform it stops and points at the npm route
  rather than falling back to it.
- **`npm install -g @cashme/cli`** ([`installer/`](../installer)) installs a shim that, on its
  first run, fetches the binary and then execs it — the same shape as `npm i -g pear`.
  Nothing but the shim comes from the registry, so the wallet itself is never a package
  update behind. The fetch is pure peer-to-peer: the binary comes off the pear network from
  whoever is seeding the link, with no release download to fall back on, so an install that
  finds no peers fails rather than reaching for a second source. That first run is also
  where it can fail, and since `npm install` has already succeeded by then the retry is
  `cashme` again rather than a reinstall. Whatever you typed is carried through, so running
  `cashme balance` on a new machine installs the wallet and then reports the balance.
- **`pear install`** is the same bootstrap, done by the pear CLI you may already have.
