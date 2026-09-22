# Shared by the host-side scripts: the Tart binary and the VM's name.
TART="${TART:-$(command -v tart || echo "$HOME/.local/bin/tart")}"
VM="${VM:-clave-linux}"
