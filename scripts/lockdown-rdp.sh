#!/usr/bin/env bash
#
# Restrict GNOME Remote Desktop (RDP/3389) to the Tailscale interface only.
#
# gnome-remote-desktop binds 0.0.0.0:3389, which exposes it to the local LAN.
# This script allows 3389 only on tailscale0 and denies it everywhere else.
#
# Usage:
#   sudo bash lockdown-rdp.sh          # add rules only (safe; will not enable ufw)
#   sudo bash lockdown-rdp.sh --enable # also enable ufw if it is currently inactive
#
# SAFETY: this box is administered over SSH. The script always permits SSH and
# Tailscale BEFORE enabling ufw, so enabling the firewall cannot lock you out.
#
set -euo pipefail

TSIF=tailscale0
ENABLE=no
[[ "${1:-}" == "--enable" ]] && ENABLE=yes

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Needs root. Re-run as: sudo bash $0 ${1:-}" >&2
  exit 1
fi

command -v ufw >/dev/null || { echo "ufw is not installed." >&2; exit 1; }

if ! ip link show "$TSIF" >/dev/null 2>&1; then
  echo "Interface $TSIF not found. Is Tailscale up?" >&2
  exit 1
fi

log "Current ufw state"
ufw status verbose | head -6
WAS_ACTIVE=$(ufw status | head -1 | grep -qi active && echo yes || echo no)

# --- Keep remote administration alive no matter what -------------------------
log "Permitting SSH and Tailscale (must precede any enable)"
ufw allow 22/tcp comment 'ssh admin'
ufw allow in on "$TSIF" comment 'tailnet trusted'
ufw allow 41641/udp comment 'tailscale wireguard'

# --- RDP: tailnet only -------------------------------------------------------
# Rule order matters in ufw: the interface-scoped allow must be inserted
# before the blanket deny, otherwise the deny wins.
log "Allowing RDP on $TSIF only"
ufw allow in on "$TSIF" to any port 3389 proto tcp comment 'rdp via tailnet'

log "Denying RDP on every other interface"
ufw deny in to any port 3389 proto tcp comment 'rdp blocked off-tailnet'

if [[ "$WAS_ACTIVE" == "no" ]]; then
  if [[ "$ENABLE" == "yes" ]]; then
    log "Enabling ufw (SSH + Tailscale already permitted above)"
    ufw --force enable
  else
    log "ufw is INACTIVE - rules staged but NOT enforced"
    echo "Port 3389 remains reachable from your LAN until you run:"
    echo "    sudo bash $0 --enable"
  fi
else
  log "ufw already active - reloading"
  ufw reload
fi

log "Resulting rules for 3389"
ufw status numbered | grep -E "3389|22/tcp|$TSIF" || true

log "Done"
