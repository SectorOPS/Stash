# Publishing stash to Homebrew

End-user goal:

```bash
brew install SectorOPS/Stash/stash
```

(or `brew tap SectorOPS/Stash && brew install stash`)

This doc is the one-time setup + the per-release recipe.

---

## One-time setup

The canonical repo is `github.com/SectorOPS/homebrew-Stash` — the
`homebrew-` prefix is Homebrew's tap-naming convention, and it lets users
run `brew tap SectorOPS/Stash` without passing an explicit URL.
`github.com/SectorOPS/Stash` is kept as a GitHub-managed redirect so old
links still resolve. Source code + `Formula/stash.rb` live in the same
repo (the simplest possible tap layout).

End-user install:

```bash
brew install SectorOPS/Stash/stash
```

That's it — no separate `brew tap` step needed; brew auto-taps on the
first install. GH Actions builds the per-platform binaries on each
`v*` tag push (`GITHUB_TOKEN` is enough, no extra secrets).

---

## Per-release recipe (one command)

```bash
scripts/release.sh patch     # 0.1.0 -> 0.1.1
scripts/release.sh minor     # 0.1.0 -> 0.2.0
scripts/release.sh major     # 0.1.0 -> 1.0.0
scripts/release.sh 0.5.0     # explicit version
```

That script does the whole flow:

1. Bumps `version` in `package.json`.
2. Commits the bump.
3. Tags `vX.Y.Z` and pushes both the commit and the tag.
4. Waits for `.github/workflows/release.yml` to finish — it builds four
   binaries (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`) and
   attaches `*.tar.gz` + `*.sha256` to the GitHub release.
5. Pulls the freshly-published sha256 sidecars via `gh release download`.
6. Rewrites `Formula/stash.rb` with the new urls + sha256s.
7. Commits + pushes the formula update.

End users then do:

```bash
brew update         # refresh the tap
brew upgrade stash  # pull the new version
```

…and they're on the latest.

Requirements on the release host: `bun` (only if not using CI), `gh` CLI
authenticated with push rights to the repo, `jq`, `node`, `git`.

## What `brew upgrade stash` actually does

Once the tap repo is published with a fresh `Formula/stash.rb` on `main`,
Homebrew compares the user's installed version to the `version "X.Y.Z"` field
in the formula. If the formula is newer:

1. `brew update` fetches the latest commit in `SectorOPS/Stash` (the tap).
2. `brew upgrade stash` sees the version bumped, downloads the platform's
   tarball from the GH release, checks the sha256, and installs into
   `$(brew --prefix)/Cellar/stash/X.Y.Z/`, symlinking `bin/stash`.

The old version is kept until you `brew cleanup`. Users can pin a version with
`brew pin stash` if they don't want auto-updates.

## Per-release recipe (manual)

If you want finer control or CI is down:

```bash
# 1. Bump version in package.json by hand.
$EDITOR package.json
git commit -am "Release 0.2.0"
git tag v0.2.0
git push origin main --tags

# 2. Wait for GH Actions, OR build locally:
scripts/build-release.sh

# 3. Sync the formula. With SKIP_PUSH=1 first if you want to inspect.
scripts/update-formula.sh 0.2.0
git commit -am "Formula: bump to 0.2.0"
git push
```

---

## Per-release recipe (manual, no CI)

If you'd rather build locally and skip GitHub Actions:

```bash
# Requires bun installed locally.
scripts/build-release.sh                # writes dist/stash-*.tar.gz + .sha256

# Create the GitHub release with all four tarballs attached.
gh release create v$(jq -r .version package.json) \
  dist/stash-*.tar.gz dist/stash-*.tar.gz.sha256

# Now point the formula at them.
scripts/update-formula.sh $(jq -r .version package.json)
git commit -am "Formula: bump"
git push
```

`bun build --compile --target=bun-darwin-arm64` will cross-compile from any
host with bun installed, so a single Apple Silicon Mac can produce all four
binaries.

---

## Source-only fallback formula

If you don't want to ship binaries at all and would rather have the formula
build from source on the user's machine, replace `Formula/stash.rb` with:

```ruby
class Stash < Formula
  desc "Interactive launcher that resumes claude / codex / opencode sessions"
  homepage "https://github.com/SectorOPS/Stash"
  url "https://github.com/SectorOPS/Stash/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "REPLACE_ME_SOURCE_TARBALL_SHA"
  license "MIT"

  depends_on "oven-sh/bun/bun" => :build

  def install
    system "bun", "install", "--frozen-lockfile"
    system "bun", "build", "src/index.ts",
           "--compile", "--outfile", "stash"
    bin.install "stash"
  end

  test do
    assert_match "stash #{version}", shell_output("#{bin}/stash --version")
  end
end
```

Pros: no per-platform CI, one tarball. Cons: every user pays the bun install +
build cost, and the formula carries a `:build` dep on bun.

---

## Testing the formula locally before publishing

```bash
# Audit (catches most style mistakes before users hit them).
brew audit --strict --new --formula Formula/stash.rb

# Install straight from the local file.
brew install --build-from-source ./Formula/stash.rb

# Smoke test.
stash --version
stash --help
brew test stash

# Tear down.
brew uninstall stash
```

---

## Once it's live

Stick this in the top of the project's README, replacing the current install
section:

````md
## Install

```bash
brew tap SectorOPS/Stash
brew install stash
```

Or one-liner:

```bash
brew install SectorOPS/Stash/stash
```
````
