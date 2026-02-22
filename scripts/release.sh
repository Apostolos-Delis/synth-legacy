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

# Parse current version from package.json
CURRENT="$(grep '"version"' package.json | sed -E 's/.*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/')"
[ -n "$CURRENT" ] || error "Could not parse version from package.json"

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
sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEXT\"/" package.json
sed -i '' "s/const VERSION = \"$CURRENT\"/const VERSION = \"$NEXT\"/" src/cli.tsx

# Commit and tag
git add package.json src/cli.tsx
git commit -m "Release v${NEXT}"
git tag -a "$TAG" -m "v${NEXT}"

info "Tagged $TAG"

# Build all platform binaries
info "Building binaries..."
bun run build:darwin-arm64
bun run build:darwin-x64
bun run build:linux-arm64
bun run build:linux-x64

info "Pushing tag..."
git push origin HEAD "$TAG"

# Create GitHub release with binaries
info "Creating GitHub release..."
gh release create "$TAG" \
  dist/synth-darwin-arm64 \
  dist/synth-darwin-x64 \
  dist/synth-linux-arm64 \
  dist/synth-linux-x64 \
  --title "v${NEXT}" \
  --generate-notes

info "Released v${NEXT} 🎉"
info "https://github.com/Apostolos-Delis/synth/releases/tag/${TAG}"
