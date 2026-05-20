#!/usr/bin/env bash
# One-shot release script.
#
#   1. Bump package.json (no-op if version already matches)
#   2. Commit + tag v<version> and push to the source repo
#   3. Wait for the source repo's GH Actions release workflow to finish
#      (builds 4 binaries, attaches tarballs + sha256 sidecars)
#   4. Hand off to update-formula.sh which clones the *tap* repo, rewrites
#      Formula/stash.rb against the new sha256s, pushes, and verifies that
#      the tap shows the bumped version before exiting.
#
# Usage:
#   scripts/release.sh 0.3.0       # explicit version
#   scripts/release.sh patch       # 0.2.1 -> 0.2.2
#   scripts/release.sh minor       # 0.2.1 -> 0.3.0
#   scripts/release.sh major       # 0.2.1 -> 1.0.0
#
# Env:
#   SKIP_PUSH=1   skip pushing the tag (dry run, useful for testing)
#   SKIP_WAIT=1   skip the GH-Actions wait (use if you've already built)

set -euo pipefail

ROOT="$( cd -P "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required tool: $1" >&2
    exit 1
  }
}
need jq
need git
need gh

ARG="${1:?usage: $0 <new-version | patch | minor | major>}"

CURRENT=$(jq -r .version package.json)
case "$ARG" in
  patch|minor|major)
    NEW=$(node -e "
      const v='${CURRENT}'.split('.').map(Number);
      const k='$ARG';
      if(k==='major'){v[0]++;v[1]=0;v[2]=0;}
      else if(k==='minor'){v[1]++;v[2]=0;}
      else{v[2]++;}
      console.log(v.join('.'));
    ")
    ;;
  *)
    NEW="$ARG"
    ;;
esac

echo "==> releasing ${CURRENT} -> ${NEW}"

# Refuse to release on a dirty tree.
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree not clean. Commit or stash first." >&2
  exit 1
fi

# 1. Bump version (no-op if it already matches — covers first releases
#    where package.json was edited manually).
if [ "$NEW" != "$CURRENT" ]; then
  tmp=$(mktemp)
  jq --arg v "$NEW" '.version = $v' package.json > "$tmp" && mv "$tmp" package.json
  git add package.json
  git commit -m "Release ${NEW}"
else
  echo "    package.json already at ${NEW}; skipping bump commit"
fi

# 2. Tag + push to source repo
git tag "v${NEW}"
if [ -z "${SKIP_PUSH:-}" ]; then
  git push origin HEAD
  git push origin "v${NEW}"
else
  echo "(SKIP_PUSH=1) tag created locally; skipping push"
fi

# 3. Wait for GH Actions on the source repo
if [ -z "${SKIP_WAIT:-}" ] && [ -z "${SKIP_PUSH:-}" ]; then
  echo "==> waiting for release workflow to finish…"
  sleep 5
  # `gh run watch` requires a run id; we look up the most recent one for
  # this tag.
  for _ in 1 2 3 4 5; do
    RUN_ID=$(gh run list --workflow=release.yml --limit 5 \
      --json databaseId,headBranch \
      --jq ".[] | select(.headBranch==\"v${NEW}\") | .databaseId" | head -1)
    [ -n "$RUN_ID" ] && break
    sleep 5
  done
  if [ -z "${RUN_ID:-}" ]; then
    echo "Could not find a workflow run for v${NEW}. Check the Actions tab." >&2
    exit 1
  fi
  gh run watch "$RUN_ID" --exit-status --interval 15 || {
    echo "Release workflow failed — fix it before continuing." >&2
    exit 1
  }
fi

# 4. Update the tap (pulls sha256s from the release, pushes formula, verifies)
scripts/update-formula.sh "${NEW}"

echo
echo "✓ Released v${NEW}"
echo "  Users can now: brew update && brew upgrade stash"
