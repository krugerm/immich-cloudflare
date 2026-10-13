#!/usr/bin/env bash
# Builds the Immich web app at the pinned commit into ./public. Runs outside the repo's src tree.
set -euo pipefail
COMMIT=cc7fd671973085baf2a0dfba4e2b0a86cab17e6c
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/immich-web-build"
rm -rf "$WORK" && git clone --filter=blob:none https://github.com/immich-app/immich "$WORK"
git -C "$WORK" checkout "$COMMIT"
cd "$WORK"
# the clone pins its Node version in .nvmrc; use an nvm install of it when present
NVMRC_VER="$(tr -d 'v\n' < .nvmrc)"
CURRENT_VER="$(node -p 'process.versions.node')"
if [ "$CURRENT_VER" != "$NVMRC_VER" ]; then
  if [ -x "$HOME/.nvm/versions/node/v$NVMRC_VER/bin/node" ]; then
    export PATH="$HOME/.nvm/versions/node/v$NVMRC_VER/bin:$PATH"
  else
    echo "build-web: the pinned Immich commit needs Node $NVMRC_VER (.nvmrc), found $CURRENT_VER, and no nvm install of it at ~/.nvm/versions/node/v$NVMRC_VER. Install it (nvm install $NVMRC_VER) and re-run." >&2
    exit 1
  fi
fi
# corepack shims go to a user-writable dir so no sudo is needed
mkdir -p "$WORK/.bin"
corepack enable --install-directory "$WORK/.bin"
export PATH="$WORK/.bin:$PATH"
pnpm install --frozen-lockfile --filter immich-web...
# web imports the workspace SDK from its build output
pnpm --filter @immich/sdk build
pnpm --filter immich-web build
rm -rf "$ROOT/public" && cp -R "$WORK/web/build" "$ROOT/public"
echo "web app copied to $ROOT/public"
