# CASHME .... if you can

> A cashu wallet in your terminal, send and receive tokens privately over bluetooth.

## EXPERIMENTAL - Use at your own risk !!

## Getting started

Build and run:

```sh
npm install
npm run make
./out/your-platform/cashme
```

or install pre-built binary with `pear`:

```sh
npm -g install pear
pear install pear://tdnucsbcqeqer3yuyxduty4666zxr1f6ihua1j17g3pwr1qrnd9o
```

or with `npx`:

```sh
npx pear-install pear://tdnucsbcqeqer3yuyxduty4666zxr1f6ihua1j17g3pwr1qrnd9o
```

Then run installed binary

`cashme --help`

## Usage

`cashme` is a terminal cashu wallet. ecash tokens are exchanged directly between two devices over Bluetooth Low Energy (BLE).

Check your ecash balance:

```sh
cashme balance
```

Deposit funds into your wallet by paying a lightning invoice (mints new ecash):

```sh
cashme deposit
```

Send ecash to a nearby device. Give the public key (or a partial prefix) of the neighbour you want to send to:

```sh
cashme give --public-key <pubkey>
```

On the receiving device, wait to receive ecash from a nearby neighbour:

```sh
cashme get
```

Pay a lightning invoice using your ecash balance (melts ecash):

```sh
cashme pay
```

Run `cashme <command> --help` for details on any command, or `cashme --help` for the full list.

## Development

Built on pear-runtime, [hello-pear-bare](https://github.com/holepunchto/hello-pear-bare/tree/variant/daemon) daemon variant.

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
