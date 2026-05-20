#!/usr/bin/env bash
# Install stash into a directory on $PATH.
#
# Usage:
#   ./install.sh                # symlinks to ~/.local/bin/stash (default)
#   PREFIX=/opt/homebrew ./install.sh   # symlinks to $PREFIX/bin/stash
#
# Re-runs are safe; an existing symlink is replaced.

set -euo pipefail

ROOT="$( cd -P "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
TARGET_BIN="${ROOT}/bin/stash"

pick_install_dir() {
  # Honor PREFIX if explicitly set.
  if [ -n "${PREFIX:-}" ]; then
    echo "${PREFIX}/bin"
    return
  fi
  # Prefer a dir that's already on $PATH and writable.
  case ":$PATH:" in
    *":$HOME/.local/bin:"*)
      if [ -w "$HOME/.local/bin" ] || mkdir -p "$HOME/.local/bin" 2>/dev/null; then
        echo "$HOME/.local/bin"; return
      fi
      ;;
  esac
  for dir in /opt/homebrew/bin /usr/local/bin; do
    case ":$PATH:" in *":$dir:"*) ;; *) continue;; esac
    if [ -w "$dir" ]; then echo "$dir"; return; fi
  done
  echo "$HOME/.local/bin"
}

INSTALL_DIR="$(pick_install_dir)"
INSTALL_PATH="${INSTALL_DIR}/stash"

if ! command -v bun >/dev/null 2>&1; then
  cat >&2 <<EOF
stash needs Bun. Install it with one of:

  brew install oven-sh/bun/bun
  curl -fsSL https://bun.sh/install | bash

…then re-run ./install.sh.
EOF
  exit 1
fi

mkdir -p "$INSTALL_DIR"

if [ ! -d "$ROOT/node_modules" ]; then
  echo "→ installing JS deps with bun…"
  ( cd "$ROOT" && bun install )
fi

if [ -L "$INSTALL_PATH" ] || [ -e "$INSTALL_PATH" ]; then
  rm -f "$INSTALL_PATH"
fi
ln -s "$TARGET_BIN" "$INSTALL_PATH"

echo "✓ installed: $INSTALL_PATH → $TARGET_BIN"

# Friendly PATH check.
case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    ;;
  *)
    echo
    echo "ℹ $INSTALL_DIR is not on your PATH. Add it to your shell rc, e.g.:"
    echo "    echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc"
    ;;
esac

echo
echo "Run \`stash --help\` to get started."
