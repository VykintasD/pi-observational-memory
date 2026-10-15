#!/usr/bin/env bash
# Build the om CLI for this machine.
#
# The binary is build output
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

BIN=om
STAMP=.om-build-stamp

sha() { # sha -> first-field sha256 of whatever is on stdin
	if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | awk '{print $1}'
}

stamp() { cat go.mod go.sum *.go | sha; }

fresh() {
	[ -x "./$BIN" ] || return 1
	[ "$(stamp)" = "$(cat "$STAMP" 2>/dev/null)" ] || return 1
	# Hash match alone is not enough: a binary built for another arch, or a
	# leftover blob from another machine, has to be replaced, not trusted.
	"./$BIN" --help >/dev/null 2>&1 || return 1
}

if [ "${1:-}" = "--check" ]; then
	if fresh; then
		echo "cli/$BIN: fresh ($(uname -s)-$(uname -m))"
		exit 0
	fi
	echo "cli/$BIN: missing, stale or not runnable — run: bash cli/build.sh" >&2
	exit 1
fi

if fresh; then
	echo "cli/$BIN: up to date, nothing to do ($(uname -s)-$(uname -m))"
	exit 0
fi

if ! command -v go >/dev/null 2>&1; then
	echo "go not found: the om CLI is built from source and needs Go 1.25+ (brew install go)" >&2
	exit 1
fi

# go build refuses to overwrite a non-object file, so clear whatever is there
# first: a wrong-arch blob, a junk placeholder, or an older build.
rm -f "$BIN"
go build -o "$BIN" .
printf '%s\n' "$(stamp)" > "$STAMP"

if ! "./$BIN" --help >/dev/null 2>&1; then
	echo "built, but ./cli/$BIN would not run — check the toolchain and arch" >&2
	exit 1
fi

echo "cli/$BIN: built for $(uname -s)-$(uname -m)"
