#!/bin/bash
set -euo pipefail

if [ -z "${OPENCLAW_VERSION:-}" ]; then
  echo "ERROR: OPENCLAW_VERSION env var is required but not set."
  exit 1
fi

# Minimum OpenClaw version this template is verified against. If a deployment
# requests an older version (e.g. an OPENCLAW_VERSION left over from a previous
# deploy), bump it up to keep the wrapper compatible. Newer versions are left
# exactly as the user requested. Versions are CalVer (YYYY.M.PATCH); `sort -V`
# does the version comparison.
MINIMUM_OPENCLAW_VERSION="2026.10.4"
OPENCLAW_REQUESTED_VERSION="$OPENCLAW_VERSION"
OPENCLAW_VERSION_BUMPED="false"

LOWEST_VERSION="$(printf '%s\n%s\n' "$OPENCLAW_VERSION" "$MINIMUM_OPENCLAW_VERSION" | sort -V | head -n1)"
if [ "$OPENCLAW_VERSION" != "$MINIMUM_OPENCLAW_VERSION" ] && [ "$LOWEST_VERSION" = "$OPENCLAW_VERSION" ]; then
  echo "OPENCLAW_VERSION=${OPENCLAW_VERSION} is older than the minimum supported ${MINIMUM_OPENCLAW_VERSION}; bumping to ${MINIMUM_OPENCLAW_VERSION}."
  OPENCLAW_VERSION="$MINIMUM_OPENCLAW_VERSION"
  OPENCLAW_VERSION_BUMPED="true"
fi

# Surface requested vs effective version to the wrapper (shown in the setup UI).
export OPENCLAW_VERSION
export OPENCLAW_REQUESTED_VERSION
export OPENCLAW_MINIMUM_VERSION="$MINIMUM_OPENCLAW_VERSION"
export OPENCLAW_VERSION_BUMPED

INSTALLED=$(node -e "try{console.log(require('/usr/local/lib/node_modules/openclaw/package.json').version)}catch(e){console.log('')}" 2>/dev/null)
if [ "$INSTALLED" != "$OPENCLAW_VERSION" ]; then
  echo "Installing openclaw@${OPENCLAW_VERSION} (currently: ${INSTALLED:-none})..."
  npm install -g --engine-strict "openclaw@${OPENCLAW_VERSION}"
else
  echo "openclaw@${OPENCLAW_VERSION} already installed, skipping."
fi

OPENCLAW_EFFECTIVE_VERSION=$(node -e "console.log(require('/usr/local/lib/node_modules/openclaw/package.json').version)")
export OPENCLAW_EFFECTIVE_VERSION

chown -R openclaw:openclaw /data
chmod 700 /data

if [ ! -d /data/.linuxbrew ]; then
  cp -a /home/linuxbrew/.linuxbrew /data/.linuxbrew
fi

if [ ! -L /home/linuxbrew/.linuxbrew ]; then
  rm -rf /home/linuxbrew/.linuxbrew
fi
ln -sfn /data/.linuxbrew /home/linuxbrew/.linuxbrew

exec gosu openclaw node src/server.js
