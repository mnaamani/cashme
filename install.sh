#!/bin/sh
# cashme installer — a cashu wallet in your terminal.
#
#   curl -fsSL https://raw.githubusercontent.com/mnaamani/cashme/main/install.sh | sh
#
# Downloads the standalone binary for this platform from a GitHub release and puts it in
# ~/.local/bin, checked against the release's SHA256SUMS. That is the only thing it does: no
# other source, and nothing it will fall back to. For a peer-to-peer install instead, use
# `npm i -g @cashme/cli`, which fetches the binary off the pear network and never touches a
# release.
#
# Options, as flags (curl -fsSL ... | sh -s -- --dir /usr/local/bin) or environment:
#   --dir <path>      CASHME_INSTALL_DIR   where to put the binary  (~/.local/bin)
#   --version <ver>   CASHME_VERSION       release to install, e.g. 0.1.0  (latest)
#   --no-modify-path  CASHME_NO_MODIFY_PATH=1   don't touch shell rc files
#   --force           CASHME_FORCE=1       overwrite an existing install without asking

set -eu

# Hardcoded on purpose: where the binary comes from is the one thing this script vouches for,
# and it holds keys to real money. The checksum is no help against an override — SHA256SUMS
# would come from the same redirected place — so pointing the download elsewhere means editing
# this script, not setting a variable.
REPO="mnaamani/cashme"
INSTALL_DIR="${CASHME_INSTALL_DIR:-}"
VERSION="${CASHME_VERSION:-latest}"
NO_MODIFY_PATH="${CASHME_NO_MODIFY_PATH:-}"
FORCE="${CASHME_FORCE:-}"

TMPDIR_CASHME=""

main() {
  parse_args "$@"

  [ -n "$INSTALL_DIR" ] || INSTALL_DIR="$HOME/.local/bin"
  BIN="$INSTALL_DIR/cashme"

  if [ -e "$BIN" ] && [ -z "$FORCE" ]; then
    say "cashme is already installed at $BIN"
    say "It updates itself in the background, so there is usually nothing to do."
    say "To reinstall anyway: rerun with --force, or remove that file first."
    exit 0
  fi

  HOST="$(detect_host)"
  say "cashme installer — $HOST"

  trap cleanup EXIT INT TERM
  TMPDIR_CASHME="$(mktemp -d 2>/dev/null || mktemp -d -t cashme)"

  install_from_release || die "no release binary for $HOST
Install it from peers instead:
  npm install -g @cashme/cli"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) need_value "$@" && INSTALL_DIR="$2" && shift 2 ;;
      --dir=*) INSTALL_DIR="${1#*=}" && shift ;;
      --version) need_value "$@" && VERSION="$2" && shift 2 ;;
      --version=*) VERSION="${1#*=}" && shift ;;
      --no-modify-path) NO_MODIFY_PATH=1 && shift ;;
      --force | -f) FORCE=1 && shift ;;
      -h | --help) usage && exit 0 ;;
      *) die "unknown option '$1' (try --help)" ;;
    esac
  done
}

need_value() {
  [ $# -ge 2 ] || die "$1 needs a value"
}

usage() {
  cat <<EOF
cashme installer — a cashu wallet in your terminal.

  curl -fsSL https://raw.githubusercontent.com/mnaamani/cashme/main/install.sh | sh
  curl -fsSL https://raw.githubusercontent.com/mnaamani/cashme/main/install.sh | sh -s -- --dir /usr/local/bin

  --dir <path>      where to put the binary          (\$CASHME_INSTALL_DIR, ~/.local/bin)
  --version <ver>   release to install, e.g. 0.1.0   (\$CASHME_VERSION, latest)
  --no-modify-path  don't touch shell rc files       (\$CASHME_NO_MODIFY_PATH)
  --force           replace an existing install      (\$CASHME_FORCE)
EOF
}

# --- platform ---------------------------------------------------------------

detect_host() {
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW* | MSYS* | CYGWIN*)
      die "windows is not installed by this script — use: npm install -g @cashme/cli" ;;
    *) die "unsupported operating system: $os" ;;
  esac

  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) die "unsupported architecture: $arch" ;;
  esac

  echo "$os-$arch"
}

# --- release install --------------------------------------------------------

install_from_release() {
  asset="cashme-$HOST.tar.gz"
  if [ "$VERSION" = latest ]; then
    base="https://github.com/$REPO/releases/latest/download"
  else
    base="https://github.com/$REPO/releases/download/v${VERSION#v}"
  fi

  say "Downloading $asset"
  fetch "$base/$asset" "$TMPDIR_CASHME/$asset" || return 1

  verify_checksum "$base" "$asset" || return 1

  tar -xzf "$TMPDIR_CASHME/$asset" -C "$TMPDIR_CASHME" ||
    die "could not unpack $asset"
  [ -f "$TMPDIR_CASHME/cashme" ] || die "$asset does not contain a cashme binary"

  chmod 0755 "$TMPDIR_CASHME/cashme"
  place "$TMPDIR_CASHME/cashme"
  finish
}

verify_checksum() {
  base="$1"
  asset="$2"

  # Both halves fail closed. An unverified binary is one this script has no reason to
  # trust, and it holds the keys to real money — so a missing tool or a missing sums file
  # stops the install rather than downgrading it to a plain download.
  sum=""
  if command -v sha256sum >/dev/null 2>&1; then
    sum="$(sha256sum "$TMPDIR_CASHME/$asset" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    sum="$(shasum -a 256 "$TMPDIR_CASHME/$asset" | cut -d' ' -f1)"
  else
    die "no sha256sum or shasum on this system, so $asset cannot be verified.
Install one of them, or install from peers instead:
  npm install -g @cashme/cli"
  fi

  if ! fetch "$base/SHA256SUMS" "$TMPDIR_CASHME/SHA256SUMS"; then
    die "no SHA256SUMS published alongside $asset, so it cannot be verified.
Refusing to install. Report it if it persists:
  https://github.com/$REPO/issues"
  fi

  want="$(grep " \{1,2\}\*\{0,1\}$asset\$" "$TMPDIR_CASHME/SHA256SUMS" | cut -d' ' -f1)"
  [ -n "$want" ] || die "SHA256SUMS has no entry for $asset"
  [ "$want" = "$sum" ] || die "checksum mismatch for $asset
  expected $want
  got      $sum
Refusing to install. Try again, and report it if it persists:
  https://github.com/$REPO/issues"

  say "Checksum ok"
}

# --- placing it -------------------------------------------------------------

place() {
  src="$1"
  mkdir -p "$INSTALL_DIR" 2>/dev/null ||
    die "could not create $INSTALL_DIR — pick another with --dir"

  # Move within the same filesystem when we can, so the binary appears whole or not at all;
  # a cross-device rename falls back to cp, which cannot promise that.
  if ! mv -f "$src" "$BIN" 2>/dev/null; then
    cp -f "$src" "$BIN" 2>/dev/null ||
      die "could not write $BIN
If that directory needs root, rerun with --dir pointing somewhere you own,
or: sudo sh -c 'CASHME_INSTALL_DIR=/usr/local/bin sh install.sh'"
  fi
  chmod 0755 "$BIN"

  # Strip Gatekeeper's quarantine tag, so the first run is not a "cannot be opened because
  # the developer cannot be verified" dialog.
  #
  # Usually there is no tag to strip: the attribute is set by the downloading application,
  # and only ones declaring LSFileQuarantineEnabled set it — browsers and Mail do, curl and
  # wget do not. So this is a no-op on the path above, and earns its place when the tarball
  # came down through a browser and this script was pointed at it.
  #
  # Where there is a tag, what is being skipped is Apple's notarization check. The checksum
  # verified above is then the only thing standing behind this binary, which is why that
  # check fails closed rather than being skipped when it cannot be made.
  if [ "$(uname -s)" = Darwin ] && command -v xattr >/dev/null 2>&1; then
    xattr -d com.apple.quarantine "$BIN" >/dev/null 2>&1 || true
  fi
}

finish() {
  say ""
  say "cashme installed: $BIN"
  if on_path; then
    say "Run: cashme --help"
  else
    add_to_path
  fi
  say ""
  say "It keeps itself up to date in the background. Run 'cashme --no-updates ...' to skip that."
}

on_path() {
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) return 0 ;;
    *) return 1 ;;
  esac
}

add_to_path() {
  if [ -n "$NO_MODIFY_PATH" ]; then
    say "$INSTALL_DIR is not on your PATH. Add it:"
    say "  export PATH=\"\$PATH:$INSTALL_DIR\""
    return
  fi

  rc="$(shell_rc)"
  line="export PATH=\"\$PATH:$INSTALL_DIR\""
  case "$rc" in
    *config.fish) line="fish_add_path $INSTALL_DIR" ;;
  esac

  if [ -f "$rc" ] && grep -qF "$line" "$rc" 2>/dev/null; then
    say "$INSTALL_DIR is already on the PATH in $rc — open a new terminal to pick it up."
    return
  fi

  mkdir -p "$(dirname "$rc")" 2>/dev/null || true
  if {
    echo ""
    echo "# added by the cashme installer"
    echo "$line"
  } >>"$rc" 2>/dev/null; then
    say "Added $INSTALL_DIR to your PATH in $rc"
    say "Open a new terminal (or: . $rc), then run: cashme --help"
  else
    say "$INSTALL_DIR is not on your PATH. Add it:"
    say "  $line"
  fi
}

shell_rc() {
  case "$(basename "${SHELL:-sh}")" in
    zsh) echo "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      if [ "$(uname -s)" = Darwin ] && [ -f "$HOME/.bash_profile" ]; then
        echo "$HOME/.bash_profile"
      else
        echo "$HOME/.bashrc"
      fi
      ;;
    fish) echo "$HOME/.config/fish/config.fish" ;;
    *) echo "$HOME/.profile" ;;
  esac
}

# --- plumbing ---------------------------------------------------------------

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    die "neither curl nor wget is installed"
  fi
}

say() {
  echo "$@" >&2
}

die() {
  echo "error: $*" >&2
  exit 1
}

cleanup() {
  [ -n "$TMPDIR_CASHME" ] && rm -rf "$TMPDIR_CASHME"
  return 0
}

main "$@"
