#!/bin/sh
# Manual testing trigger. This script is intentionally not installed as a service.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# Codex's terminal runs inside Flatpak, while the desktop browser and the
# websockets package live on the laptop host. Cross that boundary explicitly.
if [ -f /.flatpak-info ] && command -v flatpak-spawn >/dev/null 2>&1; then
    exec flatpak-spawn --host python3 "$SCRIPT_DIR/watch_orange_pi_events.py" "$@"
fi

exec python3 "$SCRIPT_DIR/watch_orange_pi_events.py" "$@"
