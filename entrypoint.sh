#!/bin/bash
set -euo pipefail

# The checked-out branch owns the release. Railway variables are never version
# selectors, including values retained from an older deployment.
APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OPENCLAW_VERSION="$(node -p 'require(process.argv[1]).openclawVersion' "$APP_DIR/package.json")"
if [[ ! "$OPENCLAW_VERSION" =~ ^[0-9]{4}\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: package.json must pin an exact OpenClaw release in openclawVersion."
  exit 1
fi
export OPENCLAW_VERSION
export OPENCLAW_NO_AUTO_UPDATE=1
unset OPENCLAW_REQUESTED_VERSION OPENCLAW_MINIMUM_VERSION OPENCLAW_VERSION_BUMPED OPENCLAW_EFFECTIVE_VERSION
echo "Using branch-pinned openclaw@${OPENCLAW_VERSION}; Railway version overrides are ignored."

INSTALLED=$(node -e "try{console.log(require('/usr/local/lib/node_modules/openclaw/package.json').version)}catch(e){console.log('')}" 2>/dev/null)
if [ "$INSTALLED" != "$OPENCLAW_VERSION" ]; then
  echo "Installing openclaw@${OPENCLAW_VERSION} (currently: ${INSTALLED:-none})..."
  npm install -g openclaw@${OPENCLAW_VERSION}
else
  echo "openclaw@${OPENCLAW_VERSION} already installed, skipping."
fi

OPENCLAW_EFFECTIVE_VERSION=$(node -e "console.log(require('/usr/local/lib/node_modules/openclaw/package.json').version)")
if [ "$OPENCLAW_EFFECTIVE_VERSION" != "$OPENCLAW_VERSION" ]; then
  echo "ERROR: installed OpenClaw does not match this branch's pinned release."
  exit 1
fi
export OPENCLAW_EFFECTIVE_VERSION

chown -R openclaw:openclaw /data
chmod 700 /data

if [ ! -d /data/.linuxbrew ]; then
  cp -a /home/linuxbrew/.linuxbrew /data/.linuxbrew
fi

rm -rf /home/linuxbrew/.linuxbrew
ln -sfn /data/.linuxbrew /home/linuxbrew/.linuxbrew

exec gosu openclaw node src/server.js
