#!/usr/bin/env bash
#
# Install OpenFit's toolchain on Ubuntu 26.04:
#   - Node.js 22 + corepack (provisions npm@10.9.8 from package.json "packageManager")
#   - Google Cloud CLI (gcloud) from Google's official apt repo
#
# Usage:  sudo bash install-openfit-deps.sh
#
set -euo pipefail

KEYRING=/usr/share/keyrings/cloud.google.gpg
SOURCES=/etc/apt/sources.list.d/google-cloud-sdk.list

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "This script needs root. Re-run as: sudo bash $0" >&2
  exit 1
fi

log "Refreshing apt package lists"
apt-get update

log "Installing Node.js 22 and prerequisites"
apt-get install -y nodejs apt-transport-https ca-certificates gnupg curl

log "Enabling corepack (provides npm >=10 per package.json packageManager)"
corepack enable

if [[ -f "$KEYRING" ]]; then
  log "Google Cloud apt key already present, skipping"
else
  log "Adding Google Cloud apt signing key"
  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o "$KEYRING"
fi

if [[ -f "$SOURCES" ]]; then
  log "Google Cloud apt source already present, skipping"
else
  log "Adding Google Cloud apt source"
  echo "deb [signed-by=$KEYRING] https://packages.cloud.google.com/apt cloud-sdk main" > "$SOURCES"
fi

log "Installing google-cloud-cli"
apt-get update
apt-get install -y google-cloud-cli

log "Verifying installation"
printf 'node    : %s\n' "$(node --version)"
printf 'npm     : %s\n' "$(npm --version 2>/dev/null || echo 'run inside the repo so corepack can resolve it')"
printf 'gcloud  : %s\n' "$(gcloud --version | head -1)"

log "Done. Next: gcloud auth login"
