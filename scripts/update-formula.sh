#!/usr/bin/env bash
# Update the Homebrew formula in the *tap* repo to point at version $1's
# GitHub release tarballs. Pushes the change to the tap. Verifies the
# update landed before exiting clean.
#
# SHA256s are sourced from the GH release assets via `gh release download`.
#
# Usage:
#   scripts/update-formula.sh 0.2.1
#
# Env:
#   GH_OWNER    GitHub owner/org                              (default: SectorOPS)
#   SRC_REPO    Source repo where releases live              (default: Stash)
#   TAP_REPO    Tap repo where Formula/stash.rb is committed (default: homebrew-Stash)

set -euo pipefail

ROOT="$( cd -P "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$ROOT"

VERSION="${1:?usage: $0 <version>}"
OWNER="${GH_OWNER:-SectorOPS}"
SRC="${SRC_REPO:-Stash}"
TAP="${TAP_REPO:-homebrew-Stash}"

URL_BASE="https://github.com/${OWNER}/${SRC}/releases/download/v${VERSION}"

# Pull sha256 sidecars from the source repo's release.
echo "==> fetching sha256 sidecars from ${OWNER}/${SRC} release v${VERSION}…"
SHA_DIR=$(mktemp -d)
trap 'rm -rf "$SHA_DIR"' EXIT
gh release download "v${VERSION}" \
  --repo "${OWNER}/${SRC}" \
  --pattern "*.sha256" \
  --dir "$SHA_DIR" \
  --clobber

read_sha() {
  local f="$SHA_DIR/stash-${VERSION}-$1.tar.gz.sha256"
  [ -f "$f" ] || { echo "Missing $f — release didn't publish $1 binary?" >&2; exit 1; }
  awk '{print $1}' "$f"
}
DA=$(read_sha darwin-arm64)
DX=$(read_sha darwin-x64)
LA=$(read_sha linux-arm64)
LX=$(read_sha linux-x64)

# Clone the tap, rewrite the formula, commit, push.
TAP_DIR=$(mktemp -d)
git clone --quiet "https://github.com/${OWNER}/${TAP}.git" "$TAP_DIR"

cat > "${TAP_DIR}/Formula/stash.rb" <<EOF
class Stash < Formula
  desc "Interactive launcher that resumes claude / codex / opencode sessions"
  homepage "https://github.com/${OWNER}/${SRC}"
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

(
  cd "$TAP_DIR"
  if git diff --quiet Formula/stash.rb; then
    echo "==> tap formula already at v${VERSION}, nothing to push"
    exit 0
  fi
  git add Formula/stash.rb
  git -c user.email="stash-release@noreply.local" \
      -c user.name="stash release" \
      commit -m "Bump stash to v${VERSION}" >/dev/null
  git push --quiet origin HEAD
  echo "==> pushed Formula/stash.rb v${VERSION} to ${OWNER}/${TAP}"
)

# Verify the version actually landed in the tap's main branch — guards
# against the "tagged source release but tap shows yesterday's version"
# silent failure mode.
echo "==> verifying tap is at v${VERSION}…"
remote_content=$(gh api "repos/${OWNER}/${TAP}/contents/Formula/stash.rb" --jq '.content' | base64 -d)
if ! echo "$remote_content" | grep -qE "^  version \"${VERSION}\"$"; then
  echo "✗ tap repo does NOT show version ${VERSION} after push" >&2
  echo "   inspect: https://github.com/${OWNER}/${TAP}/blob/main/Formula/stash.rb" >&2
  exit 1
fi
echo "✓ tap Formula/stash.rb confirmed at v${VERSION}"
echo "  darwin-arm64: ${DA}"
echo "  darwin-x64:   ${DX}"
echo "  linux-arm64:  ${LA}"
echo "  linux-x64:    ${LX}"

rm -rf "$TAP_DIR"
