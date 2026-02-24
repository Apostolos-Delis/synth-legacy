#!/usr/bin/env bash
set -euo pipefail

REPO="Apostolos-Delis/synth"
INSTALL_DIR="${SYNTH_INSTALL_DIR:-$HOME/.local/bin}"

info() { printf '\033[1;34m%s\033[0m\n' "$*"; }
error() { printf '\033[1;31merror: %s\033[0m\n' "$*" >&2; exit 1; }

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *)      error "Unsupported OS: $OS" ;;
esac

case "$ARCH" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *)             error "Unsupported architecture: $ARCH" ;;
esac

BINARY="synth-${os}-${arch}"

info "Detected platform: ${os}-${arch}"

# Fetch latest release tag
TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
[ -n "$TAG" ] || error "Could not determine latest release"

info "Latest release: $TAG"

URL="https://github.com/${REPO}/releases/download/${TAG}/${BINARY}.gz"

info "Downloading ${BINARY}.gz..."
curl -fsSL -o /tmp/synth.gz "$URL" || error "Download failed — check that a release exists for ${os}-${arch}"

gunzip -f /tmp/synth.gz

mkdir -p "$INSTALL_DIR"
mv /tmp/synth "${INSTALL_DIR}/synth"
chmod +x "${INSTALL_DIR}/synth"

info "Installed synth to ${INSTALL_DIR}/synth"

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  echo ""
  info "Add ${INSTALL_DIR} to your PATH:"
  echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
fi
