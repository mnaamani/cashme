# Building and releasing

## Build from source

```sh
npm install
npm run make
./out/your-platform/cashme --help
```

Either way the build leaves `LICENSE`, `NOTICE` and a freshly generated
`THIRD-PARTY-NOTICES.md` next to the binary — the release archives are the whole of that
directory, because the licenses compiled into the binary ask to be distributed with it.
`npm run notices` regenerates the file on its own, and `npm run lint` fails when the
committed copy has fallen behind the dependency tree.

`npm run make` builds for the host it runs on; `npm run make:<host>` cross-builds for any
of `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`.

Tagging `v*` runs [`release.yaml`](../.github/workflows/release.yaml), which builds all six
once and packages that one compile for both channels:

- `cashme-<host>.tar.gz` (`.zip` on windows), one per host — what `install.sh` downloads.
- `by-arch.tar.gz`, every host in the layout `pear-install` and the OTA updater read — what
  gets seeded to the pear link.
- `SHA256SUMS` over all of them.

Everything lands on the GitHub release, so the two channels can never disagree within a
release. A `workflow_dispatch` with a tag republishes that tag; with no tag it builds the
artifacts and publishes nothing. The run refuses to start if `package.json`'s version does
not match the tag, because the updater compares exactly that against the running binary and
a mismatch would ship a build that updates nobody.

## Seeding a release

The GitHub release covers `install.sh` on its own. The pear link is a second step, run from
the machine holding its writer key — a stage drive is machine-bound:

```sh
npm run stage              # stage the latest release
npm run stage -- v0.1.0    # or a specific one
npm run stage -- --dry-run # download, check, show the diff, stage nothing
pear seed pear://tdnucsbcqeqer3yuyxduty4666zxr1f6ihua1j17g3pwr1qrnd9o
```

[`scripts/stage.sh`](../scripts/stage.sh) downloads `by-arch.tar.gz` from the release, verifies
it against `SHA256SUMS`, unpacks it outside the repo (a deployment directory left inside the
app folder gets swept into the next stage, and the drive is append-only), then dry-runs
`pear stage` and asks before running it for real. It refuses outright if the build's version
does not match the tag, or if the build polls a different link than the one being staged to
— both produce a stage that looks fine and ships nothing usable, and neither can be undone.

Until a release is staged, pear and npm users stay on whatever was seeded last while
`install.sh` users get the new build. Seeding is what brings the two back in step.
