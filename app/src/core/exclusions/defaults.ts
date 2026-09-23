/** Always applied, matched on the EXACT app name. Not shown to the user and not removable. */
export const BUILT_IN_EXCLUSIONS = [
  "loginwindow", "ScreenSaverEngine", "LockApp", "LogonUI",
  "Dock", "SystemUIServer", "Control Center", "Notification Center", "Spotlight", "WindowManager",
  // Windows, as its reader names them (each program's own description, measured on Windows 11): the
  // sign-in screen, the Start menu, Search, the notification and quick-settings flyouts, the touch
  // keyboard and emoji panel, the administrator prompt and the Windows credential prompt. The
  // desktop, taskbar and task switcher never get this far: the reader does not report them at all.
  "Windows Logon User Interface Host", "Windows Start Experience Host", "SearchHost",
  "Windows Shell Experience Host", "ShellHost", "TextInputHost",
  "Consent UI for administrative applications", "Credential Manager UI Host",
  "Clave Agent"
];

/** Seeded on first run. The user can edit this list. Slack, Teams and Discord are work tools and are read. */
export const DEFAULT_EXCLUSIONS = [
  "1Password::", "Bitwarden::", "LastPass::", "Dashlane::", "KeePassXC::", "Keychain Access::", "Passwords::",
  // Windows: classic KeePass, and Windows' own password store (opened in a Control Panel window).
  "KeePass::", "::Credential Manager",
  "Telegram::", "WhatsApp::", "Messages::", "Signal::",
  // Windows: Phone Link shows the phone's text messages, as Messages does on macOS.
  "Phone Link::",
  "::online banking", "::internet banking", "::bank account", "::net banking"
];

export const DEFAULT_EXCLUDED_SITES = [
  "paypal.com", "wise.com", "revolut.com", "chase", "wellsfargo", "bankofamerica", "citi.com",
  "nubank.com.br", "itau.com.br", "bradesco", "santander", "accounts.google.com", "appleid.apple.com"
];

/**
 * Every browser we know of, matched as a NAME PREFIX on a word boundary (see `isBrowser`): an entry
 * matches the app name itself and any name that continues with a space, so one entry covers the
 * whole family — "Google Chrome Canary", "Brave Browser Beta", "Microsoft Edge Dev", "Firefox
 * Developer Edition", "Opera GX". The boundary is what keeps "Archive Utility" out of "arc",
 * "Operator" out of "opera" and "Minecraft" out of "min".
 */
export const BROWSERS = [
  "google chrome", "chrome", "chromium", "safari", "firefox", "microsoft edge", "brave browser",
  "arc", "opera", "vivaldi", "zen",
  "orion", "duckduckgo", "tor browser", "helium", "sigmaos", "librewolf", "waterfox", "floorp",
  "thorium", "yandex", "whale", "min"
];

/**
 * The browsers whose toolbar strip the reader can find: the height of the strip was measured for
 * these two and for no others (phase 0, P5), and it cannot be derived from the window. Private
 * windows and excluded sites are recognised from that strip, so a browser without one is not read at
 * all — unknown means no. A browser joins this list only together with a measured band in the
 * reader (`app/native/reader/src/toolbar.rs`), never on its own.
 *
 * Keyed by name, and measured per BUNDLE ID, because a band belongs to one browser on one system:
 * "Google Chrome" is measured on macOS (`com.google.Chrome`) and on Windows (`chrome.exe`), and
 * "Microsoft Edge" only on Windows. The ids are exactly the keys of the reader's band table.
 *
 * `chrome.exe` is read only in English. Its badge is matched as the English word "Incognito", so the
 * Windows reader marks a Chrome it cannot show to be English as `bandWithheld`
 * (`app/native/reader/src/win/chrome.rs`), and `before` refuses that window before it is captured.
 *
 * `null` stands for a window that names no bundle id, which only the stand-in reader sends. The two
 * names that were read by name alone before bundle ids mattered keep that; a name measured since is
 * read only with its id, because without one nothing says which system's browser it is.
 */
export const MEASURED_BROWSERS: Readonly<Record<string, readonly (string | null)[]>> = {
  "google chrome": ["com.google.Chrome", null, "chrome.exe"],
  "safari": ["com.apple.Safari", null],
  "microsoft edge": ["msedge.exe"]
};
