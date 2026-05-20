#!/usr/bin/env bash
# Build standalone stash binaries for every supported platform.
#
# Outputs to dist/<target>/stash, then tarballs each as
# dist/stash-<version>-<target>.tar.gz with a sha256 sidecar.
#
# Usage:
#   scripts/build-release.sh             # uses version from package.json
#   VERSION=0.2.0 scripts/build-release.sh

set -euo pipefail

ROOT="$( cd -P "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$ROOT"

VERSION="${VERSION:-$(jq -r .version package.json)}"
if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
  echo "Could not determine VERSION from package.json" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun not found. Install it with 'brew install oven-sh/bun/bun' first." >&2
  exit 1
fi

# Bun --target triplets that Homebrew formula consumers care about.
TARGETS=(
  bun-darwin-arm64
  bun-darwin-x64
  bun-linux-x64
  bun-linux-arm64
)

rm -rf dist
mkdir -p dist

for target in "${TARGETS[@]}"; do
  short="${target#bun-}"           # darwin-arm64
  outdir="dist/$short"
  mkdir -p "$outdir"

  echo "==> building $short"
  bun build src/index.ts \
    --compile \
    --target="$target" \
    --outfile "$outdir/stash"

  chmod +x "$outdir/stash"

  tarball="dist/stash-${VERSION}-${short}.tar.gz"
  ( cd "$outdir" && tar czf "../../$tarball" stash )

  sha=$(shasum -a 256 "$tarball" | awk '{print $1}')
  echo "$sha  $(basename "$tarball")" > "${tarball}.sha256"
  echo "    $tarball  ($sha)"
done

echo
echo "Done. Artefacts:"
ls -1 dist/*.tar.gz
echo
echo "Next steps:"
echo "  1. Tag the release:        git tag v${VERSION} && git push --tags"
echo "  2. Create GH release:      gh release create v${VERSION} dist/*.tar.gz dist/*.sha256"
echo "  3. Update the formula:     scripts/update-formula.sh ${VERSION}"
