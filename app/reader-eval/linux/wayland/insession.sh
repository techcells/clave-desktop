#!/usr/bin/env bash
# Runs a command inside admin's live GNOME session in the VM (session bus, Wayland, and the
# XWayland authority file, so both portals and X11 apps work).
set -euo pipefail
. "$(dirname "$0")/tart.sh"
exec "$TART" exec "$VM" env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
  WAYLAND_DISPLAY=wayland-0 DISPLAY=:0 XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=ubuntu:GNOME \
  sh -c "export XAUTHORITY=\$(ls /run/user/1000/.mutter-Xwaylandauth.* | head -1); cd ~/probe; $*"
