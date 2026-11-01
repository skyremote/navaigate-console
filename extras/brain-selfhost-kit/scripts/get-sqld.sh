#!/bin/sh
# Download the database server (sqld, libSQL) for this Mac or Linux machine into ./bin/sqld.
# Version is pinned to the one we run ourselves.
set -eu
VERSION="${SQLD_VERSION:-0.24.32}"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  T=aarch64-apple-darwin ;;
  Darwin-x86_64) T=x86_64-apple-darwin ;;
  Linux-x86_64)  T=x86_64-unknown-linux-gnu ;;
  Linux-aarch64|Linux-arm64) T=aarch64-unknown-linux-gnu ;;
  *) echo "No download for $(uname -s)-$(uname -m). On Windows use Docker Desktop or WSL2." >&2; exit 1 ;;
esac
KIT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$KIT/bin"
TMP="$(mktemp -d)"
curl -fsSL "https://github.com/tursodatabase/libsql/releases/download/libsql-server-v${VERSION}/libsql-server-${T}.tar.xz" -o "$TMP/sqld.tar.xz"
tar -xJf "$TMP/sqld.tar.xz" -C "$TMP"
cp "$TMP/libsql-server-${T}/sqld" "$KIT/bin/sqld"
chmod +x "$KIT/bin/sqld"
rm -rf "$TMP"
"$KIT/bin/sqld" --version
