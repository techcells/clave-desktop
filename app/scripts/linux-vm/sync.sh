#!/usr/bin/env bash
# Copies this checkout into the Linux VM at ~/clave, for building and testing there.
#
# What is copied is what git would see: tracked files plus untracked ones that are not ignored, so
# node_modules, out, dist, target and docs/ never travel. The VM keeps its own node_modules and
# target, because the Mac's hold Mac binaries. Files removed here since the last sync are removed
# there too, using the manifest the previous sync left behind.
set -euo pipefail
TART="${TART:-$(command -v tart || echo "$HOME/.local/bin/tart")}"
VM="${VM:-clave-linux}"
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

manifest="$(mktemp)"
trap 'rm -f "$manifest"' EXIT
git -C "$root" ls-files -co --exclude-standard | while IFS= read -r path; do
  [[ -f "$root/$path" ]] && printf '%s\n' "$path"
done > "$manifest"

COPYFILE_DISABLE=1 tar --no-xattrs -C "$root" -cz -T "$manifest" \
  | "$TART" exec -i "$VM" bash -c 'mkdir -p ~/clave && tar -xzmf - -C ~/clave'
"$TART" exec -i "$VM" bash -c 'set -euo pipefail
  cd ~/clave
  sort > /tmp/clave-sync-new
  if [[ -f .sync-manifest ]]; then
    comm -23 <(sort .sync-manifest) /tmp/clave-sync-new | while IFS= read -r gone; do rm -f -- "$gone"; done
  fi
  mv /tmp/clave-sync-new .sync-manifest
  echo "synced $(wc -l < .sync-manifest) files to ~/clave"' < "$manifest"
