#!/usr/bin/env bash
# Seed a release to the pear link.
#
# Takes the by-arch.tar.gz built by release.yaml — every host in the layout pear-install and
# the OTA updater read — and stages it into the hypercore behind the upgrade link, so pear
# and npm users get the same build the GitHub release already handed to curl users.
#
#   scripts/stage.sh                 stage the latest release
#   scripts/stage.sh v0.1.0          stage a specific one
#   scripts/stage.sh --dry-run       download, check, show the diff, stage nothing
#
# Needs the pear CLI and gh, and must run on the machine holding the link's writer key —
# a stage drive is machine-bound.

set -euo pipefail

REPO="${CASHME_REPO:-mnaamani/cashme}"
LINK="${CASHME_LINK:-}"
TAG=""
DRY_RUN=""
ASSUME_YES=""
WORKDIR=""

main() {
  parse_args "$@"
  need pear "https://docs.pears.com"
  need gh "https://cli.github.com"

  # The link to stage to is the one builds already poll, so read it from the repo rather
  # than from the downloaded build — that one is about to be checked against this.
  if [ -z "$LINK" ]; then
    LINK="$(node -p 'require("./package.json").upgrade' 2>/dev/null || true)"
    [ -n "$LINK" ] && [ "$LINK" != undefined ] ||
      die "no upgrade link in package.json — pass one with --link"
  fi

  resolve_tag
  say "Staging $TAG to $LINK"

  # Stage from outside the repo. A deployment directory nested in the app folder gets swept
  # into the next stage, and the drive is append-only, so it never comes back out.
  # https://docs.pears.com/how-to/operate-an-app/manual-deployment/troubleshoot-desktop-releases
  [ -n "$WORKDIR" ] || WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/cashme-stage-XXXXXX")"
  mkdir -p "$WORKDIR"
  trap 'rm -rf "$WORKDIR"' EXIT

  download
  verify_checksum
  unpack
  check_manifest

  stage
}

# --- getting the build ------------------------------------------------------

resolve_tag() {
  if [ -z "$TAG" ]; then
    TAG="$(gh release view --repo "$REPO" --json tagName --jq .tagName)" ||
      die "no releases found in $REPO"
    say "Latest release is $TAG"
  fi
}

download() {
  say "Downloading by-arch.tar.gz and SHA256SUMS from $TAG"
  gh release download "$TAG" --repo "$REPO" \
    --pattern by-arch.tar.gz --pattern SHA256SUMS --dir "$WORKDIR" ||
    die "could not download the assets for $TAG
That release predates by-arch.tar.gz, or the run that built it failed."
}

verify_checksum() {
  local want got
  want="$(awk '$2 ~ /by-arch\.tar\.gz$/ { print $1 }' "$WORKDIR/SHA256SUMS")"
  [ -n "$want" ] || die "SHA256SUMS has no entry for by-arch.tar.gz"

  if command -v sha256sum >/dev/null 2>&1; then
    got="$(sha256sum "$WORKDIR/by-arch.tar.gz" | cut -d' ' -f1)"
  else
    got="$(shasum -a 256 "$WORKDIR/by-arch.tar.gz" | cut -d' ' -f1)"
  fi

  [ "$want" = "$got" ] || die "checksum mismatch for by-arch.tar.gz
  expected $want
  got      $got"
  say "Checksum ok"
}

unpack() {
  DEPLOY="$WORKDIR/deployment"
  mkdir -p "$DEPLOY"
  tar -xzf "$WORKDIR/by-arch.tar.gz" -C "$DEPLOY"
  [ -f "$DEPLOY/package.json" ] || die "by-arch.tar.gz has no package.json at its root"
  [ -d "$DEPLOY/by-arch" ] || die "by-arch.tar.gz has no by-arch/ directory"
}

# Two ways a correct-looking stage ships something useless, both cheap to rule out here and
# expensive afterwards, because a stage is append-only and cannot be taken back.
check_manifest() {
  local version upgrade hosts

  version="$(node -p "require('$DEPLOY/package.json').version")"
  # The updater only ever moves forward, comparing this against the version compiled into
  # the running binary. Staging a build whose manifest says something older than what users
  # already run is a no-op they will never see.
  [ "$version" = "${TAG#v}" ] ||
    die "the build in $TAG says version $version — refusing to stage a mismatch"

  upgrade="$(node -p "require('$DEPLOY/package.json').upgrade")"
  # A build polls the link baked into it. Staging one whose upgrade points elsewhere puts a
  # build on this line that will take its updates from another.
  [ "$upgrade" = "$LINK" ] ||
    die "the build in $TAG polls $upgrade but this stages to $LINK
Those are different release lines — check --link, or the tag."

  hosts="$(ls "$DEPLOY/by-arch" | tr '\n' ' ')"
  say "Version $version, hosts: $hosts"
  [ "$(ls "$DEPLOY/by-arch" | wc -l | tr -d ' ')" = 6 ] ||
    say "! only $(ls "$DEPLOY/by-arch" | wc -l | tr -d ' ') of 6 hosts are in this build"
}

# --- staging ----------------------------------------------------------------

stage() {
  say ""
  say "Dry run — nothing is written yet:"
  say ""
  pear stage --dry-run "$LINK" "$DEPLOY"

  if [ -n "$DRY_RUN" ]; then
    say ""
    say "Dry run only. Rerun without --dry-run to stage."
    return
  fi

  if [ -z "$ASSUME_YES" ]; then
    say ""
    say "Read that diff. A stage is append-only — whatever goes in stays in the history."
    printf 'Stage %s to %s? [y/N] ' "$TAG" "$LINK" >&2
    local reply
    read -r reply < /dev/tty || reply=""
    case "$reply" in
      y | Y | yes | YES) ;;
      *) die "aborted" ;;
    esac
  fi

  say ""
  pear stage "$LINK" "$DEPLOY"

  say ""
  say "Staged. The output above should match the dry run line for line."
  say "Announce it from a machine that stays online:"
  say "  pear seed $LINK"
}

# --- plumbing ---------------------------------------------------------------

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run | -n) DRY_RUN=1; shift ;;
      --yes | -y) ASSUME_YES=1; shift ;;
      --link) LINK="$2"; shift 2 ;;
      --link=*) LINK="${1#*=}"; shift ;;
      --dir) WORKDIR="$2"; shift 2 ;;
      --dir=*) WORKDIR="${1#*=}"; shift ;;
      -h | --help) usage; exit 0 ;;
      -*) die "unknown option '$1' (try --help)" ;;
      *) TAG="$1"; shift ;;
    esac
  done
}

usage() {
  cat <<EOF
Seed a release to the pear link.

  scripts/stage.sh [tag] [options]

  tag            release to stage (default: the latest)
  --dry-run, -n  download and check, show the diff, stage nothing
  --yes, -y      skip the confirmation prompt
  --link <url>   pear link to stage to (default: package.json upgrade)
  --dir <path>   working directory (default: a temp dir, removed afterwards)

Needs pear and gh, and the machine holding the link's writer key.
EOF
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is not installed — see $2"
}

say() {
  echo "$@" >&2
}

die() {
  echo "error: $*" >&2
  exit 1
}

main "$@"
