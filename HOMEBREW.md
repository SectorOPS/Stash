# Publishing stash to Homebrew

End-user install:

```bash
brew install SectorOPS/Stash/stash
```

This doc covers the layout, the per-release recipe, and the manual fallbacks.

---

## Repo layout

Two repos, by Homebrew tap convention:

| Repo                                                   | Role                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| `github.com/SectorOPS/Stash`                           | **Source.** Code, issues, releases, CI binaries.              |
| `github.com/SectorOPS/homebrew-Stash`                  | **Tap.** Only `Formula/stash.rb` + a stub README + audit CI.  |

The `homebrew-` prefix on the tap repo is what lets users run
`brew install SectorOPS/Stash/stash` without an explicit `brew tap` step —
Homebrew auto-resolves `SectorOPS/Stash` to `SectorOPS/homebrew-Stash`.

GitHub release artefacts (per-platform binary tarballs + sha256 sidecars)
live on the source repo's releases. The tap's formula just points at those
download URLs.

---

## Per-release recipe (one command)

```bash
scripts/release.sh patch     # 0.2.1 -> 0.2.2
scripts/release.sh minor     # 0.2.1 -> 0.3.0
scripts/release.sh major     # 0.2.1 -> 1.0.0
scripts/release.sh 0.5.0     # explicit version
```

The script does the whole flow:

1. Bumps `version` in `package.json` (no-op if it already matches).
2. Commits + tags `vX.Y.Z` and pushes both to the **source** repo.
3. Waits for `.github/workflows/release.yml` to finish — that builds four
   binaries (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`) and
   attaches the tarballs + sha256 sidecars to the source repo's release.
4. Hands off to `scripts/update-formula.sh`, which:
   - pulls the new sha256 sidecars from the release,
   - clones the **tap** repo into a temp dir,
   - rewrites `Formula/stash.rb` to point at the new urls,
   - pushes back to the tap,
   - **verifies the push landed** by re-reading the formula via the GitHub
     API and asserting the version line matches. This guards against the
     "tagged source release but the tap shows yesterday's version" silent
     failure that's a pain to debug.

End users then run:

```bash
brew update                                # refresh the tap
brew upgrade SectorOPS/Stash/stash         # pull the new version
```

Requirements on the release host: `bun` (only if you build locally instead
of via CI), `gh` CLI authenticated with push rights to *both* repos, `jq`,
`node`, `git`.

---

## What `brew upgrade` actually does

Homebrew compares the user's installed version to the `version "X.Y.Z"`
field in the tap's `Formula/stash.rb`. If the formula is newer:

1. `brew update` fetches the latest commit on the tap's `main` branch.
2. `brew upgrade SectorOPS/Stash/stash` sees the version bumped, downloads
   the platform's tarball from the source repo's release, verifies the
   sha256, and installs into `$(brew --prefix)/Cellar/stash/X.Y.Z/`,
   symlinking `bin/stash` onto `$PATH`.

The old version is kept until `brew cleanup`. Users can `brew pin stash` to
opt out of auto-updates.

---

## Per-release recipe (manual)

If you want finer control or CI is down:

```bash
# 1. Bump version in package.json by hand, then:
git commit -am "Release 0.3.0"
git tag v0.3.0
git push origin main --tags

# 2. Wait for GH Actions on the source repo, OR build locally:
scripts/build-release.sh    # writes dist/stash-*.tar.gz + .sha256

# 3. Sync the formula on the tap repo. The script clones, rewrites, pushes,
#    and verifies; SKIP_PUSH=1 isn't supported here because we always want
#    the tap to stay in sync with what's published.
scripts/update-formula.sh 0.3.0
```

`bun build --compile --target=bun-darwin-arm64` (etc.) cross-compiles from
any host with bun, so a single Apple Silicon Mac can produce all four
binaries via `scripts/build-release.sh`.

---

## Tap-side CI

`SectorOPS/homebrew-Stash/.github/workflows/audit.yml` runs `brew style`
and `brew audit --strict --formula Formula/stash.rb` on every push and PR.
This catches most formula-format mistakes (sha mismatches, deprecated DSL,
missing description) before they land in users' `brew install` output, and
provides a green check on the tap repo that signals "this tap is
maintained" to anyone who pokes around.

---

## Source-only fallback formula

If you'd rather have the formula build from source on the user's machine
instead of shipping binaries, drop this into the tap's `Formula/stash.rb`:

```ruby
class Stash < Formula
  desc "Interactive launcher that resumes claude / codex / opencode sessions"
  homepage "https://github.com/SectorOPS/Stash"
  url "https://github.com/SectorOPS/Stash/archive/refs/tags/v0.3.0.tar.gz"
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

Pros: no per-platform CI, one tarball. Cons: every user pays the bun
install + build cost, and the formula carries a `:build` dep on bun.

---

## Testing the formula locally

Run inside a clone of the tap repo:

```bash
brew style Formula/stash.rb
brew audit --strict --formula Formula/stash.rb

# Install via the tap path (matches what end users do).
brew install SectorOPS/Stash/stash
stash --version
stash --help
brew test SectorOPS/Stash/stash

# Tear down.
brew uninstall stash
brew untap SectorOPS/Stash
```
