# Clave Agent

A small desktop app that turns the work you do on your computer into evidence on your
Clave profile, without your screen ever leaving your machine.

## What it does

While you have it switched on, the app:

1. Captures the focused window every few seconds and runs the operating system's built-in text
   recognition on it. The image is discarded within seconds; only the recognised text is kept.
2. Keeps that text in memory for at most sixty minutes and groups it into short "scenarios"
   (a stretch of debugging, a design discussion, a support thread).
3. Asks a local language model (Qwen3.5-4B via node-llama-cpp) to write short, verb-first
   statements about what you demonstrated, matched to the public list of Clave skills and
   competencies.
4. Shows you a capped daily digest. You approve or reject each statement. Only approved
   statements are uploaded to your profile.

Excluded apps and sites, private browser windows, and anything that looks like a password, key,
email or card number are filtered out before the model sees anything. A final check discards any
statement that names a person, company, product or figure that was on your screen.

The full list of what is sent, kept and never touched is in [docs/WHAT-LEAVES.md](docs/WHAT-LEAVES.md).
The app works with Wi-Fi off; only the statements you approve ever leave.

## Requirements

- macOS 14 or later, with Screen Recording permission, asked for on first run
- Or Windows 10 version 1903 or later (Windows 11 recommended), 64-bit Intel or AMD, which needs no
  permission. The Windows installer is not code-signed yet.
- Or Linux with GNOME 46, on Wayland or Xorg (tested on Ubuntu 24.04), installed from a .deb (Ubuntu) or
  an .rpm (Fedora). The app installs a small GNOME extension for your account (it takes effect after you
  log out and back in), and GNOME asks once which screen to share. Other desktops (KDE and others) are
  not supported yet.
- About 3 GB of disk for the model, downloaded once during set-up
- A computer fast enough to run the model. During set-up the app times the model on your machine and
  allows it up to four times the normal time limits; a slower machine is told so, and reading
  stays off. A laptop with only integrated graphics may not pass.
- For development: Node.js, pnpm, and a Rust toolchain for the native reader; on Windows, also the
  Visual Studio Build Tools with the C++ workload and a Windows SDK; on Linux, also clang, pkg-config,
  the PipeWire development files, the Tesseract 5 library, and Tesseract's fast Portuguese model
  (`por.traineddata` from `tessdata_fast`; point `CLAVE_TESSDATA` at its folder)

The reader uses each system's own parts: ScreenCaptureKit and Vision on macOS, Windows.Graphics.Capture
and Windows.Media.Ocr on Windows, and on Linux GNOME's screen sharing (through PipeWire) with Tesseract,
reading English and Portuguese. On Windows the recogniser reads the languages whose Windows language
pack is installed, English first.

## Installing on Windows

Each release has a Windows installer (`.exe`), a ZIP of the same app, and `SHA256SUMS`. The installer
is per-user: it needs no administrator rights and installs into
`%LOCALAPPDATA%\Programs\<app name>`, with a Start-menu shortcut. Uninstall it from Settings → Apps;
your data in `%APPDATA%\<app name>` is left in place.

The Windows builds are not code-signed yet, so SmartScreen warns before the first run. Choose
**More info → Run anyway**. On Windows the app reads Microsoft Edge and English-language Google
Chrome; other browsers are refused rather than read. What is still missing on Windows is tracked in
[docs/WINDOWS-TODO.md](docs/WINDOWS-TODO.md).

## Running it

All commands run from the repository root.

```bash
pnpm --dir app install
pnpm --dir app build:native      # builds the Rust reader helper
pnpm --dir app start             # builds the app and starts it with the real model, and stand-ins
                                 # for the Clave backend and the screen reader
```

Useful variants:

```bash
pnpm --dir app start:scripted    # scripted fake model, no download, for UI work
pnpm --dir app start:api         # the real Clave backend (its development deployment), scripted model
pnpm --dir app test              # unit and pipeline tests
pnpm --dir app typecheck
pnpm --dir app test:native       # Rust tests
pnpm --dir app smoke             # end-to-end smoke run, prints SMOKE OK
```

Packaged builds (the `package:*` scripts, or the release workflow in `.github/workflows/release.yml`)
use the real reader, the real model and the production backend. To build an installer, run the
packaging stages in order (`--flavour internal` or `release`):

```bash
pnpm --dir app package:stage -- --flavour internal
pnpm --dir app package:bundle -- --flavour internal
pnpm --dir app package:sign -- --flavour internal
pnpm --dir app package:artefacts -- --flavour internal
```

On Windows this also needs Inno Setup 6. The VC++ runtime DLLs shipped beside the model's native
add-on are copied from the Visual Studio installation. Release-flavour Windows artefacts are refused
until Windows signing is set up. On Linux it makes a .deb and an .rpm and needs nfpm 2.47.0, with
`CLAVE_TESSDATA` pointing at the recognition model's folder for the stage step; Linux builds are not
signed, and the published SHA256SUMS are the integrity check.

## Repository layout

| Path | What it is |
|---|---|
| `app/src/core` | The pipeline: exclusions, secret scrubbing, rolling buffer, scenarios, candidate skills, safety guard, daily digest |
| `app/src/main` | The desktop engine: capture loop, reader and model hosts, review queue, account, settings, storage |
| `app/src/shell`, `app/src/renderer` | Electron entry points, preload and the React UI |
| `app/src/eval`, `app/src/readerEval` | Release gate for the real model and the reader eval harness |
| `app/native/reader` | Rust helper that captures the focused window and recognises text, talking JSON lines over stdio |
| `app/linux/gnome-extension` | The GNOME Shell extension the Linux app installs, which tells the reader which window is in front |
| `app/scripts` | Build, native build, packaging (stage, bundle, sign, artefacts), dev bundle and reader eval scripts |
| `eval/` | Synthetic fixtures for the extraction pipeline; never real screen text |
| `docs/` | The what-leaves page and the Windows and Linux to-do lists (plans, specs and review records are kept internally) |

## Status

Early, pre-release. The core pipeline, the desktop app, the macOS, Windows and Linux readers and the
connection to the Clave backend (sign-in with email or Google, the skills list, and uploading the
statements you approve) are built and tested. The release workflow builds a macOS DMG, a Windows installer
and Linux .deb and .rpm packages. What is left on Windows and Linux is listed in
[docs/WINDOWS-TODO.md](docs/WINDOWS-TODO.md) and [docs/LINUX-TODO.md](docs/LINUX-TODO.md).

## License

Source-available under the [Clave Agent License](LICENSE.md). It's free for personal,
non-commercial, educational and research use, and for a 14-day evaluation at any organization.
Commercial use, embedding the code in a product, hosting it for others, or building a competing
product requires a paid license from TeamEx ([contact@teamex.io](mailto:contact@teamex.io)).
