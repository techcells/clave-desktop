# Wayland capture probes

How can a Linux build find the focused window and capture it on GNOME with Wayland? These probes
run inside an Ubuntu 24.04 GNOME 46 VM and ask every route. They were used on 2026-09-23 to decide
the Linux reader's design.

## Setup (Mac with Apple silicon)

Install Tart from its [GitHub releases](https://github.com/cirruslabs/tart/releases) (the Homebrew
tap formula was broken on 2026-09-23). Then, from this folder:

    ./setup-vm.sh

That clones the VM (`clave-linux`), installs a minimal GNOME desktop logging in automatically on
Wayland, copies the probes to `~/probe` and enables the focus extension. About 7 GB of downloads.
The VM window stays open: the portals show their permission dialogs there.

Run a probe inside the live session with `./insession.sh '<command>'`:

| Command | What it answers |
|---|---|
| `python3 focus.py` | Which window is focused, by every route: X11, GNOME Shell's D-Bus, the accessibility bus, the extension |
| `python3 shot.py 3` | The Screenshot portal: does it ask, how long each shot takes |
| `python3 cast.py /tmp/f.png` | The ScreenCast portal: asks once, then reuses the saved restore token; grabs one frame |
| `python3 pipeline.py` | Focus, screenshot, crop to the window, delete the file, Tesseract on one thread |

Open windows to test against with, for example, `./insession.sh 'xterm &'` (X11) or
`./insession.sh 'gnome-terminal'` (Wayland). Stop the VM with `tart stop clave-linux`.

## Result, 2026-09-23

Finding the focused window and its position:

| Route | Wayland window | X11 window | Position |
|---|---|---|---|
| GNOME Shell `Eval` / `Introspect.GetWindows` | refused | refused | none |
| X11 `_NET_ACTIVE_WINDOW` | nothing | works | yes |
| Accessibility bus (AT-SPI) | title only | title only | always 0,0 |
| The focus extension (`extension/`) | works | works | yes, about 40 ms |

Capture:

- **Screenshot portal**: one Allow dialog, then silent at about 200 ms. But every shot is written
  to `~/Pictures` as a full-screen PNG, and the grant is stored for every unsandboxed app.
- **ScreenCast portal** (monitor, persist mode 2): one Share dialog, then silent with the restore
  token in 100 to 200 ms, including after a reboot. Frames stay in memory (PipeWire). GNOME shows
  a sharing indicator while it runs.

Decision (owner, 2026-09-23): on Wayland the Linux reader captures the whole monitor through the
ScreenCast portal and crops it to the extension's window frame in memory at once. Unknown focus or
position means the frame is dropped.

Tesseract inside the VM took 843 ms on one thread for a 914x577 window. With all threads, one read
under load took 15 s, so the reader must pin `OMP_THREAD_LIMIT=1`.

Not covered: KDE Plasma, Fedora, several monitors, fractional scaling, Firefox private windows, the
experience of installing the extension (it only loads after logging out and in).
