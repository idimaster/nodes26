#!/usr/bin/env bash
# Installs the pinned official Neo4j MCP server (config/neo4j-mcp.json) into .tools/neo4j-mcp.
# The archive must match the SHA-256 pinned in this repo, not just the release's own checksum file.
#   NEO4J_MCP_INSTALL_DIR  install somewhere else (default: .tools/neo4j-mcp)
#   NEO4J_MCP_ARCHIVE      use a local archive instead of downloading (still checksum-verified)
#   --force                reinstall even if the pinned version is already there
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "install-neo4j-mcp: $*" >&2; exit 1; }
pinned() { node -e "const c=require('./config/neo4j-mcp.json'); const v=$1; if (!v) process.exit(1); console.log(v)"; }

version="$(pinned 'c.version')" || fail "config/neo4j-mcp.json has no version"
os="$(uname -s)"
arch="$(uname -m)"
case "$arch" in aarch64) arch=arm64 ;; amd64) arch=x86_64 ;; esac
platform="${os}_${arch}"
expected="$(pinned "c.sha256['${platform}']")" || fail "no pinned checksum for ${platform} (supported: macOS and Linux, arm64 and x86_64)"

dest="${NEO4J_MCP_INSTALL_DIR:-.tools/neo4j-mcp}"
if [[ "${1:-}" != "--force" && -x "$dest/neo4j-mcp" && "$(cat "$dest/VERSION" 2>/dev/null)" == "$version" ]]; then
  echo "install-neo4j-mcp: ${version} already installed in ${dest}"
  exit 0
fi

archive="neo4j-mcp_${platform}.tar.gz"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if [[ -n "${NEO4J_MCP_ARCHIVE:-}" ]]; then
  cp "$NEO4J_MCP_ARCHIVE" "$tmp/$archive"
else
  url="https://github.com/neo4j/mcp/releases/download/${version}/${archive}"
  echo "install-neo4j-mcp: downloading ${url}"
  curl -fsSL -o "$tmp/$archive" "$url" || fail "download failed: ${url}"
fi

if command -v sha256sum >/dev/null; then
  actual="$(sha256sum "$tmp/$archive" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')"
fi
[[ "$actual" == "$expected" ]] || fail "checksum mismatch for ${archive}: expected ${expected}, got ${actual}. Not installing."

mkdir -p "$tmp/x"
tar -xzf "$tmp/$archive" -C "$tmp/x" neo4j-mcp
mkdir -p "$dest"
install -m 0755 "$tmp/x/neo4j-mcp" "$dest/neo4j-mcp"
echo "$version" > "$dest/VERSION"
echo "install-neo4j-mcp: installed $("$dest/neo4j-mcp" --version 2>&1 | head -1) in ${dest}"
