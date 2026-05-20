class Stash < Formula
  desc "Interactive launcher that resumes claude / codex / opencode sessions"
  homepage "https://github.com/SectorOPS/Stash"
  version "0.2.1"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/SectorOPS/Stash/releases/download/v0.2.1/stash-0.2.1-darwin-arm64.tar.gz"
      sha256 "16ce6e272b443c1194fd458417939d4a30f987fc422031ea8322d767d13a5fbb"
    end
    on_intel do
      url "https://github.com/SectorOPS/Stash/releases/download/v0.2.1/stash-0.2.1-darwin-x64.tar.gz"
      sha256 "3dda119ce4aab31bf66a6e8fd084718495c2fd93173554f44ffcea2b2fdbbaf0"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/SectorOPS/Stash/releases/download/v0.2.1/stash-0.2.1-linux-arm64.tar.gz"
      sha256 "67b1631e82e1d488cc5d5cb8828f3bdf2bf01bec6dae9d5c37ff175d1f99e90e"
    end
    on_intel do
      url "https://github.com/SectorOPS/Stash/releases/download/v0.2.1/stash-0.2.1-linux-x64.tar.gz"
      sha256 "f7cadcc284d1552c8927e07c4a944cc3b654218c1d961325a5540bbf529c73b1"
    end
  end

  def install
    bin.install "stash"
  end

  test do
    assert_match "stash #{version}", shell_output("#{bin}/stash --version")
  end
end
