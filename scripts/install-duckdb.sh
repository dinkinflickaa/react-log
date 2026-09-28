#!/usr/bin/env sh
# Installs the pinned DuckDB CLI into $1 (default: ~/.local/bin).
# Windows: use `winget install DuckDB.cli`, or see https://duckdb.org/docs/installation.
set -eu

VERSION=1.5.5
DEST=${1:-"$HOME/.local/bin"}

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ASSET=duckdb_cli-linux-amd64.zip ;;
  Linux-aarch64 | Linux-arm64) ASSET=duckdb_cli-linux-arm64.zip ;;
  Darwin-*) ASSET=duckdb_cli-osx-universal.zip ;;
  *)
    echo "unsupported platform $(uname -s)-$(uname -m); see https://duckdb.org/docs/installation" >&2
    exit 1
    ;;
esac

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/duckdb.zip" "https://github.com/duckdb/duckdb/releases/download/v$VERSION/$ASSET"
if command -v unzip >/dev/null 2>&1; then
  unzip -q "$TMP/duckdb.zip" -d "$TMP"
else
  python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$TMP/duckdb.zip" "$TMP"
fi
mkdir -p "$DEST"
install -m 0755 "$TMP/duckdb" "$DEST/duckdb"
"$DEST/duckdb" --version
