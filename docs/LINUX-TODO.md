# Linux version: what is left

State as of 2026-09-24, branch `linux-support` (PR techcells/clave-desktop#5). Tick items off here as they
land, and add new ones with the same three parts: why, where, done when.

**Works today:**
- The reader finds the focused window through the app's own GNOME extension, captures it through GNOME's
  screen sharing (PipeWire), and reads it with Tesseract (the fast Portuguese model, which reads English too).
- The app installs the extension during set-up, with its own blockers and wording for Linux.
- `stage → bundle → sign (fuses only) → artefacts` makes a .deb (with an AppArmor profile so Electron's
  sandbox stays on) and an .rpm; CI builds both for x64 and arm64. The arm64 .deb has been installed in the
  Ubuntu 24.04 VM and started with the sandbox on; the .rpm installs in a Fedora 44 container.
- Measured in the VM: the model's self-test and release gate pass on the CPU; with a 2.5 s Linux read budget,
  a 10-minute session had no read run out of time.

Each item says why it matters, where to look, and when it counts as done.

## 1. Bugs

- [ ] **The window does not open when the app is started.**
  - Seen 2026-09-23 in the Ubuntu 24.04 VM (GNOME 46, Wayland) with the installed internal package:
    starting "Clave Agent Internal" from the app grid started the app (tray icon, 7 processes) but no
    window appeared; starting it again while it ran did not bring a window up either. The window opened
    only from the tray menu (Settings), after which it worked normally.
  - Why: a user who starts the app sees nothing happen, and a second start does nothing, so set-up looks
    broken. On macOS the same code shows the window.
  - Where: `app/src/shell/app.ts`: `showWindow()` (creates the window with `show: false` and shows it on
    `ready-to-show`), the `showWindow()` call at the end of start-up, and the `second-instance` handler.
    Suspects, not confirmed: GNOME's focus-stealing prevention (a window shown without an activation token
    from the launch is not raised, and GNOME may only post "is ready"), `ready-to-show` not firing on
    Wayland for a window created hidden, or the window being shown and immediately hidden by the
    tray/no-tray logic.
  - Done when: starting the app from the app grid opens its window in front, and starting it again while
    it runs brings the window forward; checked on Wayland and on Xorg.

- [ ] **Stopping the app left a crash report.**
  - Seen 2026-09-23 17:33:55 in the VM: `/var/crash/_opt_Clave Agent Internal_clave-agent-internal.1000.crash`,
    signal 5 (SIGTRAP), written when the installed app was stopped with SIGTERM during the packaging test.
    Ubuntu's "System program problem detected" dialog shows such reports to the user later.
  - Why: a normal stop (logging out, shutting down, `kill`) should not look like a crash.
  - Where: how the app handles SIGTERM on Linux (`app/src/shell/app.ts` quit path; Electron exits through
    a CHECK when some teardown fails).
  - Done when: stopping the installed app with SIGTERM, and logging out while it runs, leave no crash report.

## 2. Verify (no new code expected)

- [ ] **Read time on a real x64 laptop.** The VM runs on an M2, faster per core than most x64 laptops. With
  the 2.5 s budget the slowest read in the VM took 1.93 s. Where: `READ_BUDGET_MS_LINUX` in
  `app/src/main/constants.ts`; the probe `app/reader-eval/linux/wayland/l5_session.py`. Done when: a
  10-minute session on an x64 laptop has (almost) no read run out of time, or the budget is revisited.
- [ ] **A Fedora desktop run.** The .rpm has only been installed in a Fedora 44 container, never run on a Fedora
  GNOME desktop. Done when: installed and started on Fedora, the sandbox on, a read works.
- [ ] **The publish job.** `.github/workflows/release.yml` `publish` has not run yet: it only runs on a pushed
  tag. Done when: the first tag publishes the DMG, the Windows installer, the x64 .deb and .rpm and one
  SHA256SUMS.

## 3. Notes

- In the VM, GNOME's Share dialog crashes `xdg-desktop-portal-gnome` (no GPU: EGL/zink errors), so the first
  share often needs a second try, and Ubuntu then shows crash reports for it. A real machine with a GPU is
  not expected to do this. Measurement probes reuse a saved restore token (`~/.clave-cast-token`) instead.
- Measurements and decisions: `docs/superpowers/reviews/2026-09-23-linux-measurements.md` and the Linux plan's
  ledger (both kept internally).
