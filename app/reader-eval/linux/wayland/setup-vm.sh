#!/usr/bin/env bash
# Builds the test VM: Ubuntu 24.04 (arm64) from Cirrus Labs, a minimal GNOME desktop logging in
# automatically on Wayland, the probes in ~/probe and the focus extension enabled. About 7 GB of
# downloads and 20 GB of (sparse) disk. Needs Tart: https://github.com/cirruslabs/tart/releases
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/tart.sh"
guest() { "$TART" exec "$VM" sh -c "$1"; }

"$TART" clone ghcr.io/cirruslabs/ubuntu:24.04 "$VM"
"$TART" set "$VM" --display 1440x900 --memory 6144
nohup "$TART" run "$VM" >/dev/null 2>&1 &
until "$TART" exec "$VM" true 2>/dev/null; do sleep 3; done

guest 'sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  ubuntu-desktop-minimal gnome-terminal x11-utils xterm python3-gi python3-pil gir1.2-atspi-2.0 \
  gstreamer1.0-pipewire gstreamer1.0-plugins-good gstreamer1.0-tools tesseract-ocr >/dev/null'
guest 'printf "[daemon]\nAutomaticLoginEnable=true\nAutomaticLogin=admin\nWaylandEnable=true\n" | sudo tee /etc/gdm3/custom.conf >/dev/null
  sudo systemctl set-default graphical.target
  mkdir -p ~/probe ~/.config ~/.local/share/gnome-shell/extensions/focus@clave.test
  echo yes > ~/.config/gnome-initial-setup-done'
COPYFILE_DISABLE=1 tar --no-xattrs -C "$here" -cz focus.py shot.py cast.py pipeline.py | "$TART" exec -i "$VM" sh -c 'tar -xz -C ~/probe'
COPYFILE_DISABLE=1 tar --no-xattrs -C "$here/extension" -cz metadata.json extension.js \
  | "$TART" exec -i "$VM" sh -c 'tar -xz -C ~/.local/share/gnome-shell/extensions/focus@clave.test'
# Written to the user's dconf database before the first login, so the session starts with the
# extension on, no screen lock, and the accessibility bus enabled (focus.py asks it too).
guest "dbus-run-session sh -c \"gsettings set org.gnome.shell enabled-extensions \\\"['focus@clave.test']\\\"
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.desktop.session idle-delay 0
  gsettings set org.gnome.desktop.screensaver lock-enabled false
  gsettings set org.gnome.desktop.interface toolkit-accessibility true\" 2>/dev/null"
guest 'sudo reboot' || true
sleep 20
until "$TART" exec "$VM" sh -c 'pgrep -u admin gnome-shell >/dev/null && test -S /run/user/1000/bus' 2>/dev/null; do sleep 3; done
sleep 5
"$here/insession.sh" 'gnome-shell --version; gnome-extensions info focus@clave.test | grep State'
