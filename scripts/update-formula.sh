#!/usr/bin/env bash
# Rewrite Formula/stash.rb to point at version $1's GitHub release tarballs.
#
# SHA256s are sourced from:
#   1. ./dist/stash-<ver>-<tgt>.tar.gz.sha256 if present (local build), else
#   2. the GitHub release assets via `gh release download`.
#
# Usage:
#   scripts/update-formula.sh 0.1.0
#
# Env:
#   GH_OWNER  GitHub owner/org of the source repo  (default: SectorOPS)
#   GH_REPO   GitHub repo name                    (default: Stash)

set -euo pipefail

ROOT="$( cd -P "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$ROOT"

VERSION="${1:?usage: $0 <version>}"
OWNER="${GH_OWNER:-SectorOPS}"
REPO="${GH_REPO:-Stash}"

ensure_sha_files() {
  local missing=0
  for target in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
    local f="dist/stash-${VERSION}-${target}.tar.gz.sha256"
    if [ ! -f "$f" ]; then
      missing=1
      break
    fi
  done
  if [ "$missing" = "0" ]; then return; fi

  if ! command -v gh >/dev/null 2>&1; then
    echo "Missing sha256 sidecars in dist/, and 'gh' CLI not installed." >&2
    echo "Either: gh auth login && retry, OR run scripts/build-release.sh first." >&2
    exit 1
  fi

  echo "==> fetching sha256 sidecars from gh release v${VERSION}…"
  mkdir -p dist
  gh release download "v${VERSION}" \
    --repo "${OWNER}/${REPO}" \
    --pattern "*.sha256" \
    --dir dist \
    --clobber
}

read_sha() {
  local target="$1"
  local f="dist/stash-${VERSION}-${target}.tar.gz.sha256"
  [ -f "$f" ] || { echo "Missing $f after fetch — aborting" >&2; exit 1; }
  awk '{print $1}' "$f"
}

ensure_sha_files

DA=$(read_sha darwin-arm64)
DX=$(read_sha darwin-x64)
LA=$(read_sha linux-arm64)
LX=$(read_sha linux-x64)
URL_BASE="https://github.com/${OWNER}/${REPO}/releases/download/v${VERSION}"

cat > Formula/stash.rb <<EOF
class Stash < Formula
  desc "Interactive launcher that resumes claude / codex / opencode sessions"
  homepage "https://github.com/${OWNER}/${REPO}"
  version "${VERSION}"
  license "MIT"

  on_macos do
    on_arm do
      url "${URL_BASE}/stash-${VERSION}-darwin-arm64.tar.gz"
      sha256 "${DA}"
    end
    on_intel do
      url "${URL_BASE}/stash-${VERSION}-darwin-x64.tar.gz"
      sha256 "${DX}"
    end
  end

  on_linux do
    on_arm do
      url "${URL_BASE}/stash-${VERSION}-linux-arm64.tar.gz"
      sha256 "${LA}"
    end
    on_intel do
      url "${URL_BASE}/stash-${VERSION}-linux-x64.tar.gz"
      sha256 "${LX}"
    end
  end

  def install
    bin.install "stash"
  end

  test do
    assert_match "stash #{version}", shell_output("#{bin}/stash --version")
  end
end
EOF

echo "✓ Formula/stash.rb updated for v${VERSION}"
echo "  darwin-arm64: ${DA}"
echo "  darwin-x64:   ${DX}"
echo "  linux-arm64:  ${LA}"
echo "  linux-x64:    ${LX}"
