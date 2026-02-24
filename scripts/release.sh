#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

info()  { printf '\033[1;34m%s\033[0m\n' "$*"; }
error() { printf '\033[1;31merror: %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: scripts/release.sh [patch|minor|major]

Bump version, tag, build platform binaries, and create a GitHub release.
Defaults to minor if no argument is given.
EOF
  exit 0
}

BUMP="${1:-minor}"
case "$BUMP" in
  patch|minor|major) ;;
  -h|--help) usage ;;
  *) error "Unknown bump type: $BUMP (expected patch, minor, or major)" ;;
esac

# Ensure clean working tree
if [ -n "$(git status --porcelain)" ]; then
  error "Working tree is dirty — commit or stash changes first"
fi

command -v gh >/dev/null 2>&1 || error "gh CLI is required (brew install gh)"
command -v bun >/dev/null 2>&1 || error "bun is required"

# Derive current version from the latest git tag (not package.json) so we
# always increment past any existing tag, even if package.json is stale.
LATEST_TAG="$(git tag --list 'v[0-9]*' --sort=-v:refname | head -1)"
if [ -n "$LATEST_TAG" ]; then
  CURRENT="${LATEST_TAG#v}"
else
  CURRENT="$(grep '"version"' package.json | sed -E 's/.*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/')"
fi
[ -n "$CURRENT" ] || error "Could not determine current version from git tags or package.json"

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac

NEXT="${MAJOR}.${MINOR}.${PATCH}"
TAG="v${NEXT}"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  error "Tag $TAG already exists"
fi

info "Bumping $CURRENT → $NEXT ($BUMP)"

# Update version in package.json and src/cli.tsx
sed -i '' -E "s/\"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"/\"version\": \"$NEXT\"/" package.json
sed -i '' -E "s/const VERSION = \"[0-9]+\.[0-9]+\.[0-9]+\"/const VERSION = \"$NEXT\"/" src/cli.tsx

# Commit and tag
git add package.json src/cli.tsx
git commit -m "Release v${NEXT}"
git tag -a "$TAG" -m "v${NEXT}"

info "Tagged $TAG"

# Build host-native binary (cross-compilation requires platform-specific native deps)
HOST_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  arm64|aarch64) HOST_ARCH="arm64" ;;
  x86_64|amd64)  HOST_ARCH="x64" ;;
esac

BINARY="synth-${HOST_OS}-${HOST_ARCH}"
info "Building ${BINARY}..."
bun run "build:${HOST_OS}-${HOST_ARCH}"

info "Compressing ${BINARY}..."
gzip -9 -f "dist/${BINARY}"

info "Pushing tag..."
git push origin HEAD "$TAG"

# Create GitHub release with compressed binary
printf '\033[1;34m%s\033[0m ' "Creating GitHub release..."
gh release create "$TAG" \
  "dist/${BINARY}.gz" \
  --title "v${NEXT}" \
  --generate-notes

info "Attach other platform binaries via CI or manually with:"
info "  gzip -9 dist/synth-<os>-<arch> && gh release upload ${TAG} dist/synth-<os>-<arch>.gz"

info "Released v${NEXT} 🎉"
info "https://github.com/Apostolos-Delis/synth/releases/tag/${TAG}"
