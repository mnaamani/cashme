# cashme

> Pear Hello World for Standalone Bare Processes with `pear-runtime`

# Install

`pear install pear://tdnucsbcqeqer3yuyxduty4666zxr1f6ihua1j17g3pwr1qrnd9o`

run

`cashme`

## Development

### Install Dependencies

```sh
npm install
```

```sh
npm start
```

By default this repo starts with `--no-updates` in development to avoid local dev binaries being swapped while you iterate.

Enable updates for local flow testing:

```sh
npm start -- --updates
```

Set how long the daemon waits for an update:

```sh
npm start -- --updates --update-window 60000
```

Development runs are unbundled, so they exercise the daemon lifecycle without replacing the local Bare executable. Updates are applied by standalone builds.

## Architecture

### Updates

Updates are managed by the `App` class in `app.js`. The foreground CLI starts itself in a detached updater mode with `bare-daemon`. The updater owns `Corestore`, `Hyperswarm` and `PearRuntime`, while `updater.lock` ensures only one updater runs per storage directory.

It uses the configured `upgrade` link in `package.json`, waits 30 seconds by default and writes output to `<storage>/updates.log`. Once a download starts, the daemon remains alive until the update is applied or an error occurs.

Per-run disable updates:

```sh
npm start -- --no-updates
```

## Peer-to-Peer Deployments

Use the [`pear`][pear-docs] CLI to deploy applications.

Set the `upgrade` field in `package.json` to your distribution drive link, then follow the default flow from section 4 onward:

[hello-pear-electron: 4. Build Deployment Directory and onward](https://github.com/holepunchto/hello-pear-electron#4-build-deployment-directory-)

## Installing Distributables

Once the `pear://<key>` upgrade link is seeding the build deployment folder the standalone binary can be installed peer-to-peer directly onto the system with Pear:

```sh
npx pear-install pear://<key>
```

## Scripts

- `npm start` - run the Bare Process in dev mode (`bare bin.mjs --no-updates`)
- `npm test` - run `brittle-bare` tests
- `npm run lint` - run prettier check and lunte
- `npm run format` - format repository with prettier
- `npm run make` - auto-detect host OS/arch and run matching build target
- `npm run make:darwin-arm64` - build standalone to `out/darwin-arm64`
- `npm run make:darwin-x64` - build standalone to `out/darwin-x64`
- `npm run make:linux-arm64` - build standalone to `out/linux-arm64`
- `npm run make:linux-x64` - build standalone to `out/linux-x64`
- `npm run make:win32-arm64` - build standalone to `out/win32-arm64`
- `npm run make:win32-x64` - build standalone to `out/win32-x64`

## Project Structure

- `bin.mjs` - entrypoint and runtime wiring
- `app.js` - daemon launcher and updater resource
- `scripts/make.js` - platform/arch build target selector
- `test/index.js` - brittle-bare tests

## Troubleshooting

- `INVALID_URL: Invalid URL 'pear://<YOUR_KEY_HERE>'` means the placeholder `upgrade` link in `package.json` has not been replaced. Run `pear touch`, then put the generated `pear://...` link in `package.json`.
- If updates do not trigger, verify `package.json` contains a valid `upgrade` Pear link and that peers are seeding the target drive.
- Check `<storage>/updates.log` for daemon startup and updater errors.
- If `npm run make` fails on unsupported hosts, run a specific `make:<platform>-<arch>` script or build on a supported host.
- This template does not implement app-level data persistence; it is a minimal CLI + updater example.

<!-- Reference Links -->

[pear-docs]: https://docs.pears.com
[bare-daemon]: https://github.com/holepunchto/bare-daemon
[pear-runtime]: https://github.com/holepunchto/pear-runtime
[Bare]: https://github.com/holepunchto/bare
[nodejs]: https://nodejs.org
[bare-build]: https://github.com/holepunchto/bare-build
